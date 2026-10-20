// ✂️ BACKGROUND-ONLY SWAP BY CUT-OUT (2026-10-18, Mike: "build the cut-out method into the Change
// background button"). Every generative edit we tried redrew the person (Seedance 2.5 edit mode shifted the
// framing, Wan 2.7 Video Edit erased the INK ADDICT back print). This keeps the person's ORIGINAL pixels:
//   mask the people (BiRefNet video on fal) → split at hard cuts → per shot grey out the background and
//   regenerate ONLY that hole (Wan VACE 14B inpainting on fal, prompt matched to the source's light) →
//   paste the original pixels back through the matte, with a light match, light wrap and edge
//   decontamination → original audio back on.
// Measured on the Kryfex station clip: person-core PSNR 40–48 dB (visually identical), every cut kept.
// Lessons that shaped it (reports/Background only swap.md):
//   - VACE copies whatever the source still shows: with the original background visible it redrew the
//     station. So the background is GREYED OUT in the video it gets.
//   - A background in the SOURCE's light hides edges; a bright sky exposes every matting error.
//   - Motion-blurred hands get low alpha and go see-through: the matte is firmed and smoothed over
//     neighbouring frames.
//   - Edge pixels still carry the OLD background (a bright column gave a white rim): decontaminate them.
//   - Measure the light in a ring AROUND the person, never the whole frame (a blue sky pulled him cool).
// Owner-only: it bills Mike's own fal key, which the tool passes per request (like kieApiKey).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

const VACE_MIN_FRAMES = 17;            // fal wan-vace-14b/inpainting num_frames floor
const VACE_MAX_FRAMES = 241;           // and its ceiling (schema 17–241): a longer uncut shot is refused, never truncated
const CHUNK = 40;                      // frames held in memory at once (~10 MB per 720x1280 frame with mattes)
const CUT_DIFF_MIN = 25;               // a hard cut: mean abs frame difference well above the motion level
const CUT_DIFF_X_MEDIAN = 5;

// ── pure image helpers (Float32, interleaved RGB or single channel) ──────────────────────────────
/** Separable box blur of a single-channel W×H Float32Array, radius r, edge-clamped. */
function boxBlur1(src, W, H, r) {
  if (r <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H), d = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const row = y * W; let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(W - 1, Math.max(0, k))];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = acc / d;
      acc += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / d;
      acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}
function boxBlur3(rgb, W, H, r) {
  const n = W * H, c = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { c[0][i] = rgb[i * 3]; c[1][i] = rgb[i * 3 + 1]; c[2][i] = rgb[i * 3 + 2]; }
  const b = c.map((ch) => boxBlur1(ch, W, H, r)), out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = b[0][i]; out[i * 3 + 1] = b[1][i]; out[i * 3 + 2] = b[2][i]; }
  return out;
}
const ycc = (r, g, b) => { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return [y, (b - y) / 1.8556, (r - y) / 1.5748]; };
const rgbOf = (y, cb, cr) => { const r = y + 1.5748 * cr, b = y + 1.8556 * cb; return [r, (y - 0.2126 * r - 0.0722 * b) / 0.7152, b]; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Hard cuts from per-frame mean abs differences (diffs[i] = frame i+1 vs frame i). Returns shot
 *  boundaries [0, …, frameCount]. */
function detectCuts(diffs, frameCount) {
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const thr = Math.max(CUT_DIFF_MIN, median * CUT_DIFF_X_MEDIAN);
  const cuts = [0];
  diffs.forEach((d, i) => { if (d > thr && i + 1 - cuts[cuts.length - 1] >= 3) cuts.push(i + 1); });
  cuts.push(frameCount);
  return cuts;
}

/** Firm, temporally smoothed matte from BiRefNet masks (0..255 Uint8, single channel): neighbours averaged
 *  with the current frame, then remapped so motion-blurred hands stay solid, with a slight choke. */
function firmMatte(cur, prev, next) {
  const n = cur.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const nb = [cur[i]]; if (prev) nb.push(prev[i]); if (next) nb.push(next[i]);
    const avg = nb.reduce((s, v) => s + v, 0) / nb.length / 255;
    const m = 0.5 * avg + 0.5 * cur[i] / 255;
    out[i] = Math.pow(clamp((m - 0.10) / 0.82, 0, 1), 0.7);
  }
  return out;
}

/** Half-sure matte areas AWAY from anyone's solid body are a ghost (2026-10-18: a woman behind his arm,
 *  half in the mask, let the old station show through as a muddy patch). Within 8 px of a solid region the
 *  soft values stay (real edges, motion-blurred hands); further out they snap to 0 or 1. */
function matteClean(matte, W, H) {
  const solid = new Float32Array(W * H); for (let i = 0; i < solid.length; i++) solid[i] = matte[i] > 0.9 ? 1 : 0;
  const near = boxBlur1(solid, W, H, 8), out = new Float32Array(matte.length);
  for (let i = 0; i < out.length; i++) out[i] = near[i] > 0.01 ? matte[i] : (matte[i] >= 0.5 ? 1 : 0);
  return out;
}

/** Light match for one shot, from the mean colour of a ring around the people in the old vs new
 *  background. One value per shot = no flicker. Returns { gainY, dCb, dCr }. */
function lightParams(oldRing, newRing) {
  const o = ycc(...oldRing), n = ycc(...newRing);
  return {
    gainY: clamp(Math.pow(Math.max(n[0], 1) / Math.max(o[0], 1), 0.45), 0.90, 1.15),
    dCb: clamp(0.35 * (n[1] - o[1]), -8, 8),
    dCr: clamp(0.35 * (n[2] - o[2]), -8, 8),
  };
}

/** Mean RGB of the ring around the people (inside a 40 px reach of the matte, outside the matte). */
function ringMean(rgb, matte, W, H) {
  const reach = boxBlur1(matte, W, H, 40);
  let r = 0, g = 0, b = 0, k = 0;
  for (let i = 0; i < W * H; i++) {
    if (reach[i] > 0.02 && matte[i] < 0.05) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; k++; }
  }
  if (k < 500) { r = g = b = k = 0; for (let i = 0; i < W * H; i++) if (matte[i] < 0.05) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; k++; } }
  return k ? [r / k, g / k, b / k] : [128, 128, 128];
}

/** One composited frame: original pixels over the new background. src/bg are Uint8 RGB, matte Float32.
 *  The solid core (matte ≥ 0.98) keeps the original colour except the per-shot light match. */
function compositeFrame(src, bg, matte, W, H, light) {
  const n = W * H, a = boxBlur1(matte, W, H, 1);
  // edge decontamination: the old background behind each edge pixel, from nearby background pixels
  const bgw = new Float32Array(n), srcBg = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const w = a[i] < 0.03 ? 1 : 0; bgw[i] = w; srcBg[i * 3] = src[i * 3] * w; srcBg[i * 3 + 1] = src[i * 3 + 1] * w; srcBg[i * 3 + 2] = src[i * 3 + 2] * w; }
  const bSum = boxBlur3(srcBg, W, H, 15), wSum = boxBlur1(bgw, W, H, 15);
  // light wrap: the blurred new background bleeds over a thin band at the edge
  const inner = new Float32Array(n); for (let i = 0; i < n; i++) inner[i] = matte[i] > 0.98 ? 1 : 0;
  const innerB = boxBlur1(inner, W, H, 4), bgBlur = boxBlur3(Float32Array.from(bg), W, H, 10);
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const al = a[i], j = i * 3;
    let r = src[j], g = src[j + 1], b = src[j + 2];
    if (al > 0 && al < 0.98) {
      const ws = Math.max(wSum[i], 1e-3), inv = 1 / Math.max(al, 0.25);
      r = clamp((r - (1 - al) * bSum[j] / ws) * inv, 0, 255);
      g = clamp((g - (1 - al) * bSum[j + 1] / ws) * inv, 0, 255);
      b = clamp((b - (1 - al) * bSum[j + 2] / ws) * inv, 0, 255);
    }
    const q = ycc(r, g, b); [r, g, b] = rgbOf(q[0] * light.gainY, q[1] + light.dCb, q[2] + light.dCr);
    const e = clamp(al - innerB[i], 0, 1) * 0.15;
    r = r * (1 - e) + bgBlur[j] * e; g = g * (1 - e) + bgBlur[j + 1] * e; b = b * (1 - e) + bgBlur[j + 2] * e;
    out[j] = clamp(Math.round(r * al + bg[j] * (1 - al)), 0, 255);
    out[j + 1] = clamp(Math.round(g * al + bg[j + 1] * (1 - al)), 0, 255);
    out[j + 2] = clamp(Math.round(b * al + bg[j + 2] * (1 - al)), 0, 255);
  }
  return out;
}

/** VACE input for one frame: the people kept (slightly widened), the rest flat grey; and the inverted mask
 *  (255 = regenerate) that leaves only the solid core of the people alone. */
function vaceInputs(src, mask, W, H) {
  const n = W * H, keep = new Float32Array(n), core = new Float32Array(n);
  for (let i = 0; i < n; i++) { keep[i] = mask[i] > 40 ? 1 : 0; core[i] = mask[i] > 200 ? 1 : 0; }
  const keepD = boxBlur1(keep, W, H, 3), coreE = boxBlur1(core, W, H, 3);
  const grey = new Uint8Array(n * 3), inv = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = keepD[i] > 0.001;
    grey[i * 3] = k ? src[i * 3] : 128; grey[i * 3 + 1] = k ? src[i * 3 + 1] : 128; grey[i * 3 + 2] = k ? src[i * 3 + 2] : 128;
    inv[i] = coreE[i] > 0.999 ? 0 : 255;
  }
  return { grey, inv };
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────
function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args); const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`)));
    if (input) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}
/** ffmpeg's full stderr for `-i file` (it always exits 1 with no output file — the info is in stderr).
 *  Full text on purpose: run()'s error keeps only the last 400 chars, which drops the Video: line. */
function ffInfo(file) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-i', file]); let err = '';
    p.stderr.on('data', (d) => { err += d; }); p.on('error', () => resolve('')); p.on('close', () => resolve(err));
  });
}
async function probe(file) {
  const txt = await ffInfo(file);
  const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(txt), f = /(\d+(?:\.\d+)?) fps/.exec(txt), au = /Audio:/.test(txt);
  return { W: m ? +m[1] : 0, H: m ? +m[2] : 0, fps: f ? +f[1] : 24, audio: au };
}
/** Decode frames [from, to) as raw RGB (or gray) buffers. */
async function readFrames(file, W, H, from, to, gray, scaleTo) {
  const ch = gray ? 1 : 3;
  const vf = `select=between(n\\,${from}\\,${to - 1})` + (scaleTo ? `,scale=${W}:${H}` : '');
  const buf = await run('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', vf, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', gray ? 'gray' : 'rgb24', '-']);
  const size = W * H * ch, frames = [];
  for (let o = 0; o + size <= buf.length; o += size) frames.push(new Uint8Array(buf.buffer, buf.byteOffset + o, size));
  return frames;
}
function encoder(file, W, H, fps, gray) {
  const p = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', gray ? 'gray' : 'rgb24', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
    '-c:v', 'libx264', '-crf', gray ? '12' : '12', '-preset', 'medium', '-pix_fmt', 'yuv420p', file]);
  // A dead ffmpeg (bad size, full disk, killed) never emits 'drain': every write must also settle on
  // close, or the job hangs on "processing" for good (/toolscan 2026-10-19).
  let dead = null, closed = false;
  const done = new Promise((res, rej) => {
    p.on('close', (c) => { closed = true; if (c === 0) res(); else { dead = dead || new Error('encoder exited ' + c); rej(dead); } });
    p.on('error', (e) => { dead = dead || e; closed = true; rej(e); });
  });
  done.catch(() => {});   // observed through write()/end(); never an unhandledRejection
  p.stdin.on('error', (e) => { dead = dead || e; });   // EPIPE from a dead process
  const write = (b) => new Promise((r, j) => {
    if (dead || closed) return j(dead || new Error('encoder closed'));
    const onDrain = () => { p.removeListener('close', onClose); r(); };
    const onClose = () => { p.stdin.removeListener('drain', onDrain); j(dead || new Error('encoder closed')); };
    if (p.stdin.write(Buffer.from(b.buffer, b.byteOffset, b.byteLength))) return r();
    p.stdin.once('drain', onDrain); p.once('close', onClose);
  });
  return { write, end: () => { p.stdin.end(); return done; }, kill: () => { try { p.kill('SIGKILL'); } catch (_) {} } };
}

async function falRun(falKey, model, input, onTick) {
  const H = { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' };
  const sub = await axios.post(`https://queue.fal.run/${model}`, input, { headers: H, timeout: 60000 });
  const { status_url: statusUrl, response_url: responseUrl } = sub.data || {};
  if (!statusUrl) throw new Error(`fal ${model}: no status_url (${JSON.stringify(sub.data).slice(0, 200)})`);
  const t0 = Date.now();
  while (Date.now() - t0 < 15 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await axios.get(statusUrl, { headers: H, timeout: 30000 }).then((r) => r.data).catch(() => null);
    if (onTick) onTick(st && st.status);
    if (st && st.status === 'COMPLETED') return (await axios.get(responseUrl, { headers: H, timeout: 60000 })).data;
    if (st && /FAIL|ERROR/i.test(String(st.status))) throw new Error(`fal ${model} failed: ${JSON.stringify(st).slice(0, 300)}`);
  }
  throw new Error(`fal ${model} timed out`);
}
async function download(url, file) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000, maxContentLength: 300 * 1024 * 1024 });
  fs.writeFileSync(file, Buffer.from(r.data));
}

// Guard words (2026-10-19 rewrite, /toolscan §6.4): the first guard matched a 4+ letter brief word as a plain
// SUBSTRING, so a Dutch brief answered in English ("strand" vs "beach") and plurals were rejected — losing the
// per-shot lines — while "park" matched "parking". Now: whole words, singular/plural folded, and Claude names the
// new place in English itself ("place"), so the check works whatever language the brief is in.
const GUARD_STOP = new Set(['with', 'that', 'this', 'from', 'into', 'over', 'under', 'very', 'some', 'busy', 'evening', 'night', 'morning', 'visible', 'behind', 'street', 'open', 'side',
  'the', 'and', 'een', 'het', 'met', 'naar', 'voor', 'achter', 'bij', 'avond', 'nacht', 'ochtend', 'straat', 'place', 'background', 'scene', 'light', 'soft']);
function stem(w) { return w.replace(/(ies)$/, 'y').replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, '$1'); }
function guardWords(text) {
  return [...new Set((String(text || '').toLowerCase().match(/[a-zà-ÿ]{4,}/g) || []).filter((w) => !GUARD_STOP.has(w)).map(stem))];
}
/** Does `prompt` name the place? true when it contains, as a whole word (plural folded), at least one guard word
 *  of the brief OR half (at least one) of the guard words of Claude's own English place phrase. */
function namesPlace(prompt, brief, place) {
  const have = new Set(guardWords(prompt));
  const b = guardWords(brief), pl = guardWords(place);
  if (!b.length && !pl.length) return true;            // nothing checkable (a brief of stop words only)
  if (b.some((w) => have.has(w))) return true;
  if (pl.length && pl.filter((w) => have.has(w)).length >= Math.max(1, Math.ceil(pl.length / 2))) return true;
  return false;
}

/** Claude writes the background prompt in the SOURCE's light (the lesson that mattered most). */
async function lightMatchedPrompt({ anthropicKey, brief, frameJpeg, shotFrames }) {
  const fallbackFor = (place) => ({
    prompt: `${place || brief}. Soft, even light that matches a phone video, background strongly out of focus with soft bokeh, muted realistic colours. Natural handheld phone footage.`,
    negative: 'hard sunlight, harsh shadows, oversaturated, cartoon, sharp background, readable text, watermark, water under people, walking on water',
  });
  const fallback = fallbackFor('');
  if (!anthropicKey || (!frameJpeg && !(shotFrames && shotFrames.length))) return { ...fallback, source: 'fallback' };
  const ask = async (correction) => {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-5', max_tokens: 1400, thinking: { type: 'disabled' },
      system: 'You write background prompts for a video inpainting model. The people in the video stay exactly as filmed; the space behind them is REPLACED by a NEW place, shot by shot. The NEW place is the one the user asks for — never the place you see in the frames. Use the frames ONLY for the light and the camera angle; never describe their location, architecture, columns, floors or objects. So the new background must be lit like the ORIGINAL frames or the composite looks fake: match brightness, light softness/hardness, colour temperature, light direction, how blurred the background is. Never describe the people. Never ask for readable text or signs.\n'
        + 'You get one frame per shot. Write ONE shared base prompt for the place and its light, plus a short addition per shot saying what this camera angle shows: which way the camera looks (along the street, towards a wall, across), and what is directly under, in front of and behind the people. RULE: wherever people stand or walk (and the floor visible around their feet or below the frame edge) is solid ground — a street, quay, pavement or floor. Water, drops, roads with traffic or sky are only to the side or further back, never under or directly in front of a person.\n'
        + 'Write everything in English, whatever language the request is in. "place" is the NEW place in 2-6 plain English words, and the base prompt must use those words.\n'
        + 'Return ONLY JSON: {"place":"2-6 English words","prompt":"base, 50-90 words","negative":"10-25 words, include anything clashing with the original light and \'water under people, walking on water\'","shots":[{"shot":1,"add":"10-30 words"}, ...]}',
      messages: [{ role: 'user', content: [
        { type: 'text', text: `NEW PLACE (describe this, not the frames' location): ${brief}` },
        ...(shotFrames && shotFrames.length ? shotFrames : [{ shot: 1, jpeg: frameJpeg }]).flatMap((f) => [
          { type: 'text', text: `Shot ${f.shot}:` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.jpeg.toString('base64') } },
        ]),
        { type: 'text', text: `Write the base prompt for the NEW PLACE — ${brief} — lit like these frames, and one addition per shot (camera angle + solid ground under/in front of the people, in the NEW place).`
          + (correction ? `\nYour previous answer described the wrong place ("${correction}"). Describe the NEW PLACE above, not what is in the frames.` : '') },
      ] }],
    }, { headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 60000 });
    const text = (r.data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  };
  let place = '', rejected = '';
  try {
    // Guard (2026-10-18): with eight frames Claude once described the ORIGINAL station and dropped the brief.
    // A prompt that does not name the place gets ONE more try with the mistake pointed out, then the fallback.
    for (let attempt = 0; attempt < 2; attempt++) {
      const j = await ask(attempt ? rejected.slice(0, 160) : '');
      place = String(j.place || place || '').slice(0, 80);
      if (!(j.prompt && j.prompt.length > 20)) continue;
      if (!namesPlace(j.prompt, brief, place)) {
        rejected = String(j.prompt).slice(0, 300);
        console.warn(`[bgcutout] prompt ignored the place (attempt ${attempt + 1}):`, rejected.slice(0, 120));
        continue;
      }
      const shots = {}; for (const x of Array.isArray(j.shots) ? j.shots : []) if (x && x.shot && x.add) shots[Number(x.shot)] = String(x.add).slice(0, 300);
      return { prompt: j.prompt, negative: j.negative || fallback.negative, shots, place, source: 'claude', ...(attempt ? { retried: true, rejected } : {}) };
    }
  } catch (e) { console.warn('[bgcutout] prompt writer failed, fallback used:', e.message); }
  // English place phrase when Claude gave one (a Dutch brief must not reach the video model raw)
  return { ...fallbackFor(place), shots: {}, source: 'fallback', ...(rejected ? { rejected } : {}) };
}

/**
 * The job. ctx: { videoUrl, brief, falKey, anthropicKey, publish(file, contentType) → public URL,
 * update(fields) } → { resultFile, prompt, shots, cost }.
 */
async function runBgCutout(ctx) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgcut_'));
  const step = (s, extra) => ctx.update({ step: s, ...(extra || {}) });
  const encs = [], track = (e) => (encs.push(e), e);   // killed on error, so no ffmpeg waits on stdin forever
  try {
    step('download');
    const raw = path.join(tmp, 'raw.mp4'); await download(ctx.videoUrl, raw);
    let info = await probe(raw);
    if (!info.W) throw new Error('could not read the video');
    // VACE's top resolution is 720p: normalise to ≤720 px wide (even sizes), ≤30 fps, constant frame rate.
    const src = path.join(tmp, 'src.mp4');
    const fps = Math.min(30, Math.round(info.fps) || 24);
    await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', raw, '-vf', `scale='min(720,iw)':-2,fps=${fps}`, '-an', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
    const { W, H } = await probe(src);
    const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(await ffInfo(src));
    const dur = dm ? dm.slice(1).reduce((t, v, i) => t + Number(v) * [3600, 60, 1][i], 0) : 0;
    if (!dur) throw new Error('could not read the video length');
    if (dur > 16) throw new Error(`The video is ${dur.toFixed(1)} s; the cut-out swap handles up to 16 s for now.`);

    step('mask');

    // fal gets its OWN copy: the temp-video store unlinks published files after 30 min, and the
    // composite step re-reads src.mp4 much later (reviewer 2026-10-18).
    const srcFal = path.join(tmp, 'src_fal.mp4'); fs.copyFileSync(src, srcFal);
    const srcUrl = ctx.publish(srcFal, 'video/mp4');
    const maskRes = await falRun(ctx.falKey, 'fal-ai/birefnet/v2/video', { video_url: srcUrl, model: 'Matting', operating_resolution: '1024x1024', output_mask: true, refine_foreground: false, video_output_type: 'X264 (.mp4)', video_quality: 'maximum' });
    const maskUrl = maskRes && maskRes.mask_video && maskRes.mask_video.url;
    if (!maskUrl) throw new Error('BiRefNet returned no mask video');
    const maskRaw = path.join(tmp, 'mask_raw.mp4'); await download(maskUrl, maskRaw);
    const mask = path.join(tmp, 'mask.mp4');
    await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', maskRaw, '-vf', `scale=${W}:${H},fps=${fps},format=gray`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', mask]);


    step('cuts');
    // Cut detection on a 90x160 copy (a full-res copy of every frame would need ~800 MB on Railway).
    const small = await readFrames(src, 90, 160, 0, 100000, false, true);
    const N = small.length;
    const diffs = [];
    for (let i = 1; i < N; i++) { let s = 0; const a = small[i], b = small[i - 1]; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); diffs.push(s / a.length); }
    const cuts = detectCuts(diffs, N);
    const shots = cuts.slice(0, -1).map((a, j) => ({ j, a, b: cuts[j + 1] }));
    const longest = shots.reduce((m, sh) => Math.max(m, sh.b - sh.a), 0);
    if (longest > VACE_MAX_FRAMES) throw new Error(`One uncut shot is ${(longest / fps).toFixed(1)} s; the background model handles up to ${((VACE_MAX_FRAMES - 1) / fps).toFixed(1)} s without a cut. Trim it or pick a video with cuts.`);
    const maskCount = (await readFrames(mask, 90, 160, 0, 100000, true, true)).length;
    if (maskCount < N) throw new Error(`mask has ${maskCount} frames, video ${N}`);

    // The prompt is written AFTER the fal mask (the analyser has no auth; a bad fal key fails there, before
    // the owner's Anthropic key is spent), and from ONE frame per shot so each angle gets its own ground
    // (2026-10-18: one shared prompt put the canal right in front of a man walking away from the camera).
    step('prompt');
    const shotFrames = [];
    for (const sh of shots.slice(0, 12)) {
      const t = ((sh.a + sh.b) / 2) / fps;
      const jpeg = await run('ffmpeg', ['-loglevel', 'error', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', 'scale=360:-2', '-f', 'mjpeg', '-q:v', '4', '-']).catch(() => null);
      if (jpeg && jpeg.length) shotFrames.push({ shot: sh.j + 1, jpeg });
    }
    const prompt = await lightMatchedPrompt({ anthropicKey: ctx.anthropicKey, brief: ctx.brief, shotFrames });
    ctx.update({ prompt });

    step('backgrounds', { shots: shots.length });
    // Inputs are built one shot at a time (memory); the VACE calls then run in parallel.
    for (const sh of shots) {
      const gf = path.join(tmp, `grey${sh.j}.mp4`), mf = path.join(tmp, `inv${sh.j}.mp4`);
      const ge = track(encoder(gf, W, H, fps)), me = track(encoder(mf, W, H, fps, true));
      let last = null, written = 0;
      for (let c0 = sh.a; c0 < sh.b; c0 += CHUNK) {
        const c1 = Math.min(sh.b, c0 + CHUNK);
        const fr = await readFrames(src, W, H, c0, c1), mk = await readFrames(mask, W, H, c0, c1, true);
        for (let k = 0; k < fr.length; k++) { last = vaceInputs(fr[k], mk[k], W, H); await ge.write(last.grey); await me.write(last.inv); written++; }
      }
      while (written < VACE_MIN_FRAMES && last) { await ge.write(last.grey); await me.write(last.inv); written++; }   // pad short shots to VACE's floor
      await ge.end(); await me.end();
      sh.gf = gf; sh.mf = mf;
    }
    let done = 0;
    const bgFiles = await Promise.all(shots.map(async (sh) => {
      const gf = sh.gf, mf = sh.mf;
      const r = await falRun(ctx.falKey, 'fal-ai/wan-vace-14b/inpainting', {
        prompt: prompt.prompt + (prompt.shots && prompt.shots[sh.j + 1] ? ' ' + prompt.shots[sh.j + 1] : ''), negative_prompt: prompt.negative, video_url: ctx.publish(gf, 'video/mp4'), mask_video_url: ctx.publish(mf, 'video/mp4'),
        match_input_num_frames: true, match_input_frames_per_second: true, resolution: '720p', aspect_ratio: H >= W ? '9:16' : '16:9',
        video_quality: 'maximum', enable_prompt_expansion: false, seed: 4242,
      });
      const url = r && r.video && r.video.url; if (!url) throw new Error(`VACE returned no video for shot ${sh.j + 1}`);
      const bf = path.join(tmp, `bg${sh.j}.mp4`); await download(url, bf);
      const bfn = path.join(tmp, `bgn${sh.j}.mp4`);
      await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', bf, '-vf', `scale=${W}:${H},fps=${fps}`, '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', bfn]);
      step('backgrounds', { shots: shots.length, shotsDone: ++done });
      return bfn;
    }));

    step('composite');
    const outV = path.join(tmp, 'comp.mp4'), enc = track(encoder(outV, W, H, fps));
    const shotLog = [];
    for (const sh of shots) {
      const nBg = (await readFrames(bgFiles[sh.j], 90, 160, 0, 100000, true, true)).length;
      if (!nBg) throw new Error(`empty background for shot ${sh.j + 1}`);
      // a background that came back shorter than the shot freezes on its last frame; say so in the log
      const bgIdx = (i) => Math.min(i - sh.a, nBg - 1);
      // Chunked (memory): each chunk reads one extra mask frame either side for the temporal smoothing.
      const chunk = async (c0, c1) => {
        const fr = await readFrames(src, W, H, c0, c1);
        const mk = await readFrames(mask, W, H, Math.max(sh.a, c0 - 1), Math.min(sh.b, c1 + 1), true);
        const off = c0 - Math.max(sh.a, c0 - 1);
        const bg = await readFrames(bgFiles[sh.j], W, H, bgIdx(c0), bgIdx(c1 - 1) + 1);
        const mattes = fr.map((_, k) => matteClean(firmMatte(mk[k + off], mk[k + off - 1] || null, mk[k + off + 1] || null), W, H));
        return { fr, bg: (k) => bg[Math.min(bgIdx(c0 + k) - bgIdx(c0), bg.length - 1)], mattes };
      };
      // pass 1: light match from every 4th frame
      const oS = [0, 0, 0], nS = [0, 0, 0]; let c = 0;
      for (let c0 = sh.a; c0 < sh.b; c0 += CHUNK) {
        const ch = await chunk(c0, Math.min(sh.b, c0 + CHUNK));
        for (let k = (4 - ((c0 - sh.a) % 4)) % 4; k < ch.fr.length; k += 4) { const o = ringMean(ch.fr[k], ch.mattes[k], W, H), nn = ringMean(ch.bg(k), ch.mattes[k], W, H); for (let q = 0; q < 3; q++) { oS[q] += o[q]; nS[q] += nn[q]; } c++; }
      }
      const light = lightParams(oS.map((v) => v / Math.max(c, 1)), nS.map((v) => v / Math.max(c, 1)));
      shotLog.push({ shot: sh.j + 1, frames: sh.b - sh.a, bgFrames: nBg, ...Object.fromEntries(Object.entries(light).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) });
      // pass 2: composite
      for (let c0 = sh.a; c0 < sh.b; c0 += CHUNK) {
        const ch = await chunk(c0, Math.min(sh.b, c0 + CHUNK));
        for (let k = 0; k < ch.fr.length; k++) await enc.write(compositeFrame(ch.fr[k], ch.bg(k), ch.mattes[k], W, H, light));
      }
      step('composite', { shotsComposited: sh.j + 1 });
    }
    await enc.end();
    const result = path.join(tmp, 'result.mp4');
    if (info.audio) await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', outV, '-i', raw, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', result]);
    else await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', outV, '-c', 'copy', '-movflags', '+faststart', result]);
    const vaceSeconds = shots.reduce((s, sh) => s + Math.max(sh.b - sh.a, VACE_MIN_FRAMES) / fps, 0);
    return { resultFile: result, tmpDir: tmp, prompt, shots: shotLog, size: `${W}x${H}`, fps, costUsd: Math.round(vaceSeconds * 0.08 * 100) / 100 };
  } catch (e) {
    encs.forEach((x) => x.kill());
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}

module.exports = { runBgCutout, encoder, probe, lightMatchedPrompt, namesPlace, guardWords, detectCuts, firmMatte, matteClean, lightParams, compositeFrame, vaceInputs, boxBlur1, ringMean };
