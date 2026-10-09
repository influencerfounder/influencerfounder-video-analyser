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

const V2_VERSION = 'v2-0.7.0';
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
// 🎞 MOTION IS NOT A CUT (2026-10-09) — see cutflow.py. Below this share of unexplained difference the
// "cut" is a camera move or fast action (window-cleaning fall: five fake cuts in a ZERO-cut source).
const CUT_FLOW_RATIO = 0.665;

async function measureCuts(ff, video, duration, flowCheck) {
  const r = await run(ff, ['-hide_banner', '-i', video, '-an', '-vf', "select='gt(scene,0.2)',showinfo", '-f', 'null', '-'], { timeout: 90000 });
  const raw = [...String(r.stderr).matchAll(/pts_time:([0-9.]+)/g)].map(m => Number(m[1])).filter(t => t > 0.15 && t < duration - 0.15);
  const cand = [];
  for (const t of raw) if (!cand.length || t - cand[cand.length - 1] >= 0.3) cand.push(Math.round(t * 100) / 100);
  const cuts = [], falseCuts = [], motionCuts = [];
  // One python call for every candidate; null (no python / cv2 / timeout) = judged as before (fails open).
  const flow = typeof flowCheck === 'function' && cand.length ? await flowCheck(cand).catch(() => null) : null;
  const ratios = (flow && flow.ratios) || {};
  for (const t of cand) {
    const fr = ratios[String(t)];
    if (typeof fr === 'number' && fr < CUT_FLOW_RATIO) { motionCuts.push({ t, flow: fr }); continue; }
    const a = await grey32(ff, video, t - 0.2), b = await grey32(ff, video, t + 0.3);
    if (a && b) {
      let s = 0; for (let i = 0; i < 1024; i++) s += Math.abs(a[i] - b[i]);
      const mad = s / 1024;
      if (mad < FLASH_MAD) { falseCuts.push({ t, mad: Math.round(mad * 10) / 10 }); continue; }
    }
    cuts.push(t);
  }
  return { cuts, falseCuts, motionCuts };
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

// ⚡ FAST-ACTION WINDOWS (2026-10-09). The rejected "cuts" (motionCuts) mark exactly where something
// fast happens inside one take — the window-cleaning fall, a whip pan. The writer read that fall from
// 240-px contact-sheet cells (the figure a few dozen pixels tall) and called a slipping stool "steps
// down and leans over". Each window (candidates within 1 s merged, padded 0.5 s before / 0.4 s after)
// gets up to 10 larger frames ~0.1 s apart, like the dense hook frames. At most two windows.
function fastWindows(motionCuts, duration) {
  const ts = (motionCuts || []).map(c => c.t).sort((a, b) => a - b), wins = [];
  for (const t of ts) { const w = wins[wins.length - 1]; if (w && t - w.last <= 1) w.last = t; else wins.push({ first: t, last: t }); }
  return wins.slice(0, 2).map(w => {
    const a = Math.max(0, w.first - 0.5), b = Math.min(duration - 0.05, w.last + 0.4), n = Math.min(10, Math.max(2, Math.round((b - a) / 0.1) + 1));
    return { from: Math.round(a * 100) / 100, to: Math.round(b * 100) / 100, times: Array.from({ length: n }, (_, i) => Math.round((a + (b - a) * i / (n - 1)) * 100) / 100) };
  });
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

async function callWriter({ system, content, key, maxTokens = 8000 }) {
  const body = (model) => ({
    model, max_tokens: maxTokens, system,
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

// ── Phase 2: the OUTFIT, cut from the SOURCE itself (2026-10-06, Mike: "build it like this") ──
// Every recreate has a different outfit, so it is built per video from the video: the clearest real
// frame of MAIN facing the camera and the clearest from behind, cut from just below the chin down.
// Real pixels at the source's own resolution, PNG (lossless) — no generation, no downscale (the
// reference rule). The face is left out so the source person's identity is not handed to the model.
const OUTFIT_PICK_SYSTEM = `You pick reference crops of ONE person's outfit from video frames. Each candidate frame has thin grid lines every 10% of its width and height. MAIN is the main person of the video (described below). Choose the best FRONT candidate (MAIN facing the camera, torso visible) and the best BACK candidate (MAIN turned away, the back of the top visible): FIRST priority: every print, logo and piece of text on the top is clearly legible (a close-up that shows the chest logo sharply beats a wide shot where it is a smudge). Then: MAIN as complete as possible (neck to feet, at least to the hips), least covered, sharpest. Give a box for MAIN only, in percent of the frame: x0,y0 = left/top, x1,y1 = right/bottom. The TOP edge (y0) sits just below the chin — never include the face, mouth or hair — but the collar/neckline and anything printed near it MUST be inside the box. Include the whole outfit down to the shoes if they are visible, both arms, and nothing of other people if avoidable. Use null when no candidate shows that side. Return ONLY JSON: {"front":{"index":0,"box":[x0,y0,x1,y1]}|null,"back":{"index":0,"box":[x0,y0,x1,y1]}|null}`;

function specShotAt(spec, t) {
  const shots = (spec && Array.isArray(spec.shots) ? spec.shots : []).slice().sort((a, b) => (+a.start || 0) - (+b.start || 0));
  let cur = null;
  for (const s of shots) if ((+s.start || 0) <= t + 0.001) cur = s;
  return cur;
}

// Box (percent) → integer pixel crop inside the frame; 2 % side/bottom padding, none above (the chin).
function cropRect(box, W, H) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  let [x0, y0, x1, y1] = box.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  if (x1 <= 1 && y1 <= 1) { x0 *= 100; y0 *= 100; x1 *= 100; y1 *= 100; } // tolerate 0-1 fractions
  x0 = Math.max(0, x0 - 2); x1 = Math.min(100, x1 + 2); y1 = Math.min(100, y1 + 2); y0 = Math.max(0, y0);
  const px = (v, D) => Math.round((v / 100) * D);
  const x = px(x0, W), y = px(y0, H), w = px(x1, W) - x, h = px(y1, H) - y;
  if (w < W * 0.08 || h < H * 0.08) return null;   // a sliver is a failed pick, not a crop
  // Wan 3.0 refuses any reference image under 240 px on a side ("reference_image_urls resolution is
  // out of range", 2026-10-09: a slim figure in a 716 px frame gave a 156x536 front crop). Widen a
  // short side with MORE REAL PIXELS around the box, centred and kept inside the frame — never a
  // resize, so the crop stays the source's own bytes (the reference rule).
  const grow = (o, len, D) => {
    if (len >= REF_MIN_SIDE || D < REF_MIN_SIDE) return [o, len];
    const n = REF_MIN_SIDE;
    return [Math.min(Math.max(0, Math.round(o - (n - len) / 2)), D - n), n];
  };
  const [gx, gw] = grow(x, w, W), [gy, gh] = grow(y, h, H);
  return { x: gx, y: gy, w: gw - (gw % 2), h: gh - (gh % 2) };
}
const REF_MIN_SIDE = 240;

async function fullFramePng(ff, video, t, out) {
  await run(ff, ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', video, '-frames:v', '1', '-y', out], { timeout: 30000 });
  if (!fs.existsSync(out)) return null;
  const pr = await run(ff, ['-hide_banner', '-i', out], { timeout: 10000 });
  const m = /, (\d{2,5})x(\d{2,5})/.exec(pr.stderr);
  return m ? { path: out, W: +m[1], H: +m[2] } : null;
}

// Candidate times come from the SPEC's phases, not from the cut-based key frames: a one-take video
// has one measured shot and two key frames, and on G63 both fell where MAIN is side-on or gone
// (run 1: "no shot shows MAIN front or back" although 0-4 s is front and 9-12 s is back).
function outfitCandidateTimes(spec, duration) {
  const shots = (spec && Array.isArray(spec.shots) ? spec.shots : []).slice().sort((a, b) => (+a.start || 0) - (+b.start || 0));
  const out = [];
  shots.forEach((s, i) => {
    if (s.main_visible === false) return;
    const side = String(s.garment_side || '').toLowerCase();
    if (side !== 'front' && side !== 'back') return;
    const a = +s.start || 0, b = i + 1 < shots.length ? (+shots[i + 1].start || a) : duration;
    if (!(b > a)) return;
    for (const f of (b - a >= 1.2 ? [0.3, 0.7] : [0.5])) out.push({ t: Math.round((a + (b - a) * f) * 100) / 100, side });
  });
  return out;
}

async function pickOutfit({ spec, ff, video, tmp, key, duration }) {
  const cand = [];
  for (const k of outfitCandidateTimes(spec, duration)) {
    if (cand.filter(c => c.side === k.side).length >= 6) continue;   // 4 cut lobby's sharp shot-6 chest logo off the list
    const g = path.join(tmp, `grid-${cand.length}.jpg`);
    await run(ff, ['-v', 'error', '-ss', String(k.t), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2,drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.45', '-q:v', '4', '-y', g], { timeout: 20000 });
    if (fs.existsSync(g)) cand.push({ t: k.t, side: k.side, buf: fs.readFileSync(g) });
  }
  if (!cand.length) return { front: null, back: null, reason: 'no shot shows MAIN front or back' };
  const o = spec.outfit || {};
  const content = [{ type: 'text', text: `MAIN wears: ${o.top_name || ''} (front: ${o.top_front || 'not shown'}; back: ${o.top_back || 'not shown'}), ${o.bottom || ''}, ${o.shoes || ''}.` }];
  cand.forEach((c, i) => { content.push({ type: 'text', text: `Candidate ${i} — ${c.side.toUpperCase()} view at ${c.t} s:` }); content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.buf.toString('base64') } }); });
  const w = await callWriter({ system: OUTFIT_PICK_SYSTEM, content, key, maxTokens: 600 });
  const pick = parseSpec(w.text) || {};
  const out = { front: null, back: null, writer: w.model };
  for (const side of ['front', 'back']) {
    const p = pick[side];
    const c = p && Number.isInteger(p.index) ? cand[p.index] : null;
    if (!c || c.side !== side) continue;
    const full = await fullFramePng(ff, video, c.t, path.join(tmp, `full-${side}.png`));
    if (!full) continue;
    const r = cropRect(p.box, full.W, full.H);
    if (!r) continue;
    const crop = path.join(tmp, `outfit-${side}.png`);
    await run(ff, ['-v', 'error', '-i', full.path, '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}`, '-y', crop], { timeout: 20000 });
    if (fs.existsSync(crop)) out[side] = { t: c.t, box: p.box, px: r, sourceSize: [full.W, full.H], png: fs.readFileSync(crop).toString('base64') };
  }
  return out;
}

function mount(app, deps) {
  const { downloadInstagramViaApify, downloadTikTok, detectBeats, tempVideos, cleanOldTempVideos, PYTHON, ffmpegBin, hookMotionScript } = deps;
  const PY = process.env.V2_PYTHON || PYTHON;

  // Phase 3 (2026-10-06): compile again with the job's REFERENCE BINDINGS ("Image 1 is the opening
  // frame…"), so the tool never writes prompt text of its own — one compiler, one set of rules.
  // Pure and fast: no download, no model call.
  app.post('/api/compile-v2', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.spec || !Array.isArray(b.spec.shots)) return res.status(400).json({ success: false, error: 'Missing spec' });
      const refs = (Array.isArray(b.refs) ? b.refs : []).filter(r => r && typeof r.kind === 'string').slice(0, 30);
      const out = compile(b.spec, { name: String(b.name || '').slice(0, 40), gender: ['male', 'female'].includes(b.gender) ? b.gender : null,
        model: b.model === 'seedance' ? 'seedance' : 'wan', cuts: Array.isArray(b.cuts) ? b.cuts.map(Number).filter(Number.isFinite) : [],
        camera: Array.isArray(b.camera) ? b.camera : null, durationSec: Number(b.durationSec) || 0, refs });
      res.json({ success: true, version: V2_VERSION, ...out });
    } catch (e) { res.status(500).json({ success: false, error: String(e.message || e).slice(0, 200) }); }
  });

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
      const { cuts, falseCuts, motionCuts } = await measureCuts(ffmpegBin, video, duration, (ts) => py(PY, path.join(__dirname, 'cutflow.py'), [video, ts.join(',')], 60000)); mark('cuts');
      const camera = await py(PY, path.join(__dirname, 'cameramotion.py'), [video, cuts.join(',')], 120000); mark('camera');
      const hookSecs = Math.min(1.5, cuts.length ? cuts[0] : 1.5);
      const hookMotion = await py(PY, hookMotionScript, [video, String(hookSecs)], 45000); mark('hookmotion');
      const beats = await measureBeats(ffmpegBin, video, detectBeats, cuts).catch(() => null); mark('beats');

      // 3. SEE — sheets, dense hook frames, one full-size frame per shot.
      const sh = await sheets(ffmpegBin, video, duration, tmp);
      const hookTs = []; for (let t = 0; t <= Math.max(0.05, hookSecs - 0.05) && hookTs.length < 10; t += 0.15) hookTs.push(Math.round(t * 100) / 100);
      const hook = []; for (const t of hookTs) { const b = await frameAt(ffmpegBin, video, t, 640, path.join(tmp, `hook-${t}.jpg`)); if (b) hook.push({ t, b }); }
      const fast = [];
      for (const w of fastWindows(motionCuts, duration)) { const fr = []; for (const t of w.times) { const b = await frameAt(ffmpegBin, video, t, 480, path.join(tmp, `fast-${t}.jpg`)); if (b) fr.push({ t, b }); } if (fr.length) fast.push({ ...w, fr }); }
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
        `MEASURED CUTS (shots must start exactly here): ${cuts.length ? cuts.join(', ') + ' s' : 'none — one continuous take'}.${motionCuts.length ? ` (Rejected as camera moves or fast action inside ONE continuous take, NOT cuts: ${motionCuts.map(c => c.t).join(', ')} s — write those moments as continuous motion, never as Hard cut.)` : ''}${falseCuts.length ? ` (Rejected as flashes, NOT cuts: ${falseCuts.map(f => f.t).join(', ')} s.)` : ''}`,
        `MEASURED CAMERA (optical flow on the background, screen directions): ${camLine}.`,
        hookMotion && hookMotion.head >= 0 ? `MEASURED HOOK MOTION in the first ${hookMotion.seconds} s (camera removed, px per 0.1 s): head ${hookMotion.head}, middle ${hookMotion.middle}, bottom ${hookMotion.bottom}. A band moving much more than the head is a movement you must list.` : '',
        beats && beats.audio && beats.bpm ? `MUSIC: ~${beats.bpm} BPM; ${beats.cutsOnBeat}/${beats.cutsTotal} cuts land on a beat${beats.editedToBeat ? ' (edited to the beat)' : ''}.` : '',
      ].filter(Boolean).join('\n');

      const b64 = (buf) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
      const content = [{ type: 'text', text: facts }];
      sh.forEach((s, k) => { content.push({ type: 'text', text: `CONTACT SHEET ${k + 1} (left→right, top→bottom) at ${s.times.join(', ')} s:` }); content.push(b64(s.buf)); });
      content.push({ type: 'text', text: `DENSE HOOK FRAMES (full size), at ${hook.map(h => h.t).join(', ')} s — compare each with the next to catch every small movement:` });
      hook.forEach(h => content.push(b64(h.b)));
      fast.forEach(w => { content.push({ type: 'text', text: `FAST ACTION ${w.from}-${w.to} s, one continuous take (no cut), frames at ${w.fr.map(f => f.t).join(', ')} s — compare each with the next and describe exactly what physically happens (what slips, falls, gets caught, which way the camera follows), never a guessed intention:` }); w.fr.forEach(f => content.push(b64(f.b))); });
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

      // 4b. OUTFIT crops (phase 2) + the full-resolution opening frame for the first-frame step.
      // Fail open: a missing crop is shown as missing in the Lab, never invented.
      let outfit = { front: null, back: null };
      try { outfit = await pickOutfit({ spec, ff: ffmpegBin, video, tmp, key, duration }); } catch (e) { outfit = { front: null, back: null, reason: String(e.message || e).slice(0, 160) }; }
      mark('outfit');
      let frame0 = null;
      try {
        const f0 = await fullFramePng(ffmpegBin, video, hookTs[0] || 0.05, path.join(tmp, 'frame0.png'));
        if (f0) frame0 = { t: hookTs[0] || 0.05, size: [f0.W, f0.H], png: fs.readFileSync(f0.path).toString('base64') };
      } catch (_) {}

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
        measured: { cuts, falseCuts, motionCuts, camera: (camera && camera.segments) || null, hookMotion, beats },
        spec, prompts: { wan, seedance },
        keyframes: shotKeys.map(k => ({ t: k.t, shot: k.shot, dataUrl: thumb(k.b) })),
        outfit, frame0,
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

module.exports = { mount, V2_VERSION, measureCuts, fastWindows, FLASH_MAD, CUT_FLOW_RATIO, cropRect, specShotAt, outfitCandidateTimes };
