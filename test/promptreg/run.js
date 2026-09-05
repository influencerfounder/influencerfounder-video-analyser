#!/usr/bin/env node
// 🧪 PROMPT REGRESSION SUITE — recreate (1:1) prompt builder.
//
// WHY THIS EXISTS (2026-09-04). Every clause ever added to the recreate system prompt was
// verified the same way: "does it fix the ONE video that prompted it?" Nothing ever checked
// whether it broke a DIFFERENT class of video. Twice that cost us:
//   • the ACCURACY OVER EMBELLISHMENT guard (added for a video that hallucinated a paparazzi
//     crowd) told the model to keep background people incidental. "Incidental" has no lower
//     bound, so on a source whose only motion WAS a background person it went to zero and the
//     recreate came back as a 9-second frozen frame.
//   • the REAL-TIME playback clause (added for one slow-motion video) was proven insufficient
//     the next day — the real cause was duration padding — and still sits in the prompt.
//
// So: a fixed set of real sources spanning the classes we have actually broken, asserted on
// the PROMPT TEXT. No video is generated — a prompt-level run is ~$0.25 a source and seconds,
// where a video-level run is dollars and minutes. Your eyeball is still needed, but only for
// the one video a change was made for.
//
// ⚠️ Everything under test is read out of index.js AT RUN TIME — the system prompt, the user
// message, the pronoun rule, the frame-extraction constants. An earlier suite elsewhere in this
// repo was once generated with its target INLINED and produced a confident false pass against
// its own frozen copy. If an anchor drifts here, extraction throws loudly instead.
//
//   node test/promptreg/run.js                # test the LOCAL index.js prompt (pre-deploy)
//   node test/promptreg/run.js --deployed     # test what is live on Railway instead
//   node test/promptreg/run.js --only=cosanostra
//   node test/promptreg/run.js --save=before  # write prompts to results/before.json for diffing
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const os = require('os');

const DIR = __dirname, FIX = path.join(DIR, 'fixtures'), SRC_FILE = path.join(DIR, '..', '..', 'index.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
const SAVE = (process.argv.find(a => a.startsWith('--save=')) || '').split('=')[1];
const DEPLOYED = process.argv.includes('--deployed');
const RAILWAY = process.env.ANALYSER_URL || 'https://influencerfounder-video-analyser-production.up.railway.app';

/* ───────────────────────── binaries (same traps as build-fixtures.js) ───────────────────── */
let ffmpegStatic = null; try { ffmpegStatic = require('ffmpeg-static'); } catch (_) {}
const FFMPEG = [ffmpegStatic, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', `${process.env.HOME}/bin/ffmpeg`]
  .find(p => { try { return p && fs.existsSync(p); } catch (_) { return false; } });
if (!FFMPEG) throw new Error('no ffmpeg found');

/* ───────────────────────── read the code under test ─────────────────────────────────────── */
const grab = (start, end, label) => {
  const i = SRC.indexOf(start);
  if (i === -1) throw new Error(`anchor drifted, start not found: ${label}`);
  const j = SRC.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`anchor drifted, end not found: ${label}`);
  return SRC.slice(i, j + end.length);
};
// Evaluate the real single-quoted literal so — and \' resolve exactly as they do in prod.
const literal = (decl, label) => {
  const line = grab(decl, "';", label);
  const eq = line.indexOf('=');
  return new Function('return ' + line.slice(eq + 1).trim().replace(/;$/, ''))();
};

const ORIGINAL_CLONE_SYSTEM = literal("const ORIGINAL_CLONE_SYSTEM = '", 'ORIGINAL_CLONE_SYSTEM');
const PRONOUN_RULE_FN = new Function('personaGender', grab('const PRONOUN_RULE = personaGender', ": '';", 'PRONOUN_RULE') + '\n return PRONOUN_RULE;');
const num = (name) => { const m = SRC.match(new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`)); if (!m) throw new Error(`constant not found: ${name}`); return parseFloat(m[1]); };
const ANALYSIS_FRAME_COUNT = num('ANALYSIS_FRAME_COUNT');
const ANALYSIS_QV = num('ANALYSIS_QV');
const ANALYSIS_SCALE = (SRC.match(/const ANALYSIS_SCALE = "([^"]+)"/) || [])[1];
if (!ANALYSIS_SCALE) throw new Error('constant not found: ANALYSIS_SCALE');
const HOOK_TS = JSON.parse((SRC.match(/for \(const ts of (\[[^\]]+\])\)/) || [])[1] || 'null');
if (!Array.isArray(HOOK_TS)) throw new Error('could not read the hook-frame timestamps');

/* ───────────────────────── api key (never printed) ──────────────────────────────────────── */
function anthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  for (const f of [
    path.join(DIR, '..', '..', '.env'),
    path.join(DIR, '..', '..', '..', 'InfluencerFounder-tool', '.env'),
    path.join(os.homedir(), 'Claude Code', 'InfluencerFounder', 'InfluencerFounder-tool', '.env'),
    path.join(os.homedir(), 'influencerfounder-service', '.env'),
  ]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^ANTHROPIC_API_KEY\s*=\s*"?([^"\n\r]+)"?/m);
      if (m) return m[1].trim();
    } catch (_) {}
  }
  return null;
}

/* ───────────────────────── frame extraction (mirrors index.js) ──────────────────────────── */
function frames(mp4, duration) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptreg-'));
  const fps = Math.min(8.0, ANALYSIS_FRAME_COUNT / Math.max(duration, 0.1));
  execFileSync(FFMPEG, ['-v', 'error', '-i', mp4, '-vf', `fps=${fps},${ANALYSIS_SCALE}`,
    '-frames:v', String(ANALYSIS_FRAME_COUNT), '-q:v', String(ANALYSIS_QV), '-threads', '1',
    path.join(tmp, 'frame-%03d.jpg')], { maxBuffer: 64 * 1024 * 1024 });
  const analysis = fs.readdirSync(tmp).filter(f => f.startsWith('frame-')).sort()
    .map(f => fs.readFileSync(path.join(tmp, f)).toString('base64'));
  const hook = [];
  for (const ts of HOOK_TS) {
    if (ts >= duration) break;
    const hp = path.join(tmp, `hook-${String(ts).replace('.', '_')}.jpg`);
    try {
      execFileSync(FFMPEG, ['-v', 'error', '-ss', String(ts), '-i', mp4, '-vframes', '1',
        '-q:v', String(ANALYSIS_QV), '-vf', ANALYSIS_SCALE, '-threads', '1', hp]);
      hook.push({ ts, b64: fs.readFileSync(hp).toString('base64') });
    } catch (_) {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!analysis.length) throw new Error('no analysis frames extracted from ' + mp4);
  return { analysis, hook };
}

/* ───────────────────────── build + send exactly what production sends ───────────────────── */
async function promptFor(fx, mp4) {
  if (DEPLOYED) {
    const r = await fetch(`${RAILWAY}/api/clone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: fx.url, promptStyle: 'original', personaGender: fx.personaGender })
    }).then(r => r.json());
    if (!r.success) throw new Error('deployed analyse failed: ' + r.error);
    return r.clonePrompt;
  }
  const key = anthropicKey();
  if (!key) throw new Error('no ANTHROPIC_API_KEY (set it, or run with --deployed)');
  const { analysis, hook } = frames(mp4, fx.duration);
  const img = b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  const hookContent = hook.length ? [
    { type: 'text', text: `HOOK WINDOW — the source's opening ${hook.length} frames in order (${hook.map(h => h.ts + 's').join(', ')}). This is the scroll-stopping moment you must preserve.` },
    ...hook.map(h => img(h.b64))
  ] : [];
  const userText = fx.transcript
    ? `These ${analysis.length} frames were extracted from the viral video. Transcript: "${fx.transcript}"\n\nCreate the video prompt.`
    : `These ${analysis.length} frames were extracted from the viral video (no audio). Create the video prompt.`;
  const system = [ORIGINAL_CLONE_SYSTEM, PRONOUN_RULE_FN(fx.personaGender)].filter(Boolean).join('\n\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system,
      messages: [{ role: 'user', content: [...hookContent, ...analysis.map(img), { type: 'text', text: userText }] }] })
  });
  const d = await r.json();
  if (!d.content) throw new Error('claude call failed: ' + JSON.stringify(d).slice(0, 300));
  return d.content[0].text.trim();
}

/* ───────────────────────── the assertions ───────────────────────────────────────────────── */
// Calibrated against the 7 baseline prompts on 2026-09-04. A pattern that fires on a
// known-good baseline is a BROKEN PATTERN, not a broken prompt — tighten it here, do not
// loosen the prompt to satisfy it.
const RX = require('./checks.js');
// ⭐ NO MOTION GATE — deliberately, and this replaces a provisional `motion > 0.5` gate.
//
// The gate was meant to spare a source that is genuinely near-frozen, where "stands still"
// would be an honest description. Calibration on the real set killed it: every measured
// source sits at or above 0.862, so a 0.5 gate could never be false — it was decorative,
// and a condition that cannot fail reads as a safeguard while being none.
//
// It is also the wrong shape. The freeze case measured 0.862 and DOES move (a body crosses
// the lens, he steps down); the bug was the prompt calling that still, not the source being
// still. So the rule is unconditional: never claim the subject holds still.
//
// ⚠️ WHEN TO REVISIT: if a genuinely static source is ever added to sources.json, this rule
// will fail a source that is not broken — and calibrate.js will show it firing on a healthy
// baseline. THAT is the moment to add a real gate, set from that source's measured motion.
// Not before: a speculative threshold is exactly what this comment replaced.

function check(prompt, fx) {
  const out = [];
  const hit = (list) => list.map(r => (prompt.match(r) || [])[0]).filter(Boolean);
  const t = (name, ok, detail) => out.push({ name, ok, detail: ok ? '' : detail });

  t('uses the [INFLUENCER] placeholder', prompt.includes('[INFLUENCER]'), 'placeholder missing — the name swap cannot happen');
  const app = hit(RX.appearance);
  t('no appearance leak', !app.length, `describes the source person: ${app.join(', ')}`);
  const par = hit(RX.params);
  t('no parameters in prose', !par.length, `states a generation parameter: ${par.join(', ')}`);
  // Sentence-scoped, negation-aware: "paparazzi-style framing even though NO CROWD EXISTS"
  // is a camera description that denies a crowd, i.e. the opposite of this failure. A bare
  // /paparazzi/ match failed it anyway. See findCrowdFiller in checks.js for why softening
  // this one word is safe (the real 2026-09-02 failure trips 3 other patterns).
  const crowd = RX.findCrowdFiller(prompt);
  t('no crowd/paparazzi filler', !crowd.length, `invented crowd attention: ${crowd.join(', ')}`);

  // A locked camera is legitimate; INSISTING on it is the Larnaca failure — the prompt spends
  // words teaching the model to nail the lens down, and the source's push-in is lost.
  const camDeny = hit(RX.cameraDenial);
  t('no emphatic camera-movement denial', !camDeny.length, `insists the camera cannot move: ${camDeny.join(', ')}`);

  const words = prompt.split(/\s+/).filter(Boolean).length;
  // Collapse detector, NOT a style rule -- and it is DURATION-RELATIVE because a flat band is
  // the wrong shape: measured across the real baselines, word count tracks source length
  // (9.1s->419, 10.1s->427, 10.5s->412, 12.5s->536, 21.6s->700). A flat ceiling was
  // contradicted by its own healthy data twice (480 then 650) before this was fixed. The FLOOR
  // is the real signal -- it catches a prompt that came back a stub; the ceiling only needs to
  // be loose enough to catch a genuine runaway.
  const durS = Number(fx.durationSec || fx.duration) || 0;
  const lo = durS ? Math.max(120, Math.round(12 * durS)) : 120;
  const hi = durS ? Math.round(120 + 55 * durS) : 900;
  t(`word count in band (${words})`, words >= lo && words <= hi, `${words} words is outside ${lo}-${hi} for a ${durS || '?'}s source`);

  const g = fx.personaGender;
  if (g === 'male' || g === 'female') {
    const want = g === 'male' ? /\b(he|him|his)\b/i : /\b(she|her|hers)\b/i;
    t(`pronouns are ${g === 'male' ? 'he/him' : 'she/her'}`, want.test(prompt), 'the required pronouns never appear');
    // The rule is "don't fall back to they/them for the INFLUENCER", not "the word they must
    // never appear". A prompt legitimately writes "their" for an unidentifiable third party --
    // an out-of-focus back in the foreground has no visible gender, and inventing one would be
    // an appearance claim a different rule already bans.
    const wrongPro = RX.findWrongPronoun(prompt, g);
    t('no they/them for the influencer', !wrongPro.length, `fell back to they/them despite an explicit gender: ${wrongPro.join(', ')}`);
  }

  // ⭐ the reason this suite exists.
  //
  // findMovement is attribution-aware and that is load-bearing, not tidiness: matching
  // movement verbs anywhere in the prompt scored the FREEZE CASE 5/5 while every hit was a
  // false positive (a noun "entrance step", a narrative "the clip opens", the camera's own
  // "sway", and two negations "does not walk" / "does not wave"). A raw match would pass the
  // one prompt in the set that describes nothing moving. Sentence-scoped, negation-aware
  // matching takes it to 0 while the healthy sources keep 6 and 4.
  const moves = RX.findMovement(prompt);
  t('describes movement by the person', moves.length > 0,
    'no sentence about the person describes them moving — this is the freeze bug');

  // Camera-aware for the same reason movement is: "the camera holds still" is legitimate
  // and the system prompt explicitly allows it, so a raw match would fail a prompt for
  // obeying its own rule.
  // ⭐ TEMPO (2026-09-05). Attribution-aware like the two above: "the camera slowly pushes in"
  // is a legitimate lens move and is excluded; "he slowly pulls the sunglasses down" is the
  // Paris failure — Seedance renders subject-tempo words as playback slow motion even when the
  // clip length already matches the source. The banned list mirrors the system prompt 1:1.
  const tempo = RX.findTempo(prompt).map(h => h.word);
  t('no tempo words on the person', !tempo.length,
    `tempo words attached to a person — renders as fake slow-motion playback: ${tempo.join(', ')}`);

  const still = RX.findStillness(prompt).map(h => h.phrase);
  t(`no stillness claim (source motion ${fx.motion})`, !still.length,
    `claims the subject holds still on a source that measurably moves: ${still.join(', ')}`);
  return out;
}

/* ───────────────────────── run ──────────────────────────────────────────────────────────── */
(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'sources.json'), 'utf8'));
  const list = manifest.sources.filter(s => !ONLY || s.slug === ONLY);
  console.log(`\nPROMPT REGRESSION — ${DEPLOYED ? 'DEPLOYED (Railway)' : 'LOCAL index.js'} · ${list.length} source(s)`);
  console.log(`system prompt under test: ${ORIGINAL_CLONE_SYSTEM.split(/\s+/).length} words\n`);

  let pass = 0, fail = 0, skipped = 0; const saved = {};
  for (const s of list) {
    const metaP = path.join(FIX, `${s.slug}.json`), mp4 = path.join(FIX, `${s.slug}.mp4`);
    if (!fs.existsSync(metaP) || !fs.existsSync(mp4)) { console.log(`── ${s.slug}\n   SKIP — fixture missing, run build-fixtures.js`); skipped++; continue; }
    const fx = JSON.parse(fs.readFileSync(metaP, 'utf8'));
    let prompt;
    try { prompt = await promptFor(fx, mp4); }
    catch (e) { console.log(`── ${s.slug}\n   ERROR ${e.message}`); fail++; continue; }
    saved[s.slug] = prompt;
    const res = check(prompt, fx);
    const bad = res.filter(r => !r.ok);
    console.log(`── ${s.slug}  (${s.class}, motion ${fx.motion})`);
    for (const r of res) console.log(`   ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '\n        ↳ ' + r.detail}`);
    bad.length ? fail++ : pass++;
    console.log('');
  }
  if (SAVE) {
    fs.mkdirSync(path.join(DIR, 'results'), { recursive: true });
    const f = path.join(DIR, 'results', `${SAVE}.json`);
    fs.writeFileSync(f, JSON.stringify(saved, null, 2));
    console.log(`prompts saved to ${f}\n`);
  }
  console.log(`${pass} source(s) clean, ${fail} with failures${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR:', e.message); process.exit(2); });
