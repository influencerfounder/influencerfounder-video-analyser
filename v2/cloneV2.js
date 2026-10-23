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
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { writerSystem, validateSpec, parseSpec } = require('./spec');
const { compile } = require('./compile');
const { pickCastChanges } = require('./castChange');

const V2_VERSION = 'v2-1.9.0';
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
    // Matched by VALUE, not by string (/toolscan 2026-10-09): JS sends String(2) = "2" but cutflow.py keys
    // its reply str(float("2")) = "2.0", so every whole-second candidate missed its verdict and motion
    // there was judged a cut again.
    const fk = Object.keys(ratios).find(k => Math.abs(Number(k) - t) < 0.005);
    const fr = fk === undefined ? undefined : ratios[fk];
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
async function sheets(ff, video, duration, dir, maxFrames = 96) {
  const rate = Math.min(4, maxFrames / Math.max(duration, 1));
  const pat = path.join(dir, 'sheet-%02d.jpg');
  await run(ff, ['-v', 'error', '-i', video, '-vf', `fps=${rate},scale=240:-2,tile=4x2:padding=4:color=white`, '-q:v', '5', '-y', pat], { timeout: 120000 });
  const files = fs.readdirSync(dir).filter(f => /^sheet-\d+\.jpg$/.test(f)).sort();
  return files.map((f, k) => ({
    buf: fs.readFileSync(path.join(dir, f)),
    times: Array.from({ length: 8 }, (_, j) => Math.round(((k * 8 + j) / rate) * 100) / 100).filter(t => t < duration),
  }));
}

// ⏱ RUN BUDGET (/toolscan 2026-10-09). The tool waits 290 s for this route (recreate-v2/analyse), but
// the writer alone could take 240 s + a 240 s fallback + a repair round + the outfit pick — paid calls
// on the owner's Anthropic key that kept running for minutes after the Lab had shown "failed". Every
// call now gets only what is left of V2_BUDGET_MS, and none starts with less than WRITER_MIN_MS left.
// ⚠️ The tool's axios timeout must stay above this — test/v2-budget.selftest.js reads both files.
const V2_BUDGET_MS = 270000;
const WRITER_MIN_MS = 20000;
function outOfTime() { const e = new Error('The analysis ran out of time — try again.'); e.code = 'out_of_time'; return e; }
// 💳 WHO PAYS (Mike, 2026-10-11: "build it and open the tool for everyone"). A student's analysis runs on
// THEIR Kie.ai credits through Kie's Claude gateway (the classic /api/clone path has done this since
// 2026-07-17); only the owner's own account uses the owner's ANTHROPIC_API_KEY. There is no fallback from a
// student's Kie call onto the owner's key. Kie took the full image set in one call (test A, 2026-10-11:
// 42 images / 4.15 MB → 200 in 31 s), so students get the same images as the owner.
const KIE_CLAUDE_URL = 'https://api.kie.ai/claude/v1/messages';
function kieWriterError(status, data) {
  const code = Number((data && (data.code || (data.error && data.error.status))) || status) || status;
  const msg = String((data && (data.msg || data.message || (data.error && data.error.message))) || '').slice(0, 160);
  if (code === 401 || code === 403) return Object.assign(new Error('Your Kie.ai key was refused — check it in the tool (🔑 Kie.ai key) and try again.'), { code: 'kie_key' });
  if (code === 402 || /credit|balance|insufficient/i.test(msg)) return Object.assign(new Error('Your Kie.ai balance is too low for this analysis — top up at kie.ai and try again.'), { code: 'kie_balance' });
  return null;
}
async function callWriter({ system, content, key, kieKey = '', maxTokens = 8000, deadline = 0 }) {
  const timeoutFor = () => {
    const left = deadline ? deadline - Date.now() : 240000;
    if (left < WRITER_MIN_MS) throw outOfTime();
    return Math.min(240000, left);
  };
  const viaKie = !!kieKey;
  // thinking:{disabled} IS sent to Kie (2026-10-11): the classic /api/clone Kie path sends it in production. A
  // first guess that it caused Kie's 500 "Server exception" was disproven — the re-run without it got the same
  // 500 — so it stays off, which also keeps the answer short.
  const tokens = maxTokens;
  const body = (model, noThinking = false) => ({
    model, max_tokens: tokens, system,
    ...(/^claude-(sonnet-5|opus-5)/.test(model) ? (noThinking ? {} : { thinking: { type: 'disabled' } }) : { temperature: 0.2 }),
    messages: [{ role: 'user', content }],
  });
  const url = viaKie ? KIE_CLAUDE_URL : 'https://api.anthropic.com/v1/messages';
  const headers = viaKie ? { Authorization: `Bearer ${kieKey}`, 'Content-Type': 'application/json' }
    : { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  const send = async (model) => {
    const opts = { headers, timeout: timeoutFor(), validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity };
    let r = await axios.post(url, body(model), opts);
    // Kie's relay may not pass Anthropic's `thinking` field — one retry without it (a Sonnet 5 call then
    // thinks adaptively, which the 8000-token budget absorbs).
    if (viaKie && r.status === 400 && /thinking/i.test(JSON.stringify(r.data || {}))) r = await axios.post(url, body(model, true), { ...opts, timeout: timeoutFor() });
    // Kie answers 200 with the error in the body (reference_kie_200_with_error_body): no content = a failure.
    if (viaKie && r.status === 200 && !Array.isArray(r.data && r.data.content)) r = { status: Number(r.data && r.data.code) || 502, data: r.data };
    if (viaKie && r.status !== 200) { const e = kieWriterError(r.status, r.data); if (e) throw e; }
    return r;
  };
  let r = await send(WRITER_MODEL);
  let model = WRITER_MODEL;
  if (r.status !== 200) {
    console.warn(`[clone-v2] writer ${WRITER_MODEL}${viaKie ? ' (Kie)' : ''} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)} — falling back to ${FALLBACK_MODEL}`);
    r = await send(FALLBACK_MODEL);
    model = FALLBACK_MODEL;
    if (r.status !== 200) console.warn(`[clone-v2] writer ${FALLBACK_MODEL}${viaKie ? ' (Kie)' : ''} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  if (r.status !== 200) throw Object.assign(new Error(viaKie ? 'Kie.ai\'s AI is busy right now — try again in a minute.' : `writer ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`), { detail: JSON.stringify(r.data).slice(0, 200) });
  const text = (r.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return { text, model, usage: r.data.usage || null, stop: r.data.stop_reason, payer: viaKie ? 'kie' : 'owner' };
}

// 🔀 STUDENT WRITER = GEMINI ON KIE + A CLAUDE HOOK PASS (Mike, 2026-10-11: "Yes" to "Gemini for the shot list,
// Claude for the hook only"; "Doesn't matter that it doesn't match mine"). Measured the same day on the master Kie
// key: Kie's Claude gateway fails long answers (500 "Server exception" at 95–111 s, `no_available_account`) and
// refused parts of a split spec, while Kie's Gemini 3.8 Flash took the same 42 images + facts and wrote a full
// spec every time (6/6, 22–25 s, ~$0.012). Gemini's hook was coarser (3 movements vs Claude's 5 on the same
// facts), so one SHORT Claude call — the shape Kie's Claude handles (classic path, test T1) — rewrites the hook
// stretch from the dense hook frames. If that call fails, Gemini's hook stays: the analysis never breaks on it.
const KIE_GEMINI_MODEL = process.env.V2_KIE_WRITER_MODEL || 'gemini-3-8-flash-openai';
function toOpenAiContent(content) {
  return (content || []).map((c) => {
    if (!c) return null;
    if (c.type === 'text') return { type: 'text', text: c.text };
    if (c.type === 'image' && c.source) return { type: 'image_url', image_url: { url: c.source.type === 'base64' ? `data:${c.source.media_type || 'image/jpeg'};base64,${c.source.data}` : c.source.url } };
    return null;
  }).filter(Boolean);
}
async function callGeminiKie({ system, content, kieKey, maxTokens = 16000, deadline = 0, model = KIE_GEMINI_MODEL }) {
  const left = deadline ? deadline - Date.now() : 240000;
  if (left < WRITER_MIN_MS) throw outOfTime();
  const url = `https://api.kie.ai/${model}/v1/chat/completions`;
  const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: toOpenAiContent(content) }], stream: false, max_tokens: maxTokens, reasoning_effort: 'low' };
  const r = await axios.post(url, body, { headers: { Authorization: `Bearer ${kieKey}`, 'Content-Type': 'application/json' }, timeout: Math.min(240000, left), validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity });
  const d = r.data || {};
  const ch = (Array.isArray(d.choices) ? d.choices : [])[0];
  // Kie answers errors as HTTP 200 + {code, msg} (docs.kie.ai).
  if (r.status !== 200 || !ch || !ch.message) {
    const e = kieWriterError(Number(d.code) || r.status, d);
    if (e) throw e;
    throw Object.assign(new Error('Kie.ai\'s AI is busy right now — try again in a minute.'), { detail: JSON.stringify(d).slice(0, 200) });
  }
  return { text: String(ch.message.content || ''), model, usage: d.usage || null, stop: ch.finish_reason || null, credits: d.credits_consumed ?? null, payer: 'kie' };
}
// The HOOK pass: ONE short Claude call rewrites only SHOT 1's movement list (+ its size, angle, camera, end
// state) from the dense hook frames. The answer must stay small: a first version asked for the whole stretch to
// Gemini's next shot with every field (~4,000 tokens) and Kie's Claude writes slowly — 76 s, then a 110 s
// timeout on the third live run (2026-10-11). ~500 tokens now. Everything after the hook stays Gemini's.
// Returns { spec } with shot 1 replaced, or { spec: null } when the pass failed (the caller keeps Gemini's).
async function refineHookViaKieClaude({ system, facts, sheets, hookFrames, spec, kieKey, deadline, hookSecs }) {
  if (!deadline || deadline - Date.now() < 45000) return { spec: null, error: 'not enough time left for the hook pass' };
  const shots = Array.isArray(spec.shots) ? spec.shots : [];
  if (!shots.length) return { spec: null, error: 'no shots' };
  const img = (buf) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
  const end = shots[1] ? Number(shots[1].start) : hookSecs;
  const usedSheets = (sheets || []).filter((x) => Number(x.times[0]) < Math.max(end, hookSecs)).slice(0, 3);
  const content = [{ type: 'text', text: facts }];
  usedSheets.forEach((x, k) => { content.push({ type: 'text', text: `CONTACT SHEET ${k + 1} (left→right, top→bottom) at ${x.times.join(', ')} s:` }); content.push(img(x.buf)); });
  content.push({ type: 'text', text: `DENSE HOOK FRAMES (full size), at ${hookFrames.map((h) => h.t).join(', ')} s — compare each with the next to catch every small movement:` });
  hookFrames.forEach((h) => content.push(img(h.b)));
  content.push({ type: 'text', text: `HOOK PASS. Another analyst's shot 1 (0 to ${end} s) is: ${JSON.stringify(shots[0])}. Its cast: ${JSON.stringify(spec.cast || [])}. `
    + `Rewrite ONLY shot 1 with the full care of rule 4: list EVERY movement of MAIN from 0 to ${end} s, in order, from the dense hook frames (small ones too: a hand to the face, a head turn, a wave). `
    + 'Return ONLY {"main_events":[...],"size":"","angle":"","camera":{"move":"","direction":""},"end_state":""} — nothing else.' });
  let w;
  try { w = await callWriter({ system, content, kieKey, deadline, maxTokens: 1200 }); }
  catch (e) { return { spec: null, error: String(e.message || e).slice(0, 160) }; }
  const j = parseSpec(w.text);
  if (!j || !Array.isArray(j.main_events) || !j.main_events.length) return { spec: null, error: 'the hook pass returned no usable hook', w };
  const s1 = { ...shots[0], main_events: j.main_events.map(String) };
  for (const k of ['size', 'angle', 'end_state']) if (j[k]) s1[k] = String(j[k]);
  if (j.camera && typeof j.camera === 'object' && j.camera.move) s1.camera = { move: String(j.camera.move), direction: String(j.camera.direction || '') };
  return { spec: { ...spec, shots: [s1, ...shots.slice(1)] }, w };
}

// 🔎 SECOND OPINION — owner only (Mike, 2026-10-11: "Don't need to be a tick can do this as default owner only").
// Gemini watches the SOURCE VIDEO itself (the 2026-10-04 shot logger, owner's GEMINI_API_KEY, ~$0.03) in parallel
// with the writer; then ONE short Claude call is the JUDGE: it sees the shot list, Gemini's MAIN actions and the
// contact sheets + hook frames, and adds only moments that are clearly visible AND missing — never a duplicate in
// other words, never a new person or prop — at most 4 per video (the guards: doubled actions break the hook's
// timing, an invented moment makes the video do something the original never did, every word dilutes the rest).
// What it added is returned (secondOpinion.added) and shown in the Lab. Fail-open: any failure = the spec as written.
const SECOND_OPINION_MAX = 4;
const JUDGE_SYSTEM = `You are the second-opinion judge of a video-recreation tool. An analyst wrote a shot list (each shot: start time + MAIN's actions, in order). A second analyst (who watched the video itself) logged a timeline of actions. Your job: find MAIN's movements that the shot list MISSED, check each against the frames, and add only those that are clearly visible.
RULES
1. Add only a movement of MAIN that is clearly visible in the frames AND not already in that shot's list in other words ("covers mouth" = "hand over the mouth" — that is a duplicate, never add it).
2. Never add a new person, prop, location, camera move or anything the frames do not show. Never remove or reword existing actions.
3. At most ${SECOND_OPINION_MAX} additions in total, most important first (the hook — shot 1 — matters most).
4. Short present-tense actions with simple verbs; LEFT/RIGHT = the viewer's screen; refer to the person as MAIN.
Return ONLY JSON: {"shots":[{"start":<the shot's start, exactly as given>,"main_events":[the shot's FULL list with your additions inserted in the right order]}],"added":[{"start":<shot start>,"event":"the added action"}]}. Shots you do not change are left out. If nothing is missing, return {"shots":[],"added":[]}.`;
async function secondOpinionMerge({ spec, log, sheets, hookFrames, key, deadline }) {
  if (!log || !Array.isArray(log.timeline)) return { spec: null, added: [], error: 'no Gemini timeline' };
  // 80 s: the judge stops 60 s before the deadline and needs ~20 s itself — below that, skip it plainly.
  if (!deadline || deadline - Date.now() < 80000) return { spec: null, added: [], error: 'not enough time left for the judge' };
  const shots = Array.isArray(spec.shots) ? spec.shots : [];
  const img = (buf) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
  const mainRows = log.timeline.filter((r) => r && /^main$/i.test(String(r.who || 'MAIN'))).map((r) => ({ start: r.start, end: r.end, action: r.action }));
  const content = [{ type: 'text', text: `THE SHOT LIST (start s → MAIN's actions): ${JSON.stringify(shots.map((x) => ({ start: x.start, main_events: x.main_events || [] })))}` },
    { type: 'text', text: `THE SECOND ANALYST'S TIMELINE OF MAIN: ${JSON.stringify(mainRows).slice(0, 6000)}` }];
  (sheets || []).slice(0, 12).forEach((x) => { content.push({ type: 'text', text: `CONTACT SHEET at ${x.times.join(', ')} s:` }); content.push(img(x.buf)); });
  if ((hookFrames || []).length) { content.push({ type: 'text', text: `DENSE HOOK FRAMES at ${hookFrames.map((h) => h.t).join(', ')} s:` }); hookFrames.slice(0, 8).forEach((h) => content.push(img(h.b))); }
  content.push({ type: 'text', text: 'Judge now. Return only JSON.' });
  let w;
  // The judge must finish 60 s before the run's deadline, so the outfit pick that follows keeps its time.
  try { w = await callWriter({ system: JUDGE_SYSTEM, content, key, deadline: deadline - 60000, maxTokens: 1500 }); }
  catch (e) { return { spec: null, added: [], error: String(e.message || e).slice(0, 160) }; }
  const j = parseSpec(w.text);
  if (!j || !Array.isArray(j.shots)) return { spec: null, added: [], error: 'the judge returned no JSON', w };
  // Apply, guarded IN CODE (reviewer 2026-10-11): the original actions must stay in their ORIGINAL ORDER and
  // COUNT (additions are only slotted between them — a reorder would move the hook's timing); an addition may not
  // repeat itself or an original, name another person (P1… or a cast label) or be longer than a short action;
  // never on a shot where MAIN is not visible; at most SECOND_OPINION_MAX per video.
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const castWords = (Array.isArray(spec.cast) ? spec.cast : []).map((c) => norm(c && c.label)).filter((x) => x.length > 3);
  const otherPerson = (e) => /\bP\d+\b/i.test(e) || castWords.some((c) => norm(e).includes(c));
  let budget = SECOND_OPINION_MAX; const added = []; const out = shots.map((x) => ({ ...x }));
  for (const cs of j.shots) {
    const i = out.findIndex((x) => Math.abs(Number(x.start) - Number(cs && cs.start)) < 0.05);
    if (i < 0 || !Array.isArray(cs.main_events) || out[i].main_visible === false) continue;
    const before = (out[i].main_events || []).map(String), after = cs.main_events.map(String);
    let p = 0; const fresh = [];
    for (const e of after) { if (p < before.length && e === before[p]) p++; else fresh.push(e); }
    if (p !== before.length || !fresh.length || fresh.length > budget) continue;   // order/count kept, something new
    const seen = new Set(before.map(norm));
    const bad = fresh.some((e) => { const n = norm(e); const dup = !n || seen.has(n); seen.add(n); return dup || e.length > 120 || otherPerson(e); });
    if (bad) continue;
    out[i].main_events = after; budget -= fresh.length;
    fresh.forEach((e) => added.push({ start: Number(out[i].start), event: e }));
  }
  return { spec: added.length ? { ...spec, shots: out } : null, added, w };
}

// ⏳ LATE SECOND OPINION (Mike, 2026-10-14: "A plus B"). Measured that day on Railway: 12 of 16 owner analyses
// lost the second opinion to TIME, not to an error — the Instagram download took 55–228 s, Gemini 3.1 Pro preview
// took 95–120+ s in the afternoon (under ~55 s that morning), and the analysis stopped waiting 180 s after its
// start. Now (A) Gemini starts the moment the video is on disk, and (B) the analysis never waits for it: an answer
// that is not in yet is judged in the BACKGROUND and kept here; the tool fetches it
// (GET /api/clone-v2/second-opinion/:id) and applies it to the plan before Generate / Approve. It comes back as
// PATCHES (shot start + its list before and after), so the tool can refuse a shot that changed meanwhile.
// In memory on the one Railway instance: a restart or deploy loses a pending one, and the tool then says so.
const SO_LATE_TTL_MS = 30 * 60000;
const SO_LATE = new Map();
function soPatches(before, after) {
  const a = (after && after.shots) || [];
  return ((before && before.shots) || []).map((x, i) => ({ start: Number(x.start), before: (x.main_events || []).map(String), after: ((a[i] && a[i].main_events) || []).map(String) }))
    .filter((p) => JSON.stringify(p.before) !== JSON.stringify(p.after));
}
function startLateSecondOpinion({ lid, secondP, spec, sheets, hookFrames, key, recompile, store = SO_LATE, merge = secondOpinionMerge }) {
  const t0 = Date.now();
  for (const [k, v] of store) if (t0 - v.at > SO_LATE_TTL_MS) store.delete(k);
  const id = crypto.randomBytes(16).toString('hex');
  const rec = { at: t0, lid: String(lid || ''), status: 'pending' };
  store.set(id, rec);
  const done = (patch) => Object.assign(rec, { added: [], patches: [], prompts: null, error: null }, patch, { status: 'done', doneAt: Date.now() });
  const p = (async () => {
    const g = await Promise.resolve(secondP).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    if (!g || !g.ok) return done({ error: String((g && g.error) || 'Gemini did not answer').slice(0, 160) });
    // The judge gets its own 90 s (secondOpinionMerge stops it 60 s before the deadline given).
    const m = await merge({ spec, log: g.log, sheets, hookFrames, key, deadline: Date.now() + 150000 });
    const ok = !!(m.spec && !validateSpec(m.spec).length);
    let prompts = null;
    if (ok && typeof recompile === 'function') { try { prompts = recompile(m.spec); } catch (_) {} }
    return done({ model: g.model, geminiSecs: g.secs, added: ok ? m.added : [], patches: ok ? soPatches(spec, m.spec) : [], prompts, error: ok ? null : (m.error ? String(m.error).slice(0, 160) : null) });
  })().catch((e) => done({ error: String((e && e.message) || e).slice(0, 160) })).then(() => {
    console.log(`[clone-v2] second opinion (late, ${Math.round((rec.doneAt - t0) / 1000)} s after the analysis, ${id.slice(0, 8)}): ${rec.added.length} added${rec.error ? ' (' + rec.error + ')' : ''}${rec.added.length ? ' — ' + rec.added.map((a) => `[${a.start}s] ${String(a.event || '').replace(/\s+/g, ' ').slice(0, 160)}`).join(' | ') : ''}`);
  });
  return { id, done: p };
}
function lateSecondOpinionView(rec) {
  if (rec.status === 'pending') return { success: true, status: 'pending', waitedSecs: Math.round((Date.now() - rec.at) / 1000) };
  return { success: true, status: 'done', model: rec.model || null, geminiSecs: rec.geminiSecs || null, added: rec.added, patches: rec.patches, prompts: rec.prompts, error: rec.error };
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

// A pick as models actually write it: the index may arrive as a numeric string, the box in 0–1 fractions instead
// of percent (Gemini on Kie, 2026-10-11). Normalised to {index: integer, box: [x0,y0,x1,y1] in percent}, or null.
function normPick(p) {
  if (!p || typeof p !== 'object') return null;
  const index = Number(p.index);
  if (!Number.isInteger(index) || index < 0) return null;
  let box = Array.isArray(p.box) ? p.box.map(Number) : null;
  if (!box || box.length !== 4 || box.some((x) => !Number.isFinite(x))) return null;
  if (box.every((x) => x >= 0 && x <= 1)) box = box.map((x) => Math.round(x * 1000) / 10);
  else if (box.some((x) => x > 100) && box.every((x) => x >= 0 && x <= 1000)) box = box.map((x) => Math.round(x) / 10);   // Gemini's native 0-1000
  return { index, box };
}
// 🎬 OPENING CANDIDATES (2026-10-16, Mike: "it must be a frame from within the hook … as far in the beginning as
// possible. But if there's no person in the first three seconds, then maybe it's different"). The first frame of the
// remake is a swap into ONE frame of the original, and the video starts exactly there — so the candidates come only
// from the first 3 s (the hook), earliest first, and only frames where MAIN can actually be swapped. A door case on
// 2026-10-16 (Kryfex as a dim reflection behind glass) showed why "small" was not enough: a person you cannot read
// cannot be swapped well, so that frame is OBSCURED and never a candidate. The tool picks the earliest candidate by
// default and moves the shot plan to start there; Mike can pick another one or go without a first frame.
const OPENING_PICK_SYSTEM = `You judge the first seconds of a short video for ONE thing: in which frames can the main person (MAIN, described below) be cleanly replaced by another person in a still image. For EVERY frame give "main":
- "clear": MAIN is plainly visible — face readable (front, three-quarter or profile), body not mostly cut off, not behind glass or in a reflection. MAIN's OWN hand, sunglasses, hat or hair partly over the face while doing something (shielding the face from cameras, waving, fixing the hair, drinking) is part of the pose, not a reason to skip the frame: still "clear" (or "small" when distant);
- "small": MAIN is clearly visible and readable but small or distant (a whole person in a wide shot);
- "obscured": MAIN is there but cannot be read well: behind glass, a window or a screen, only a reflection, a dark silhouette against the light, face turned fully away or hidden by something else (another person, an object in front), heavily blurred, or mostly cut off by the frame or by something in front;
- "absent": MAIN is not in the frame.
And "where": one short line that would let someone point at MAIN in that frame (position, size, a visible attribute) — never the word MAIN; "" when absent.
Return ONLY JSON: {"frames":[{"i":0,"main":"clear|small|obscured|absent","where":""}]} with one entry per frame, in order.`;
const OPENING_WINDOW = 3;     // the hook: candidates only from the first 3 s
const OPENING_MAX = 3;        // at most 3 to choose from (Mike: too many was too much)
const OPENING_GAP = 0.35;     // candidates at least this far apart
function openingCandidateTimes(duration) {
  const end = Math.min(OPENING_WINDOW, Math.max(0.5, Number(duration) - 0.5));
  const out = [0.05];
  for (let t = 0.4; t <= end + 1e-9 && out.length < 8; t += 0.4) out.push(Math.round(t * 100) / 100);
  return out;
}
/** Pure: the judged frames → the candidates, earliest first (clear or small only), spaced, capped. */
function chooseOpenings(times, judged) {
  const rows = (Array.isArray(judged) ? judged : []).map((r, k) => ({ i: Number.isFinite(+r.i) ? +r.i : k, main: String(r.main || '').toLowerCase(), where: String(r.where || '').replace(/\s+/g, ' ').trim().slice(0, 200) }));
  const out = [];
  for (const r of rows.sort((a, b) => a.i - b.i)) {
    const t = times[r.i];
    if (t === undefined || (r.main !== 'clear' && r.main !== 'small')) continue;
    if (out.length && t - out[out.length - 1].t < OPENING_GAP) continue;
    out.push({ t, main: r.main, where: r.where });
    if (out.length >= OPENING_MAX) break;
  }
  return out;
}
// Who MAIN is, in words the judge can point with (the opening frames and a hand-picked moment use the same lines).
function openingWho(spec, mainHint = '') {
  const o = (spec && spec.outfit) || {};
  const s0 = (spec && Array.isArray(spec.shots) && spec.shots[0]) || {};
  const lines = [`MAIN wears: ${o.top_name || '?'}${o.bottom ? ', ' + o.bottom : ''}.`, spec && spec.opening && spec.opening.main_where ? `In the very first frame MAIN is: ${spec.opening.main_where}.` : '', (s0.main_events || []).length ? `At the start MAIN: ${(s0.main_events || []).slice(0, 2).join('; ')}.` : ''].filter(Boolean).join(' ');
  const hint = String(mainHint || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return hint ? `MAIN is: ${hint}. ${lines}` : lines;
}
/** The opening judge on one or more frames ({t, b: jpeg}) → { j: {frames:[…]}, w } or null. */
async function judgeOpeningFrames({ who, frames, key, kieKey = '', deadline = 0 }) {
  const content = [{ type: 'text', text: who }];
  frames.forEach((f, i) => { content.push({ type: 'text', text: `Frame ${i} at ${f.t} s:` }); content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.b.toString('base64') } }); });
  let w;
  try {
    w = kieKey ? await callGeminiKie({ system: OPENING_PICK_SYSTEM, content, kieKey, maxTokens: 2000, deadline })
      : await callWriter({ system: OPENING_PICK_SYSTEM, content, key, maxTokens: 700, deadline });
  } catch (e) { console.warn('[clone-v2] opening pick failed:', e.message); return null; }
  const j = parseSpec(w.text) || {};
  if (!Array.isArray(j.frames)) { console.warn('[clone-v2] opening pick unusable:', String(w.text || '').slice(0, 200)); return null; }
  return { j, w };
}
async function pickOpenings({ spec, ff, video, tmp, key, kieKey = '', duration, deadline = 0 }) {
  const times = openingCandidateTimes(duration);
  const frames = [];
  for (const t of times) { const b = await frameAt(ff, video, t, 480, path.join(tmp, `open-${t}.jpg`)); if (b) frames.push({ t, b }); }
  if (!frames.length) return null;
  const useTimes = frames.map(f => f.t);
  const who = openingWho(spec);
  const jw = await judgeOpeningFrames({ who, frames, key, kieKey, deadline });
  if (!jw) return null;
  const { j, w } = jw;
  const picks = chooseOpenings(useTimes, j.frames);
  const candidates = [];
  for (const c of picks) {
    const full = await fullFramePng(ff, video, c.t, path.join(tmp, `opening-${c.t}.png`));
    if (full) candidates.push({ ...c, size: [full.W, full.H], png: fs.readFileSync(full.path).toString('base64') });
  }
  return { candidates, judged: j.frames.map((r, k) => ({ t: useTimes[+r.i] ?? useTimes[k], main: r.main })), writer: w.model };
}

async function pickOutfit({ spec, ff, video, tmp, key, kieKey = '', duration, deadline = 0 }) {
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
  // A student's own Kie key: Gemini first (~10 s; its native 0-1000 boxes are read by normPick), with a short
  // Claude-on-Kie call as the fallback only while time is left (Kie's Claude is slow: 2026-10-11 it timed out
  // the hook pass and left the pick no time). Owner: Claude on Anthropic, as before.
  const usable = (pk) => ['front', 'back'].some((sd) => { const q = normPick(pk && pk[sd]); return q && cand[q.index] && cand[q.index].side === sd; });
  let w = kieKey ? await callGeminiKie({ system: OUTFIT_PICK_SYSTEM, content, kieKey, maxTokens: 3000, deadline }).catch((e) => ({ text: '', model: KIE_GEMINI_MODEL, error: e.message }))
    : await callWriter({ system: OUTFIT_PICK_SYSTEM, content, key, maxTokens: 600, deadline });
  let pick = parseSpec(w.text) || {};
  if (kieKey && !usable(pick) && deadline - Date.now() > 60000) {
    console.warn(`[clone-v2] Gemini outfit pick unusable (${String(w.error || w.text || '').replace(/\s+/g, ' ').slice(0, 200)}) — trying Claude on Kie`);
    try { w = await callWriter({ system: OUTFIT_PICK_SYSTEM, content, kieKey, maxTokens: 600, deadline }); pick = parseSpec(w.text) || {}; } catch (e) { w = { ...w, error: e.message }; }
  }
  const out = { front: null, back: null, writer: w.model };
  if (!usable(pick)) out.reason = 'the outfit pick returned no usable crop — use Replace to upload the outfit, or analyse again';
  for (const side of ['front', 'back']) {
    const p = normPick(pick[side]);
    const c = p ? cand[p.index] : null;
    if (!c || c.side !== side) continue;
    const full = await fullFramePng(ff, video, c.t, path.join(tmp, `full-${side}.png`));
    if (!full) continue;
    const r = cropRect(p.box, full.W, full.H);
    if (!r) continue;
    const crop = path.join(tmp, `outfit-${side}.png`);
    await run(ff, ['-v', 'error', '-i', full.path, '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}`, '-y', crop], { timeout: 20000 });
    if (fs.existsSync(crop)) out[side] = { t: c.t, box: p.box, px: r, sourceSize: [full.W, full.H], png: fs.readFileSync(crop).toString('base64') };
  }
  if (!out.front && !out.back && !out.reason) {
    out.reason = 'the outfit crop failed — use Replace to upload the outfit, or analyse again';
    console.warn(`[clone-v2] outfit crops empty from a usable pick (${w.model}): ${JSON.stringify(pick).slice(0, 300)}`);
  }
  return out;
}

function mount(app, deps) {
  const { downloadInstagramViaApify, downloadTikTok, detectBeats, tempVideos, cleanOldTempVideos, PYTHON, ffmpegBin, hookMotionScript, geminiShotLog } = deps;
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
        camera: Array.isArray(b.camera) ? b.camera : null, durationSec: Number(b.durationSec) || 0, refs,
        unfocus: b.unfocus === true, focus: Array.isArray(b.focus) ? b.focus.slice(0, 10) : [],
        ...(b.productOnly === true ? { productOnly: true, productName: String(b.productName || '').slice(0, 80) } : {}) });
      res.json({ success: true, version: V2_VERSION, ...out });
    } catch (e) { res.status(500).json({ success: false, error: String(e.message || e).slice(0, 200) }); }
  });

  // 🎯 PICK A MOMENT (2026-10-17, Mike: "how can I select another first frame image?"). The opening judge only looks
  // at the first 3 s and offers at most 3 frames — on the van video (@unreal_b.r.a.n.d) it offered none, because she
  // holds her hand over her face in every one. This takes ONE moment the person chose on the card: the original frame
  // at t as a lossless PNG (the same bytes the opening candidates use) + the same judge, so the swap still knows WHICH
  // person to replace there. The source must already be a downloadable file (the tool's durable copy).
  app.post('/api/clone-v2/moment', async (req, res) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2moment-'));
    try {
      const b = req.body || {};
      const videoUrl = String(b.videoUrl || '');
      const t = Number(b.t);
      if (!/^https:\/\//i.test(videoUrl)) return res.status(400).json({ success: false, error: 'Missing videoUrl' });
      if (!Number.isFinite(t) || t < 0) return res.status(400).json({ success: false, error: 'Missing t' });
      const kieKey = typeof b.kieApiKey === 'string' ? b.kieApiKey.trim().slice(0, 200) : '';
      const key = kieKey ? '' : process.env.ANTHROPIC_API_KEY;
      if (!key && !kieKey) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
      const video = path.join(tmp, 'video.mp4');
      const r = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 200 * 1024 * 1024 });
      fs.writeFileSync(video, Buffer.from(r.data));
      const probe = await run(ffmpegBin, ['-hide_banner', '-i', video], { timeout: 20000 });
      const dm = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(probe.stderr);
      const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0;
      const at = Math.round(Math.max(0, duration ? Math.min(t, duration - 0.05) : t) * 100) / 100;
      const full = await fullFramePng(ffmpegBin, video, at, path.join(tmp, 'moment.png'));
      if (!full) return res.status(400).json({ success: false, error: 'Could not read a frame at that moment.' });
      const small = await frameAt(ffmpegBin, video, at, 480, path.join(tmp, 'moment.jpg'));
      const jw = small ? await judgeOpeningFrames({ who: openingWho(b.spec, b.mainHint), frames: [{ t: at, b: small }], key, kieKey, deadline: Date.now() + 90000 }) : null;
      const row = jw && Array.isArray(jw.j.frames) ? (jw.j.frames[0] || {}) : {};
      const main = ['clear', 'small', 'obscured', 'absent'].includes(String(row.main || '').toLowerCase()) ? String(row.main).toLowerCase() : '';
      res.json({ success: true, version: V2_VERSION, t: at, duration, main, where: String(row.where || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        size: [full.W, full.H], png: fs.readFileSync(full.path).toString('base64') });
    } catch (e) {
      console.warn('[clone-v2] moment failed:', e.message);
      res.status(500).json({ success: false, error: String(e.message || e).slice(0, 200) });
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  // 📦 PRODUCT EVENTS (2026-10-22, Mike: "the prompt is really short … give it more details"). Product only has no
  // person to hang the actions on, so the analysis kept only each shot's setting and end state: what the replaced object
  // DOES (rides, launches, lands) never reached the prompt, not even in the hook. This watches the source once and
  // returns, per shot, the object's own movements in order. Motion, direction, path and end position only — never the
  // object's colour, shape, material, logo or text (RULE R3: the product photos supply its looks). Called only by the
  // tool's Product only path; nothing else reads `product_events`.
  app.post('/api/clone-v2/product-events', async (req, res) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2prodev-'));
    try {
      const b = req.body || {};
      const videoUrl = String(b.videoUrl || '');
      const replaces = String(b.replaces || '').replace(/[\r\n"`<>{}\[\]]/g, ' ').trim().slice(0, 120);
      const shots = (b.spec && Array.isArray(b.spec.shots) ? b.spec.shots : []).map((x) => Number(x && x.start)).filter(Number.isFinite).sort((a, c) => a - c);
      if (!/^https:\/\//i.test(videoUrl)) return res.status(400).json({ success: false, error: 'Missing videoUrl' });
      if (!replaces) return res.status(400).json({ success: false, error: 'Missing replaces' });
      if (!shots.length) return res.status(400).json({ success: false, error: 'Missing shots' });
      const kieKey = typeof b.kieApiKey === 'string' ? b.kieApiKey.trim().slice(0, 200) : '';
      const key = kieKey ? '' : process.env.ANTHROPIC_API_KEY;
      if (!key && !kieKey) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
      const deadline = Date.now() + 150000;
      const video = path.join(tmp, 'video.mp4');
      const r = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 200 * 1024 * 1024 });
      fs.writeFileSync(video, Buffer.from(r.data));
      const probe = await run(ffmpegBin, ['-hide_banner', '-i', video], { timeout: 20000 });
      const dm = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(probe.stderr);
      const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0;
      // 64 frames over the WHOLE video = 8 sheets, all sent (reviewer 2026-10-22: the default 96-frame rate with only the
      // first 6 sheets sent saw a 20 s source up to 11.75 s, so every later shot was guessed).
      const sh = await sheets(ffmpegBin, video, duration || 30, tmp, 64);
      const img = (buf) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
      const windows = shots.map((st, i) => ({ start: st, end: i + 1 < shots.length ? shots[i + 1] : (duration || st + 1) }));
      const content = [];
      sh.slice(0, 8).forEach((x, k) => { content.push({ type: 'text', text: `CONTACT SHEET ${k + 1} (left→right, top→bottom) at ${x.times.join(', ')} s:` }); content.push(img(x.buf)); });
      content.push({ type: 'text', text: `THE OBJECT: ${replaces}. THE SHOTS (start → end, s): ${JSON.stringify(windows)}.\n`
        + 'For EVERY shot, list in order what THE OBJECT does in that shot: where it starts, every movement (direction, path, rotation, what it moves on or through), and where it ends. '
        + 'Shot 1 is the hook: describe it most precisely, every small movement. Later shots: 1–3 short items each. '
        + 'Call it only "it" (never by a name, a colour, a shape, a material, a logo or any text on it). No speed or tempo words (slowly, gently, quickly). '
        + 'If the object is not visible in a shot, give that shot an empty list.\n'
        + 'Return ONLY JSON: {"shots":[{"start":<the shot start, exactly as given>,"events":["…","…"]}]} — one entry per shot, in order.' });
      const system = 'You watch a short video frame by frame and describe the movement of one object, precisely and in order, for a video model. Answer with JSON only.';
      const w = await callWriter({ system, content, key, kieKey, deadline, maxTokens: 1500 });
      const j = parseSpec(w.text);
      const rows = j && Array.isArray(j.shots) ? j.shots : [];
      // Drop a line that describes the OBJECT's looks (its colour, logo …). Not a plain colour word: "rides up the steel
      // ramp" is about the set, and dropping it would cut the very action this pass exists for.
      const LOOKS = /\bits\s+(colou?rs?|logos?|brand|text|lettering|material|shape|finish|fabric)\b/i;
      const out = windows.map((wd, i) => {
        const row = rows.find((x) => Math.abs(Number(x && x.start) - wd.start) < 0.05) || rows[i] || {};
        const events = (Array.isArray(row.events) ? row.events : []).map((e) => String(e).replace(/\s+/g, ' ').trim().slice(0, 200)).filter((e) => e && !LOOKS.test(e)).slice(0, i === 0 ? 8 : 3);
        return { start: wd.start, events };
      });
      res.json({ success: true, version: V2_VERSION, shots: out });
    } catch (e) {
      console.warn('[clone-v2] product-events failed:', e.message);
      res.status(500).json({ success: false, error: String(e.message || e).slice(0, 200) });
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });

  const cloneV2Handler = async (req, res) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clonev2-'));
    const t0 = Date.now();
    const deadline = t0 + V2_BUDGET_MS;
    const timing = {};
    const mark = (k) => { timing[k] = Math.round((Date.now() - t0) / 100) / 10; };
    try {
      const { videoUrl } = req.body || {};
      const personaGender = ['male', 'female'].includes(req.body.personaGender) ? req.body.personaGender : null;
      const name = String(req.body.name || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').slice(0, 40) || 'the main person';
      // A student's own Kie key pays (the tool sends it for every account but the owner's); else the owner's Anthropic key.
      const kieKey = typeof req.body.kieApiKey === 'string' ? req.body.kieApiKey.trim().slice(0, 200) : '';
      const key = kieKey ? '' : process.env.ANTHROPIC_API_KEY;
      if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });
      if (!key && !kieKey) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
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

      // 🔎 Second opinion (owner only): Gemini starts the moment the video is on disk (2026-10-14 — it used to wait
      // for every measurement and the frames first) and watches it while the analysis goes on; see LATE SECOND
      // OPINION. geminiShotLog reads the file synchronously before its first await, so the tmp clean-up is safe.
      // 240 s: nothing waits on it any more, and Gemini was measured at 120+ s on a slow afternoon.
      let soSettled = null;
      // Not when the user has said who MAIN is (reviewer, 2026-10-16): Gemini picks its own MAIN — on the Shelby video
      // the trolley man the user just ruled out — and the judge would add HIS actions to the corrected MAIN.
      const secondP = (!kieKey && !userInputs(req.body || {}).mainHint && typeof geminiShotLog === 'function') ? geminiShotLog(video, { timeoutMs: 240000 }).catch((e) => ({ ok: false, error: String(e.message || e) })) : null;
      if (secondP) secondP.then((g) => { soSettled = g; });

      // 2. MEASURE.
      const { cuts, falseCuts, motionCuts } = await measureCuts(ffmpegBin, video, duration, (ts) => py(PY, path.join(__dirname, 'cutflow.py'), [video, ts.join(',')], 60000)); mark('cuts');
      const camera = await py(PY, path.join(__dirname, 'cameramotion.py'), [video, cuts.join(',')], 120000); mark('camera');
      // 🔍 where the source's autofocus loses and finds focus — used only by the Real Unfocus Look switch.
      // Only when the Real Unfocus Look switch is on (owner test) — a measurement nothing else reads costs every
      // other analysis time inside the 270 s budget (reviewer, 2026-10-13).
      // (2026-10-14) no longer measured — the autofocus moment is added to the finished video (/api/focus-blur).
      const focusM = null;
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
        ...userFacts(req.body || {}),
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
      let w, spec, errs;
      if (kieKey) {
        // A student's own Kie key: Gemini writes the spec (one retry on an unreadable answer), then a short
        // Claude pass rewrites the hook stretch (refineHookViaKieClaude); Gemini's hook stays if it fails.
        w = await callGeminiKie({ system, content, kieKey, deadline });
        spec = parseSpec(w.text); errs = spec ? validateSpec(spec) : ['no JSON'];
        if (errs.length) {
          console.warn(`[clone-v2] Gemini spec invalid (${errs.join('; ')}) — one retry`);
          w = await callGeminiKie({ system, kieKey, deadline, content: [...content, { type: 'text', text: `Your previous answer was invalid (${errs.join('; ')}). Return the complete JSON spec only.` }] });
          spec = parseSpec(w.text); errs = spec ? validateSpec(spec) : ['no JSON'];
        }
        mark('writer');
        w.hook = 'gemini';
        if (!errs.length) {
          const h = await refineHookViaKieClaude({ system, facts, sheets: sh, hookFrames: hook, spec, kieKey, deadline, hookSecs });
          if (h.spec && !validateSpec(h.spec).length) { spec = h.spec; w.hook = 'claude'; w.hookUsage = h.w && h.w.usage; }
          else { w.hookError = h.error || 'invalid'; console.warn(`[clone-v2] hook pass skipped: ${w.hookError}`); }
          mark('hook');
        }
      } else {
        w = await callWriter({ system, content, key, kieKey, deadline }); mark('writer');
        spec = parseSpec(w.text); errs = spec ? validateSpec(spec) : ['no JSON'];
      }
      if (errs.length && !kieKey) {
        console.warn(`[clone-v2] spec invalid (${errs.join('; ')}) — one repair attempt`);
        w = await callWriter({ system, key, kieKey, deadline, content: [...content, { type: 'text', text: `Your previous answer was invalid (${errs.join('; ')}). Return the complete JSON spec only.` }] });
        spec = parseSpec(w.text); errs = spec ? validateSpec(spec) : ['no JSON'];
        mark('writer-repair');
      }
      if (errs.length) return res.status(502).json({ success: false, error: 'The analysis could not be structured — try again.', detail: errs, raw: String((w && w.text) || '').slice(0, 2000) });

      let secondOpinion = null, soLate = false;
      if (secondP) {
        // Never WAIT for Gemini: in already, with time for the judge (80 s) → judged here, as before; not in yet, or
        // no time left for the judge → it finishes in the background (startLateSecondOpinion, below).
        await new Promise((r) => setImmediate(r));   // let an answer that just arrived set soSettled
        const g = soSettled;
        if (!g || (g.ok && deadline - Date.now() < 80000)) soLate = true;
        else if (g.ok) {
          const m = await secondOpinionMerge({ spec, log: g.log, sheets: sh, hookFrames: hook, key, deadline });
          const applied = !!(m.spec && !validateSpec(m.spec).length);
          if (applied) spec = m.spec;
          secondOpinion = { model: g.model, geminiSecs: g.secs, added: applied ? m.added : [], error: m.error || null };
        } else secondOpinion = { model: null, added: [], error: g.error || 'Gemini did not answer' };
        // WHAT it added, not only how many (Mike, 2026-10-12: is the second opinion improving the workflow? — judge
        // the additions over the next ~10 remakes). One line per addition: the shot start and the added moment.
        if (secondOpinion) console.log(`[clone-v2] second opinion: ${secondOpinion.added.length} added${secondOpinion.error ? ' (' + secondOpinion.error + ')' : ''}${secondOpinion.added.length ? ' — ' + secondOpinion.added.map((a) => `[${a.start}s] ${String(a.event || '').replace(/\s+/g, ' ').slice(0, 160)}`).join(' | ') : ''}`);
        mark('second');
      }

      // 4b. OUTFIT crops (phase 2) + the full-resolution opening frame for the first-frame step.
      // Fail open: a missing crop is shown as missing in the Lab, never invented.
      let outfit = { front: null, back: null };
      try { outfit = await pickOutfit({ spec, ff: ffmpegBin, video, tmp, key, kieKey, duration, deadline }); } catch (e) { outfit = { front: null, back: null, reason: String(e.message || e).slice(0, 160) }; }
      mark('outfit');
      // 🎬 Up to 3 opening candidates from the hook (fail open: null = the tool keeps the frame0 route).
      let openings = null;
      try { openings = await pickOpenings({ spec, ff: ffmpegBin, video, tmp, key, kieKey, duration, deadline }); } catch (e) { console.warn('[clone-v2] openings failed:', e.message); }
      mark('openings');
      let frame0 = null;
      try {
        const f0 = await fullFramePng(ffmpegBin, video, hookTs[0] || 0.05, path.join(tmp, 'frame0.png'));
        if (f0) frame0 = { t: hookTs[0] || 0.05, size: [f0.W, f0.H], png: fs.readFileSync(f0.path).toString('base64') };
      } catch (_) {}

      // 🎭 4c. One small change per clearly visible background person (Mike, 2026-10-23), picked ONCE here and stored on
      // the spec, so the tool's first frame and every compile (now, the late second opinion, Generate) read the same one.
      spec = pickCastChanges(spec);
      // 5. COMPILE for both models (no reference bindings yet — the tool adds them per job).
      const copts = { name, gender: personaGender, cuts, camera: camera && camera.segments, durationSec: duration };
      const wan = compile(spec, { ...copts, model: 'wan' });
      const seedance = compile(spec, { ...copts, model: 'seedance' });
      if (soLate) {
        const late = startLateSecondOpinion({ lid: req.body.locationId, secondP, spec: JSON.parse(JSON.stringify(spec)), sheets: sh, hookFrames: hook, key,
          recompile: (s) => ({ wan: compile(s, { ...copts, model: 'wan' }), seedance: compile(s, { ...copts, model: 'seedance' }) }) });
        secondOpinion = { pending: true, id: late.id, model: null, added: [], error: null };
        console.log(`[clone-v2] second opinion: not in yet — finishing in the background (${late.id.slice(0, 8)})`);
      }

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
        measured: { cuts, falseCuts, motionCuts, camera: (camera && camera.segments) || null, hookMotion, beats, focus: (focusM && Array.isArray(focusM.events)) ? focusM.events : [] },
        spec, prompts: { wan, seedance },
        keyframes: shotKeys.map(k => ({ t: k.t, shot: k.shot, dataUrl: thumb(k.b) })),
        outfit, frame0, openings,
        hookFrames: hook.slice(0, 1).map(h => ({ t: h.t, dataUrl: thumb(h.b) })),
        sourceVideoUrl, secondOpinion, writer: { model: w.model, usage: w.usage, stop: w.stop, payer: w.payer, hook: w.hook || null, hookError: w.hookError || null, hookUsage: w.hookUsage || null, credits: w.credits ?? null }, timing,
      });
    } catch (e) {
      console.error('[clone-v2] failed:', e.message);
      res.status(e && e.code === 'out_of_time' ? 504 : e && (e.code === 'kie_key' || e.code === 'kie_balance') ? 402 : 500).json({ success: false, error: String(e.message || e).slice(0, 300), ...(e && e.code ? { code: e.code } : {}) });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  };
  app.post('/api/clone-v2', joinIdentical(cloneV2Handler, deps.runRecorded));
  // ⏳ A second opinion that finished after its analysis (see LATE SECOND OPINION). The id is 128 random bits and
  // bound to the lid that asked, so one account can never read another's.
  app.get('/api/clone-v2/second-opinion/:id', (req, res) => {
    const rec = SO_LATE.get(String(req.params.id || ''));
    if (!rec || (rec.lid && String(req.query.lid || '') !== rec.lid)) return res.status(404).json({ success: false, status: 'unknown' });
    res.json(lateSecondOpinionView(rec));
  });
}

// 🔁 JOIN DUPLICATES + 3-MIN RESULT CACHE — v1's rule for /api/clone (2026-09-09), now on v2 too
// (/toolscan 2026-10-09). Railway's edge has been measured re-sending a long POST mid-request and
// answering the caller 502 while the work went on, and a Lab user who sees "failed" clicks Analyse
// again: each was a second full run (Apify download + every Claude call). An identical request now
// joins the run in progress, and a finished success is served for 3 minutes. Errors never cached.
const V2_RECENT_TTL_MS = 180000;
function v2JoinKey(b) {
  // The user's hints are part of the key: a re-analysis WITH a "who is MAIN" hint must never join or be served
  // the run without it (that run is the wrong one the user is correcting).
  const u = userInputs(b);
  return JSON.stringify([String(b.locationId || ''), String(b.videoUrl || ''), String(b.name || ''), b.personaGender || '', b.unfocus === true, u.author, u.mainHint, u.changes]);   // unfocus: the focus dips are only measured when on
}
// 👤💬 WHAT THE USER TOLD US (2026-10-16). Two inputs from the tool, plus the posting account:
//   sourceAuthor — the handle that posted the video. Measured that day on @thomasshelbysosia: the writer made the
//     older man pushing a trolley MAIN (he fills the opening) while the account — and the video — is about the
//     Peaky Blinders lookalike walking behind him. The handle is a hint, never an order (Mike: "Yes, add it").
//   mainHint / userChanges — typed by the owner in the app ("the main person is the man in the flat cap",
//     "make the car red"). The hint overrides the writer's own choice; the changes are written into the spec as
//     if the video already showed them, so the compiled prompt carries them.
// Text from a person, so it is cleaned (no quotes, brackets or newlines) and capped before it enters a prompt.
function cleanUserText(raw, max) {
  return String(raw || '').replace(/[`"\u201c\u201d<>{}\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function userInputs(b) {
  const author = String((b && b.sourceAuthor) || '').replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 40);
  return { author, mainHint: cleanUserText(b && b.mainHint, 300), changes: cleanUserText(b && b.userChanges, 600) };
}
function userFacts(b) {
  const u = userInputs(b);
  return [
    u.author ? `POSTED BY: @${u.author}. When the handle names or describes a person (a character, a lookalike, a name), the person it is about is usually MAIN — even when someone else fills the opening. Use it only as a hint: when the video clearly makes someone else its subject, that person is MAIN.` : '',
    u.mainHint ? `WHO MAIN IS — the user says, and this OVERRIDES your own choice: ${u.mainHint}. Every MAIN field (outfit, shots, opening, main_where) is about that person; everyone else goes in cast.` : '',
    u.changes ? `THE USER'S CHANGES FOR THE REMAKE: ${u.changes}. Write the spec as if the video already showed these changes — in the outfit, cast, background and every shot where it is visible. Change nothing else: everything the user did not mention stays exactly as the video shows.` : '',
  ].filter(Boolean);
}
function joinIdentical(handler, runRecorded, { inflight = new Map(), recent = new Map(), now = () => Date.now() } = {}) {
  return async (req, res) => {
    const key = v2JoinKey(req.body || {});
    for (const [k, v] of recent) if (now() - v.at > V2_RECENT_TTL_MS) recent.delete(k);
    const hit = recent.get(key);
    if (hit) { console.log('[clone-v2] identical request — served from the 3-min result cache (no new analysis)'); return res.status(200).json(hit.body); }
    let run = inflight.get(key);
    if (run) console.log('[clone-v2] identical request while one is running — joined it (no new analysis)');
    else { run = runRecorded(handler, req).finally(() => inflight.delete(key)); inflight.set(key, run); }
    const { status, body } = await run;
    if (status === 200 && body && body.success !== false) recent.set(key, { at: now(), body });
    res.status(status).json(body);
  };
}

module.exports = { mount, V2_VERSION, chooseOpenings, openingCandidateTimes, openingWho, OPENING_PICK_SYSTEM, V2_BUDGET_MS, WRITER_MIN_MS, callWriter, callGeminiKie, normPick, secondOpinionMerge, SECOND_OPINION_MAX, startLateSecondOpinion, lateSecondOpinionView, soPatches, SO_LATE, refineHookViaKieClaude, toOpenAiContent, joinIdentical, v2JoinKey, measureCuts, fastWindows, FLASH_MAD, CUT_FLOW_RATIO, cropRect, specShotAt, outfitCandidateTimes, userFacts, userInputs };
