// 🧪 RECREATE v2 — the COMPILER (2026-10-04, PRD docs/prds/RECREATE-V2-PRD.md).
//
// v1 asks a writer for finished prose and then bolts clauses onto it — the stack Mike called
// "fine tuning too much and making things worse". v2 splits SEEING from WRITING: the writer
// returns a structured spec (v2/spec.js), and this file — plain code, no model — turns it into
// the video prompt. Every rule that shapes the prompt lives in RULES below, has a reason and a
// test (test/v2-compile.selftest.js), and is added only through the rule gate (see RULE_GATE).
//
// Output format = Alibaba's own Wan 3.0 guide (alibabacloud.com/help/en/model-studio/
// wan3-video-generation-prompt-guide): overall description → Image N bindings → "Shot N
// [a-bs]:" segments, contiguous, "hard cut" at the END of a segment, "seamlessly continue from
// the last frame" for a continuous take, "Generate single shot." for a one-take clip.
// Seedance gets the same text with "@Image N" and whole seconds (2.5 reads whole seconds; 2.0
// ignores timestamps, so v2 does not offer it).

'use strict';

// ── The rule gate (process, enforced in review + selftest) ──────────────────────────────────
// A new rule needs ALL THREE: (a) a failure seen on ≥ 2 test-set sources, (b) a scorecard
// measure that catches it, (c) a selftest. Otherwise it is a one-off prompt edit, not a rule.
const RULE_GATE = 'failure on >=2 test-set sources + a scorecard measure + a selftest';

const RULES = {
  measuredCuts:   'Shots start at 0 and at every MEASURED cut (ffmpeg scene detection, flash-checked); the writer cannot move a cut. Evidence: v1 cuts landed within 0.07 s only once they were measured.',
  measuredCamera: 'Where the measured camera turns the other way than the writer said, the measurement wins. Evidence: G63, 4/5 prompts wrote "pans right" where the source turns left.',
  fixedShot:      'A camera that holds is written "fixed shot" — Wan\'s rewriter adds camera motion unless told (Wan2.2 system_prompt "emphasize camera movements"); 09-30 push-in drift.',
  garmentSide:    'Every shot that shows the torso restates the SIDE of the top that faces the camera. Evidence: 7 lobby takes — front described 3/3 right, back print only 4/4 printed on the front.',
  outfitOnce:     'One outfit sentence, front + back, "the same outfit in every shot"; clothing never comes from identity references (bare-torso masters → shirtless).',
  stableLabels:   'Other people keep ONE visible-attribute label everywhere (training-caption style, Tarsier/DREAM-1K).',
  noTempoWords:   'No "slowly / gently / unhurried" on people — tempo words render as slow motion (handbook). Speed is real time.',
  identityFromRefs: 'Tattoos, hair, skin and face never come from the source text — the writer is told not to, and the compiler strips any that slip into the outfit (lobby run 1: the source man\'s sleeve tattoos landed in "accessories").',
  mainLabel: 'The writer\'s placeholder MAIN is always replaced by the influencer\'s name (lobby run 1: "walks beside MAIN").',
  phaseLength:    'Phases inside one take (no cut) shorter than 1.5 s are merged into a neighbour: Alibaba recommends 2-5 s segments and G63 run 1 came back as 13 one-second phases (1,119 words).',
  wanAudio:       'Wan adds dialogue and music unless told: "No dialogue. No background music." (Wan research, 2026-09-07).',
};

const TEMPO = /\b(slowly|slow[- ]?motion|gently|gracefully|leisurely|unhurried(?:ly)?|languid(?:ly)?|lazily|deliberately|calmly|softly)\b\s*/gi;

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function noTempo(s) { return clean(String(s || '').replace(TEMPO, '')); }
function sentence(s) { s = clean(s); if (!s) return ''; s = s[0].toUpperCase() + s.slice(1); return /[.!?]$/.test(s) ? s : s + '.'; }
function fmt(t, whole) { if (whole) return String(Math.round(t)); const r = Math.round(t * 10) / 10; return String(r); }
const IDENTITY = /\b(tattoo\w*|inked|ink\b|hair\w*|beard|stubble|skin|freckles?|complexion|eyebrows?)\b/i;
// RULE identityFromRefs — drop comma/semicolon list items that describe the body, not clothing.
function stripIdentity(s) { return clean(String(s || '').split(/\s*[,;]\s*/).filter(x => x && !IDENTITY.test(x)).join(', ')); }
// RULE mainLabel
function nameMain(s, name) { return String(s || '').replace(/\bMAIN'?s\b/g, name + "'s").replace(/\bMAIN\b/g, name); }
function known(s) { s = clean(s); return s && !/^(n\/?a|none|unknown|not shown|not visible|cannot be determined)\.?$/i.test(s) ? s : ''; }

// The measured camera over a window: the label covering most of it (from v2/cameramotion.py
// segments, already merged). Returns { pan, zoom, tilt, share } or null when nothing measured.
function measuredCameraFor(camSegs, a, b) {
  if (!Array.isArray(camSegs) || !camSegs.length || !(b > a)) return null;
  const tally = new Map();
  for (const s of camSegs) {
    const over = Math.max(0, Math.min(b, s.to) - Math.max(a, s.from));
    if (!over) continue;
    const key = JSON.stringify([s.pan || null, s.zoom || null, s.tilt || null]);
    tally.set(key, (tally.get(key) || 0) + over);
  }
  if (!tally.size) return null;
  const [key, secs] = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
  const [pan, zoom, tilt] = JSON.parse(key);
  return { pan, zoom, tilt, share: secs / (b - a) };
}

// Camera sentence for one shot. The writer's camera wins unless the MEASURED camera contradicts
// its left/right, or the writer says "fixed" while the measurement shows a clear turn/push.
function cameraSentence(cam, measured, log, shotNo) {
  cam = cam || {};
  let move = clean(cam.move).toLowerCase();
  let dir = clean(cam.direction).toLowerCase();
  const fixedWords = /^(fixed|static|locked|locked[- ]off|holds?|none|still)$/;
  if (measured && measured.share >= 0.6) {
    if (measured.pan && (dir === 'left' || dir === 'right') && dir !== measured.pan) {
      log.push({ rule: 'measuredCamera', shot: shotNo, wrote: dir, measured: measured.pan });
      dir = measured.pan;
    } else if ((fixedWords.test(move) || !move) && (measured.pan || measured.zoom)) {
      log.push({ rule: 'measuredCamera', shot: shotNo, wrote: move || 'nothing', measured: measured.pan ? 'pan ' + measured.pan : 'zoom ' + measured.zoom });
      move = measured.pan ? 'pans' : (measured.zoom === 'in' ? 'pushes in' : 'pulls back');
      dir = measured.pan || '';
    }
  }
  if (!move || fixedWords.test(move)) return 'fixed shot, the camera does not move';
  // Only the controlled vocabulary reaches the prompt: free text in the camera field leaked the
  // writer's reasoning on lobby run 1 ("pans left background columns drift right as …").
  move = move.split(/\s+/).slice(0, 3).join(' ');
  let s = `the camera ${move}`;
  if (dir && !new RegExp(`\\b${dir}\\b`).test(s) && /^(left|right|up|down)$/.test(dir)) s += ` ${dir}`;
  return clean(s);
}

function garmentClause(side, outfit, name) {
  const top = known(outfit.top_name) || 'top';
  // The SHORT side descriptions are what gets repeated per shot (lobby run 1 was 888 words
  // because the full front text was restated in four shots).
  const front = known(outfit.top_front_short) || known(outfit.top_front), back = known(outfit.top_back_short) || known(outfit.top_back);
  if (side === 'front' && front) return `the front of ${name}'s ${top.replace(/^(a|an|the)\s+/i, '')} faces the camera: ${front}`;
  if (side === 'back' && back) return `the back of ${name}'s ${top.replace(/^(a|an|the)\s+/i, '')} faces the camera: ${back}`;
  return '';
}

/**
 * compile(spec, opts) → { prompt, words, segments, log, rules }
 * opts: { name, gender:'male'|'female'|null, model:'wan'|'seedance', cuts:[s], camera:[segments],
 *         durationSec, refs:[{kind:'face'|'outfit_front'|'outfit_back'|'first_frame'|'location', note}] }
 */
function compile(spec, opts = {}) {
  const name = clean(opts.name) || 'the main person';
  const model = opts.model === 'seedance' ? 'seedance' : 'wan';
  const whole = model === 'seedance';
  const dur = Number(opts.durationSec) || Number(spec && spec.durationSec) || 0;
  const cuts = (opts.cuts || []).filter(c => c > 0.15 && (!dur || c < dur - 0.15)).sort((a, b) => a - b);
  const log = [];
  const S = spec || {};
  const outfit = S.outfit || {};
  let shots = Array.isArray(S.shots) ? S.shots.map(x => ({ ...x })) : [];
  shots.sort((a, b) => (+a.start || 0) - (+b.start || 0));

  // RULE measuredCuts — snap shot starts to measured cuts, force cut_before on them, close gaps.
  for (const c of cuts) {
    let best = null, bd = 1e9;
    shots.forEach((s, i) => { const d = Math.abs((+s.start || 0) - c); if (i > 0 && d < bd) { bd = d; best = s; } });
    if (best && bd <= 0.45) { if (Math.abs(best.start - c) > 0.01) log.push({ rule: 'measuredCuts', snapped: [best.start, c] }); best.start = c; best.cut_before = true; }
    else log.push({ rule: 'measuredCuts', missing: c });
  }
  if (shots.length) shots[0].start = 0;
  for (let i = 0; i < shots.length; i++) {
    const next = shots[i + 1];
    shots[i].end = next ? next.start : (dur || +shots[i].end || shots[i].start + 1);
    if (i > 0 && cuts.some(c => Math.abs(c - shots[i].start) < 0.01)) shots[i].cut_before = true;
    else if (i > 0 && !cuts.length) shots[i].cut_before = false;
  }
  shots = shots.filter(s => s.end - s.start >= 0.2);
  // RULE phaseLength — merge short NON-cut phases. The hook (shot 1) is never merged into; a short
  // phase right after it goes forward into the next phase when that one is also continuous.
  const merge = (into, from, prepend) => {
    const ev = (x) => (Array.isArray(x.main_events) ? x.main_events : []);
    into.main_events = prepend ? [...ev(from), ...ev(into)] : [...ev(into), ...ev(from)];
    const byId = new Map();
    for (const o of [...(prepend ? from.others || [] : into.others || []), ...(prepend ? into.others || [] : from.others || [])]) {
      if (!o || !o.id) continue;
      const cur = byId.get(o.id) || { id: o.id, events: [] };
      cur.events.push(...(Array.isArray(o.events) ? o.events : [])); byId.set(o.id, cur);
    }
    into.others = [...byId.values()];
    if (prepend) { into.start = from.start; into.cut_before = from.cut_before; if (!known(into.garment_side)) into.garment_side = from.garment_side; }
    else { into.end = from.end; into.end_state = from.end_state || into.end_state; }
    if (from.main_visible !== false) into.main_visible = true;
  };
  // A merge may not build a phase longer than 5 s (Alibaba's upper bound); a short phase that
  // fits nowhere stays as it is — a 1 s phase is better than a 7 s one that drops its camera turn.
  const keep = new Set();
  for (let guard = 0; guard < 100; guard++) {
    const i = shots.findIndex((s, k) => k > 0 && !keep.has(s) && !s.cut_before && s.end - s.start < 1.5);
    if (i < 0) break;
    const cur = shots[i], prev = shots[i - 1], next = shots[i + 1];
    const fwdOk = next && !next.cut_before && next.end - cur.start <= 5;
    const backOk = i > 1 && cur.end - prev.start <= 5;
    if (i === 1 && fwdOk) { merge(next, cur, true); shots.splice(i, 1); }
    else if (backOk) { merge(prev, cur, false); shots.splice(i, 1); }
    else if (fwdOk) { merge(next, cur, true); shots.splice(i, 1); }
    else { keep.add(cur); continue; }
    log.push({ rule: 'phaseLength', merged: i + 1 });
  }
  const multi = shots.some((s, i) => i > 0 && s.cut_before);

  // ── Overall description ─────────────────────────────────────────────────────────────────
  const look = S.look === 'cinema' ? 'Cinematic vertical video, real camera, natural light' : 'Realistic vertical smartphone video, natural light';
  const parts = [];
  parts.push(sentence(`${look}${dur ? `, ${Math.round(dur)} seconds` : ''}${known(S.setting) ? `, ${clean(S.setting)}` : ''}`));
  // RULE outfitOnce
  const top = known(outfit.top_name);
  const sides = [known(outfit.top_front) && `front: ${clean(outfit.top_front)}`, known(outfit.top_back) && `back: ${clean(outfit.top_back)}`].filter(Boolean);
  const rest = [known(stripIdentity(outfit.bottom)), known(stripIdentity(outfit.shoes)), known(stripIdentity(outfit.accessories))].filter(Boolean);
  if (top || rest.length) {
    parts.push(sentence(`${name} wears ${top || 'the outfit'}${sides.length ? ` (${sides.join('; ')})` : ''}${rest.length ? `, ${rest.join(', ')}` : ''} — the same outfit, fully dressed, in every shot`));
  }
  // References — bindings come from the caller (phase 2+): Wan "Image N", Seedance "@Image N".
  const tag = (n) => (model === 'seedance' ? `@Image ${n}` : `Image ${n}`);
  const refs = Array.isArray(opts.refs) ? opts.refs : [];
  const bind = refs.map((r, i) => {
    const t = tag(i + 1);
    if (r.kind === 'face') return `${t} shows ${name}'s face`;
    if (r.kind === 'outfit_front') return `${t} shows the outfit from the front`;
    if (r.kind === 'outfit_back') return `${t} shows the outfit from the back`;
    if (r.kind === 'first_frame') return `${t} is the opening frame — the video starts exactly as this image`;
    if (r.kind === 'dressed_front') return `${t} shows ${name} wearing the outfit, from the front`;
    if (r.kind === 'dressed_back') return `${t} shows ${name} wearing the outfit, from the back`;
    if (r.kind === 'location') return `${t} shows the location`;
    return r.note ? `${t} shows ${clean(r.note)}` : '';
  }).filter(Boolean);
  if (bind.length) parts.push(sentence(bind.join('; ')));
  // RULE stableLabels — the cast, each once, by a visible label.
  const cast = (Array.isArray(S.cast) ? S.cast : []).filter(p => known(p.label));
  const label = Object.fromEntries(cast.map(p => [p.id, clean(p.label)]));
  if (cast.length) {
    parts.push(sentence(`Also in the video: ${cast.map(p => clean(p.label) + (known(p.look) ? ` (${clean(p.look)})` : '')).join('; ')}`));
    if (S.people_move !== false) parts.push('The people around ' + name + ' keep moving naturally throughout; nobody is frozen.');
  }

  // ── Segments ────────────────────────────────────────────────────────────────────────────
  const segs = [];
  shots.forEach((s, i) => {
    const a = i === 0 ? 0 : s.start, b = s.end;
    let ta = fmt(a, whole), tb = fmt(b, whole);
    if (whole && tb === ta) tb = String(+ta + 1);
    const head = `Shot ${i + 1} [${ta}-${tb}s]:`;
    const bits = [];
    if (i > 0 && !s.cut_before) bits.push('Seamlessly continue from the last frame.');
    const frame = [known(s.size), known(s.angle)].filter(Boolean).join(', ');
    const camS = cameraSentence(s.camera, measuredCameraFor(opts.camera, a, b), log, i + 1); // RULES measuredCamera + fixedShot
    bits.push(sentence([frame, camS].filter(Boolean).join(', ')));
    const ev = (Array.isArray(s.main_events) ? s.main_events : []).map(noTempo).filter(Boolean); // RULE noTempoWords
    if (ev.length && s.main_visible !== false) bits.push(sentence(`${name} ${ev.join(', then ')}`));
    else if (s.main_visible === false) bits.push(sentence(`${name} is not in this shot`));
    const g = s.main_visible === false ? '' : garmentClause(clean(s.garment_side).toLowerCase(), outfit, name); // RULE garmentSide
    if (g) bits.push(sentence(g));
    for (const o of (Array.isArray(s.others) ? s.others : [])) {
      const who = label[o.id] || known(o.label);
      const oev = (Array.isArray(o.events) ? o.events : []).map(noTempo).filter(Boolean);
      if (who && oev.length) bits.push(sentence(`${who} ${oev.join(', then ')}`));
    }
    if (known(s.background)) bits.push(sentence(noTempo(s.background)));
    if (known(s.end_state)) bits.push(sentence(`End of the shot: ${noTempo(s.end_state).replace(/^(the shot ends with|end of the shot:?)\s*/i, '')}`));
    const nxt = shots[i + 1];
    if (nxt && nxt.cut_before) bits.push(model === 'seedance' ? 'Hard cut.' : 'Hard cut.');
    segs.push(`${head} ${bits.join(' ')}`);
  });

  const tail = [];
  if (!multi) tail.push('Generate single shot.');
  if (model === 'wan') tail.push('No dialogue. No background music.'); // RULE wanAudio
  const prompt = nameMain([parts.join(' '), segs.join('\n'), tail.join(' ')].filter(Boolean).join('\n\n'), name);
  return { prompt, words: prompt.split(/\s+/).filter(Boolean).length, segments: shots.map(s => ({ start: s.start, end: s.end, cut_before: !!s.cut_before })), log, rules: Object.keys(RULES) };
}

module.exports = { compile, RULES, RULE_GATE, measuredCameraFor, cameraSentence, garmentClause, stripIdentity, nameMain };
