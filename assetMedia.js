// assetMedia.js — POST /api/asset-media, the compute half of the tool's 📁 Assets library
// (the Atria "Assets" model, 2026-10-10). The analyser stays a compute box: NO AI here except
// Whisper. It returns, for one uploaded video or audio file:
//   duration, hasAudio,
//   clips[]   — scene-cut segments (ffmpeg scene score), each with one 512px frame (base64) and
//               its own audio signals: speech (from Whisper segments) and loudness outside speech
//               (an RMS time series) — the "voice-over" and "background music" clip filters,
//   transcript + segments (Whisper, same hallucination filter as /api/clone).
// The tool tags the clips with Claude vision and stores everything; nothing is kept here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { spawn } = require('child_process');
// Env overrides exist for running analyzeFile on a Mac, where ffmpeg-static ships no binary.
const ffmpegStatic = process.env.FFMPEG_BIN || require('ffmpeg-static');
const ffprobeStatic = { path: process.env.FFPROBE_BIN || require('ffprobe-static').path };

const MAX_BYTES = 1100 * 1024 * 1024;   // Atria's 1 GB per file, plus headroom
const MAX_CLIPS = 16;
const MIN_CLIP = 1.0;                   // seconds — shorter cuts merge into the previous clip
const MAX_CLIP = 8.0;                   // a long static shot is split so every clip gets a frame

function run(bin, args, { timeout = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(bin)} timed out`)); }, timeout);
    p.stdout.on('data', (d) => { out += d; if (out.length > 8e6) out = out.slice(-4e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 8e6) err = err.slice(-4e6); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function download(url, file) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 600000, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES });
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file);
    res.data.on('data', (c) => { bytes += c.length; if (bytes > MAX_BYTES) { res.data.destroy(new Error('File larger than 1 GB')); } });
    res.data.on('error', reject);
    ws.on('finish', resolve);
    ws.on('error', reject);
    res.data.pipe(ws);
  });
  return bytes;
}

async function probe(file) {
  const r = await run(ffprobeStatic.path, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { timeout: 60000 });
  const j = JSON.parse(r.out || '{}');
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  return { duration: Number(j.format && j.format.duration) || 0, hasAudio: streams.some((s) => s.codec_type === 'audio'), hasVideo: !!v, width: v ? v.width : null, height: v ? v.height : null };
}

// Scene cuts → clips. The same scene-score filter the clone path uses for cut detection.
async function sceneClips(file, duration) {
  const r = await run(ffmpegStatic, ['-hide_banner', '-i', file, '-an', '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { timeout: 300000 });
  const cuts = [...r.err.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.3 && t < duration - 0.3);
  const edges = [0];
  for (const c of cuts) if (c - edges[edges.length - 1] >= MIN_CLIP) edges.push(c);
  edges.push(duration);
  let clips = [];
  for (let i = 0; i < edges.length - 1; i++) {
    let s = edges[i]; const e = edges[i + 1];
    while (e - s > MAX_CLIP + MIN_CLIP) { clips.push([s, s + MAX_CLIP]); s += MAX_CLIP; }
    clips.push([s, e]);
  }
  clips = clips.filter(([s, e]) => e - s > 0.2);
  // Too many? keep the longest MAX_CLIPS, back in time order.
  if (clips.length > MAX_CLIPS) clips = clips.map((c, i) => ({ c, i })).sort((a, b) => (b.c[1] - b.c[0]) - (a.c[1] - a.c[0])).slice(0, MAX_CLIPS).sort((a, b) => a.i - b.i).map((x) => x.c);
  return { clips, cutCount: cuts.length };
}

async function frameAt(file, t, out) {
  await run(ffmpegStatic, ['-hide_banner', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '4', '-y', out], { timeout: 60000 });
  return fs.existsSync(out) ? fs.readFileSync(out).toString('base64') : '';
}

// RMS loudness every 0.5 s (dBFS). Used with the speech segments to tell "background music"
// (loud where nobody speaks) from a silent clip — a heuristic, labelled as such in the tool.
async function loudness(file) {
  const r = await run(ffmpegStatic, ['-hide_banner', '-i', file, '-vn', '-af', 'aresample=8000,asetnsamples=4000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-'], { timeout: 300000 });
  const pts = [...r.err.matchAll(/pts_time:([0-9.]+)[\s\S]*?RMS_level=(-?[0-9.]+|-inf)/g)].map((m) => ({ t: Number(m[1]), db: m[2] === '-inf' ? -120 : Number(m[2]) }));
  return pts;
}

async function transcribe(file, tmp) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { transcript: '', segments: [], error: 'GROQ_API_KEY not configured' };
  const mp3 = path.join(tmp, 'a.mp3');
  await run(ffmpegStatic, ['-hide_banner', '-i', file, '-vn', '-ac', '1', '-b:a', '64k', '-y', mp3], { timeout: 300000 });
  if (!fs.existsSync(mp3) || fs.statSync(mp3).size < 1000) return { transcript: '', segments: [] };
  if (fs.statSync(mp3).size > 24 * 1024 * 1024) return { transcript: '', segments: [], error: 'Audio longer than Whisper takes in one request' };
  const form = new FormData();
  form.append('file', fs.createReadStream(mp3), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  const r = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, { headers: { Authorization: `Bearer ${key}`, ...form.getHeaders() }, timeout: 120000 });
  // Same hallucination filter as /api/clone: Whisper invents text on music and silence.
  const ok = (s) => (s.no_speech_prob ?? 0) < 0.6 && (s.avg_logprob ?? 0) > -1.0 && (s.compression_ratio ?? 1) < 2.4;
  const segs = (r.data.segments || []).filter(ok).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })).filter((s) => s.text);
  return { transcript: segs.map((s) => s.text).join(' ').trim(), segments: segs, language: r.data.language || '' };
}

function clipAudio(clip, segments, rms) {
  const [s, e] = clip;
  const speech = segments.filter((g) => g.end > s && g.start < e);
  const inSpeech = (t) => speech.some((g) => t >= g.start && t <= g.end);
  const quiet = rms.filter((p) => p.t >= s && p.t < e && !inSpeech(p.t));
  const loudQuiet = quiet.filter((p) => p.db > -38).length;
  return {
    voiceover: speech.length > 0,
    speech: speech.map((g) => g.text).join(' ').slice(0, 600),
    // Music heuristic: most of the non-speech time is clearly above silence.
    music: quiet.length >= 2 ? loudQuiet / quiet.length >= 0.6 : (speech.length ? null : false),
  };
}

function mount(app) {
  app.post('/api/asset-media', async (req, res) => {
    const { url, kind } = req.body || {};
    if (!url || !/^https:\/\//.test(url)) return res.status(400).json({ success: false, error: 'Missing https url' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-'));
    const file = path.join(tmp, 'in');
    const t0 = Date.now();
    try {
      const bytes = await download(url, file);
      const out = await analyzeFile(file, tmp, kind);
      console.log(`[asset-media] ${Math.round(bytes / 1e6)} MB, ${out.duration.toFixed(1)} s, ${out.clips.length} clip(s), ${out.cutCount} cut(s), speech ${out.segments.length} seg, ${Date.now() - t0} ms`);
      res.json({ success: true, bytes, ...out });
    } catch (e) {
      console.error('[asset-media] error', e.message);
      res.status(500).json({ success: false, error: e.message });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });
}

// The whole analysis of a local file — split out so it can be run on a file without a server.
async function analyzeFile(file, tmp, kind) {
      const meta = await probe(file);
      const isAudio = kind === 'audio' || !meta.hasVideo;
      const [tr, rms] = await Promise.all([
        meta.hasAudio ? transcribe(file, tmp).catch((e) => ({ transcript: '', segments: [], error: e.message })) : { transcript: '', segments: [] },
        meta.hasAudio ? loudness(file).catch(() => []) : [],
      ]);
      let clips = [];
      let cutCount = 0;
      if (!isAudio) {
        const sc = await sceneClips(file, meta.duration);
        cutCount = sc.cutCount;
        for (let i = 0; i < sc.clips.length; i++) {
          const [s, e] = sc.clips[i];
          const frame = await frameAt(file, s + Math.min(0.5, (e - s) / 2), path.join(tmp, `c${i}.jpg`)).catch(() => '');
          clips.push({ start: Number(s.toFixed(2)), end: Number(e.toFixed(2)), frame, ...clipAudio(sc.clips[i], tr.segments, rms) });
        }
      } else {
        clips = [{ start: 0, end: Number(meta.duration.toFixed(2)), frame: '', ...clipAudio([0, meta.duration], tr.segments, rms) }];
      }
      return { ...meta, cutCount, clips, transcript: tr.transcript, segments: tr.segments, language: tr.language || '', transcriptError: tr.error || '' };
}

module.exports = { mount, clipAudio, analyzeFile };
