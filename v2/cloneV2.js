// 🧪 RECREATE v2 — analysis route POST /api/clone-v2 (2026-10-04, PRD docs/prds/RECREATE-V2-PRD.md).
//
// Runs NEXT TO /api/clone and shares nothing with its writer: v1 stays byte-identical. It reuses
// only the download helpers (injected from index.js, so they are not copied) and the existing
// hookmotion.py. Order of work, on purpose: MEASURE first (cuts + a flash check, camera timeline,
// hook motion, music beats), then let the writer SEE (timestamped contact sheets, dense hook
// frames, one full-size frame per shot) and fill a JSON spec, then COMPILE the prompt in code.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { execFile, spawn } = require('child_process');
const { writerSystem, validateSpec, parseSpec } = require('./spec');
const { compile } = require('./compile');

const V2_VERSION = 'v2-0.2.0';
const WRITER_MODEL = process.env.V2_WRITER_MODEL || 'claude-sonnet-5';
const FALLBACK_MODEL = 'claude-sonnet-4-6';

function run(bin, args, { timeout = 60000, binary = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin, args);
    const out = [], err = [];
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, timeout);
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err.push(d); if (err.length > 4000) err.splice(0, 2000); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: binary ? Buffer.concat(out) : Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: String(e.message) }); });
  });
}
function py(PYTHON, script, args, timeout) {
  return new Promise((resolve) => execFile(PYTHON, [script, ...args], { timeout }, (e, so) => {
    if (e) return resolve(null);
    try { resolve(JSON.parse(String(so).trim().split('\n').pop())); } catch (_) { resolve(null); }
  }));
}

// A scene-detection "cut" whose frames 0.2 s before and 0.3 s after look the same is a FLASH
// (muzzle flash, camera flash, a white frame), not a cut — LoveRain1997/video-to-h3-prompt verifies
// every candidate cut the same way. Mean absolute difference of 32×32 grey thumbnails, 0-255.
async function grey32(ff, video, t) {
  const r = await run(ff, ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', video, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', 'pipe:1'], { binary: true, timeout: 20000 });
  return r.stdout && r.stdout.length === 1024 ? r.stdout : null;
}
const FLASH_MAD = 14;

async function measureCuts(ff, video, duration) {
  const r = await run(ff, ['-hide_banner', '-i', video, '-an', '-vf', "select='gt(scene,0.2)',showinfo", '-f', 'null', '-'], { timeout: 90000 });
  const raw = [...String(r.stderr).matchAll(/pts_time:([0-9.]+)/g)].map(m => Number(m[1])).filter(t => t > 0.15 && t < duration - 0.15);
  const cand = [];
  for (const t of raw) if (!cand.length || t - cand[cand.length - 1] >= 0.3) cand.push(Math.round(t * 100) / 100);
  const cuts = [], falseCuts = [];
  for (const t of cand) {
    const a = await grey32(ff, video, t - 0.2), b = await grey32(ff, video, t + 0.3);
    if (a && b) {
      let s = 0; for (let i = 0; i < 1024; i++) s += Math.abs(a[i] - b[i]);
      const mad = s / 1024;
      if (mad < FLASH_MAD) { falseCuts.push({ t, mad: Math.round(mad * 10) / 10 }); continue; }
    }
    cuts.push(t);
  }
  return { cuts, falseCuts };
}

async function measureBeats(ff, video, detectBeats, cuts) {
  if (typeof detectBeats !== 'function') return null;
  const r = await run(ff, ['-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '22050', '-t', '60', '-f', 'f32le', 'pipe:1'], { binary: true, timeout: 60000 });
  if (!r.stdout || r.stdout.length < 22050 * 4) return { audio: false };
  const buf = r.stdout;
  const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.floor(buf.length / 4) * 4));
  const res = detectBeats(pcm, 22050);
  if (!res || res.reason || !Array.isArray(res.beats)) return { audio: true, beats: [], reason: res && res.reason };
  const beats = res.beats.map(b => Math.round(b * 1000) / 1000);
  const near = cuts.map(c => Math.min(...beats.map(b => Math.abs(b - c))));
  const onBeat = near.filter(d => d <= 0.08).length;
  return { audio: true, bpm: res.bpm, beats: beats.slice(0, 120), cutsOnBeat: onBeat, cutsTotal: cuts.length, editedToBeat: cuts.length >= 2 && onBeat / cuts.length >= 0.6 };
}

async function frameAt(ff, video, t, width, out) {
  await run(ff, ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-y', out], { timeout: 20000 });
  return fs.existsSync(out) ? fs.readFileSync(out) : null;
}

// Contact sheets: ONE ffmpeg pass, consecutive frames at `rate` fps tiled 4×2 — sheet k, cell j
// is the frame at (8k + j) / rate seconds. The writer gets each sheet's exact timestamps as text
// (grid mode beat plain frames on 3/3 sources, 2026-10-04).
async function sheets(ff, video, duration, dir) {
  const rate = Math.min(4, 96 / Math.max(duration, 1));
  const pat = path.join(dir, 'sheet-%02d.jpg');
  await run(ff, ['-v', 'error', '-i', video, '-vf', `fps=${rate},scale=240:-2,tile=4x2:padding=4:color=white`, '-q:v', '5', '-y', pat], { timeout: 120000 });
  const files = fs.readdirSync(dir).filter(f => /^sheet-\d+\.jpg$/.test(f)).sort();
  return files.map((f, k) => ({
    buf: fs.readFileSync(path.join(dir, f)),
    times: Array.from({ length: 8 }, (_, j) => Math.round(((k * 8 + j) / rate) * 100) / 100).filter(t => t < duration),
  }));
}

async function callWriter({ system, content, key }) {
  const body = (model) => ({
    model, max_tokens: 8000, system,
    ...(/^claude-(sonnet-5|opus-5)/.test(model) ? { thinking: { type: 'disabled' } } : { temperature: 0.2 }),
    messages: [{ role: 'user', content }],
  });
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  let r = await axios.post('https://api.anthropic.com/v1/messages', body(WRITER_MODEL), { headers, timeout: 240000, validateStatus: () => true });
  let model = WRITER_MODEL;
  if (r.status !== 200) {
    console.warn(`[clone-v2] writer ${WRITER_MODEL} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)} — falling back to ${FALLBACK_MODEL}`);
    r = await axios.post('https://api.anthropic.com/v1/messages', body(FALLBACK_MODEL), { headers, timeout: 240000, validateStatus: () => true });
    model = FALLBACK_MODEL;
  }
  if (r.status !== 200) throw new Error(`writer ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  const text = (r.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return { text, model, usage: r.data.usage || null, stop: r.data.stop_reason };
}

function mount(app, deps) {
  const { downloadInstagramViaApify, downloadTikTok, detectBeats, tempVideos, cleanOldTempVideos, PYTHON, ffmpegBin, hookMotionScript } = deps;
  const PY = process.env.V2_PYTHON || PYTHON;

  app.post('/api/clone-v2', async (req, res) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clonev2-'));
    const t0 = Date.now();
    const timing = {};
    const mark = (k) => { timing[k] = Math.round((Date.now() - t0) / 100) / 10; };
    try {
      const { videoUrl } = req.body || {};
      const personaGender = ['male', 'female'].includes(req.body.personaGender) ? req.body.personaGender : null;
      const name = String(req.body.name || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').slice(0, 40) || 'the main person';
      const key = process.env.ANTHROPIC_API_KEY;
      if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });
      if (!key) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
      console.log(`[clone-v2] ${V2_VERSION} lid=${req.body.locationId || '?'} url=${String(videoUrl).slice(0, 200)}`);

      // 1. Download (same helpers as v1).
      const video = path.join(tmp, 'video.mp4');
      if (/instagram\.com\/(p|reel|reels)\//.test(videoUrl)) {
        await downloadInstagramViaApify(videoUrl, video);
      } else if (/tiktok\.com\//.test(videoUrl)) {
        await downloadTikTok(videoUrl, video, () => new Promise((resolve, reject) => execFile('yt-dlp', ['-o', video, '-f', 'mp4/best[ext=mp4]/best', '--no-playlist', '--quiet', videoUrl], { timeout: 90000 }, (e) => e ? reject(e) : resolve())));
      } else {
        const r = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 200 * 1024 * 1024 });
        fs.writeFileSync(video, Buffer.from(r.data));
      }
      if (!fs.existsSync(video) || fs.statSync(video).size < 1000) return res.status(400).json({ success: false, error: 'Could not download that video.' });
      mark('download');

      const probe = await run(ffmpegBin, ['-hide_banner', '-i', video], { timeout: 20000 });
      const dm = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(probe.stderr);
      const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 15;

      // 2. MEASURE.
      const { cuts, falseCuts } = await measureCuts(ffmpegBin, video, duration); mark('cuts');
      const camera = await py(PY, path.join(__dirname, 'cameramotion.py'), [video, cuts.join(',')], 120000); mark('camera');
      const hookSecs = Math.min(1.5, cuts.length ? cuts[0] : 1.5);
      const hookMotion = await py(PY, hookMotionScript, [video, String(hookSecs)], 45000); mark('hookmotion');
      const beats = await measureBeats(ffmpegBin, video, detectBeats, cuts).catch(() => null); mark('beats');

      // 3. SEE — sheets, dense hook frames, one full-size frame per shot.
      const sh = await sheets(ffmpegBin, video, duration, tmp);
      const hookTs = []; for (let t = 0; t <= Math.max(0.05, hookSecs - 0.05) && hookTs.length < 10; t += 0.15) hookTs.push(Math.round(t * 100) / 100);
      const hook = []; for (const t of hookTs) { const b = await frameAt(ffmpegBin, video, t, 640, path.join(tmp, `hook-${t}.jpg`)); if (b) hook.push({ t, b }); }
      const bounds = [0, ...cuts, duration];
      const shotKeys = [];
      // TWO frames per shot (at 25 % and 75 %): one middle frame of a 0.6 s shot was dark on lobby
      // run 1 and the writer reported the influencer as absent from a shot he walks through.
      for (let i = 0; i < bounds.length - 1 && shotKeys.length < 24; i++) {
        const a = bounds[i], b0 = bounds[i + 1];
        for (const f of [0.25, 0.75]) {
          const t = Math.round((a + (b0 - a) * f) * 100) / 100;
          const b = await frameAt(ffmpegBin, video, t, 640, path.join(tmp, `key-${i}-${f}.jpg`));
          if (b) shotKeys.push({ t, shot: i + 1, b });
        }
      }
      mark('frames');

      const camLine = camera && Array.isArray(camera.segments) && camera.segments.length
        ? camera.segments.map(s => `${s.from}-${s.to}s: ${[s.pan && 'turns ' + s.pan.toUpperCase(), s.zoom && (s.zoom === 'in' ? 'moves closer' : 'moves back'), s.tilt && 'tilts ' + s.tilt].filter(Boolean).join(' + ') || 'holds'}`).join(' · ')
        : 'not measured';
      const facts = [
        `DURATION: ${Math.round(duration * 100) / 100} s.`,
        `MEASURED CUTS (shots must start exactly here): ${cuts.length ? cuts.join(', ') + ' s' : 'none — one continuous take'}.${falseCuts.length ? ` (Rejected as flashes, NOT cuts: ${falseCuts.map(f => f.t).join(', ')} s.)` : ''}`,
        `MEASURED CAMERA (optical flow on the background, screen directions): ${camLine}.`,
        hookMotion && hookMotion.head >= 0 ? `MEASURED HOOK MOTION in the first ${hookMotion.seconds} s (camera removed, px per 0.1 s): head ${hookMotion.head}, middle ${hookMotion.middle}, bottom ${hookMotion.bottom}. A band moving much more than the head is a movement you must list.` : '',
        beats && beats.audio && beats.bpm ? `MUSIC: ~${beats.bpm} BPM; ${beats.cutsOnBeat}/${beats.cutsTotal} cuts land on a beat${beats.editedToBeat ? ' (edited to the beat)' : ''}.` : '',
      ].filter(Boolean).join('\n');

      const b64 = (buf) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
      const content = [{ type: 'text', text: facts }];
      sh.forEach((s, k) => { content.push({ type: 'text', text: `CONTACT SHEET ${k + 1} (left→right, top→bottom) at ${s.times.join(', ')} s:` }); content.push(b64(s.buf)); });
      content.push({ type: 'text', text: `DENSE HOOK FRAMES (full size), at ${hook.map(h => h.t).join(', ')} s — compare each with the next to catch every small movement:` });
      hook.forEach(h => content.push(b64(h.b)));
      shotKeys.forEach(k => { content.push({ type: 'text', text: `SHOT ${k.shot} — full-size frame at ${k.t} s (read clothing, which side of the top faces the camera, framing):` }); content.push(b64(k.b)); });
      content.push({ type: 'text', text: 'Fill the JSON spec now. Return only JSON.' });

      // 4. WRITE the spec (one repair attempt on invalid JSON).
      const system = writerSystem({ personaGender });
      let w = await callWriter({ system, content, key }); mark('writer');
      let spec = parseSpec(w.text), errs = spec ? validateSpec(spec) : ['no JSON'];
      if (errs.length) {
        console.warn(`[clone-v2] spec invalid (${errs.join('; ')}) — one repair attempt`);
        w = await callWriter({ system, key, content: [...content, { type: 'text', text: `Your previous answer was invalid (${errs.join('; ')}). Return the complete JSON spec only.` }] });
        spec = parseSpec(w.text); errs = spec ? validateSpec(spec) : ['no JSON'];
        mark('writer-repair');
      }
      if (errs.length) return res.status(502).json({ success: false, error: 'The analysis could not be structured — try again.', detail: errs, raw: String(w.text).slice(0, 2000) });

      // 5. COMPILE for both models (no reference bindings yet — the tool adds them per job).
      const copts = { name, gender: personaGender, cuts, camera: camera && camera.segments, durationSec: duration };
      const wan = compile(spec, { ...copts, model: 'wan' });
      const seedance = compile(spec, { ...copts, model: 'seedance' });

      // Source copy for side-by-side playback (same 30-min temp store as v1).
      let sourceVideoUrl = '';
      try {
        if (typeof cleanOldTempVideos === 'function') cleanOldTempVideos();
        const tok = `v2src${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const p = path.join(os.tmpdir(), `tempvid_${tok}.mp4`);
        fs.copyFileSync(video, p);
        tempVideos.set(tok, { filePath: p, createdAt: Date.now() });
        sourceVideoUrl = `https://${req.get('host')}/api/temp-video/${tok}`;
      } catch (_) {}

      mark('total');
      console.log(`[clone-v2] done ${duration.toFixed(1)}s source, ${cuts.length} cuts, ${spec.shots.length} shots, writer=${w.model}, ${JSON.stringify(timing)}`);
      const thumb = (buf) => 'data:image/jpeg;base64,' + buf.toString('base64');
      res.json({
        success: true, version: V2_VERSION, durationSec: Math.round(duration * 100) / 100,
        measured: { cuts, falseCuts, camera: (camera && camera.segments) || null, hookMotion, beats },
        spec, prompts: { wan, seedance },
        keyframes: shotKeys.map(k => ({ t: k.t, shot: k.shot, dataUrl: thumb(k.b) })),
        hookFrames: hook.slice(0, 1).map(h => ({ t: h.t, dataUrl: thumb(h.b) })),
        sourceVideoUrl, writer: { model: w.model, usage: w.usage, stop: w.stop }, timing,
      });
    } catch (e) {
      console.error('[clone-v2] failed:', e.message);
      res.status(500).json({ success: false, error: String(e.message || e).slice(0, 300) });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });
}

module.exports = { mount, V2_VERSION, measureCuts, FLASH_MAD };
