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
const { UNFOCUS_LAYER } = require('../unfocus');
const { castChangeText } = require('./castChange');

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
  phoneLayer:     'Every phone-look video ends with the old-phone layer (unfocus.js), students included (Mike, 2026-10-20). Cinema-look videos keep none.',
  castChange:     'Each clearly visible background person carries its one small change (v2/castChange.js, picked once at analysis) after its label, the same change the first frame drew, so a later shot does not pull the original look back (Mike, 2026-10-23, VQL case 2026-10-23-01). Product-only runs keep everyone as the source shows them.',
  oneHeaderPerTake: '"Shot N [a-bs]:" is Wan\'s own cut syntax, so only a measured cut opens a new Shot; phases inside one take are "[a-bs]" lines. Evidence (2026-10-30): plaza remake, 5 jumps in a one-take source; Classic writes no Shot labels in a take since 2026-10-01.',
  framingInTake:  'Inside one take a size change is written as the framing moving within the take, never as a new size with a held camera (which only a cut can deliver); an unchanged framing is not repeated. Evidence: plaza 9.0 s medium → close-up = a jump.',
  fewerActions:   'Later phases (never the hook) shed repeats, "continues/keeps" restatements and "slightly" micro-moves down to ~1.5 actions per second; object actions and the last action stay. Evidence: plaza phase of 19 actions in 4.9 s; the sunglasses went on between two frames.',
  propsPlaced:    'An object MAIN puts on, takes off, picks up or hands over later is placed in the opening ("At the start: sunglasses folded in the right hand"), so it does not pop in. Evidence: plaza sunglasses (2026-10-30) — the source hid the put-on behind a passer-by, our take had neither the passer-by nor the starting place.',
  unfocus:        'Real Unfocus Look (owner switch): the old-phone layer only. The autofocus moment is added to the finished video (focusblur.js) since 2026-10-14: Wan rendered no dip on two takes that carried a timed sentence.',
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
  // Whitelist FIRST (/toolscan 2026-10-09): the RegExp was built from the writer's free text before the
  // whitelist ran, so a direction like "left)" threw and failed the whole paid run with a 500.
  if (dir && /^(left|right|up|down)$/.test(dir) && !new RegExp(`\\b${dir}\\b`).test(s)) s += ` ${dir}`;
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

// RULE framingInTake — shot sizes from tight to wide, to say whether a framing tightens or widens.
const SIZE_ORDER = ['extreme close-up', 'close-up', 'medium close-up', 'medium', 'medium wide', 'full body', 'wide', 'extreme wide'];
function sizeRank(size) {
  const s = clean(size).toLowerCase().replace(/\s*shot$/, '');
  const i = SIZE_ORDER.indexOf(s);
  return i >= 0 ? i : SIZE_ORDER.findIndex(x => s.includes(x));
}
function sizePhrase(size) {
  const s = clean(size).toLowerCase().replace(/\s*shot$/, '');
  if (/close-up$/.test(s)) return `${/^extreme/.test(s) ? 'an' : 'a'} ${s}`;
  return `${/^[aeiou]/.test(s) ? 'an' : 'a'} ${s} shot`;
}

// RULE fewerActions (2026-10-30, VQL 2026-10-30-01): a later phase that lists 19 actions in 4.9 s
// ("continues smiling", "keeps smiling", "tilts head slightly" …) made the model rush between poses and
// skip the one action that mattered (the sunglasses went on between two frames). The HOOK is never
// touched (80% of the effort, every small movement kept). Later phases lose, in this order and only
// until they are under ~1.5 actions per second: repeats of the action before, "continues/keeps/still …"
// restatements, then "slightly" micro-moves. The last action of a phase always stays (it leads into
// the next one), and an action that puts on, takes off, picks up, puts down or hands over something is
// never dropped.
// An ONGOING MOVEMENT is not filler (reviewer 2026-10-30): "continues walking toward the camera" is what keeps a
// walk-in walking across phases (P10, frozen subject).
const FILLER = /^(continues?|keeps?|still|remains?)\b(?!\s+(?:to\s+)?(?:walk|run|danc|driv|rid|jog|spin|climb|mov|swim|skat|march|stroll|approach|step|wav|sway|bounc))/i;
const MICRO = /\bslightly\b/i;
// The verb must LEAD the action ("mouth open as if laughing" is not an object action).
const OBJECT_ACTION = /^(?:\w+ and )?(puts?|takes?|picks?|hands?|removes?|lifts?|grabs?|pulls?|drops?|places?|throws?|opens?|closes?|swaps?|gives?)\b/i;
function trimEvents(ev, secs, hook, log, shotNo) {
  if (hook || ev.length <= 2) return ev;
  const cap = Math.max(3, Math.ceil((secs > 0 ? secs : 2) * 1.5));
  let out = ev.filter((e, i) => i === 0 || e.toLowerCase() !== ev[i - 1].toLowerCase());
  // One action at a time, earliest first, and stop at the cap (reviewer 2026-10-30: a whole-pass filter
  // dropped 7 → 2 in a 2 s phase, taking reactions that can be the punchline).
  for (const test of [FILLER, MICRO]) {
    while (out.length > cap) {
      const i = out.findIndex((e, k) => k < out.length - 1 && !OBJECT_ACTION.test(e) && test.test(e));
      if (i < 0) break;
      out.splice(i, 1);
    }
  }
  if (out.length < ev.length) log.push({ rule: 'fewerActions', shot: shotNo, from: ev.length, to: out.length });
  return out.length ? out : ev;
}

/**
 * compile(spec, opts) → { prompt, words, segments, log, rules }
 * opts: { name, gender:'male'|'female'|null, model:'wan'|'seedance', cuts:[s], camera:[segments],
 *         durationSec, refs:[{kind:'face'|'outfit_front'|'outfit_back'|'first_frame'|'location', note}],
 *         unfocus:bool, focus:[{from,to,low}] (focusshift.py) }
 */
function compile(spec, opts = {}) {
  const name = clean(opts.name) || 'the main person';
  // 📦 PRODUCT ONLY (2026-10-22, Mike: "the prompt is really short … only on product recreation videos"). No
  // influencer: the person of the original stays as the first frame shows them, and the PRODUCT gets its own line
  // per shot from s.product_events (what the replaced object does — motion only, never its looks: RULE R3). Every
  // branch below is guarded by productOnly, so a normal recreate compiles byte-for-byte as before.
  const productOnly = opts.productOnly === true;
  const productName = clean(opts.productName) || 'the product';
  const model = opts.model === 'seedance' ? 'seedance' : 'wan';
  const whole = model === 'seedance';
  const dur = Number(opts.durationSec) || Number(spec && spec.durationSec) || 0;
  const cuts = (opts.cuts || []).filter(c => c > 0.15 && (!dur || c < dur - 0.15)).sort((a, b) => a - b);
  const log = [];
  const S = spec || {};
  const outfit = S.outfit || {};
  // RULE propsPlaced — where each object MAIN uses later sits at the start (VQL 2026-10-30-01: the
  // sunglasses appeared from nowhere — the prompt never said they were in his hand from the first frame).
  const props = (Array.isArray(S.props) ? S.props : []).map(x => known(noTempo(x))).filter(x => x && x.length <= 120 && !IDENTITY.test(x)).slice(0, 3);
  let shots = Array.isArray(S.shots) ? S.shots.map(x => ({ ...x })) : [];
  shots.sort((a, b) => (+a.start || 0) - (+b.start || 0));

  // RULE measuredCuts — snap shot starts to measured cuts, force cut_before on them, close gaps.
  for (const c of cuts) {
    let best = null, bd = 1e9;
    shots.forEach((s, i) => { const d = Math.abs((+s.start || 0) - c); if (i > 0 && d < bd) { bd = d; best = s; } });
    if (best && bd <= 0.45) { if (Math.abs(best.start - c) > 0.01) log.push({ rule: 'measuredCuts', snapped: [best.start, c] }); best.start = c; best.cut_before = true; continue; }
    // Second chance (2026-10-30): the writer saw this cut but put it up to 1.2 s off. Measured cuts now
    // ALWAYS decide (below), so without this snap the writer's mistimed cut would be cleared and the
    // real one lost. Only a start the writer itself marked as a cut qualifies, never a phase.
    let near = null, nd = 1e9;
    shots.forEach((s, i) => { const d = Math.abs((+s.start || 0) - c); if (i > 0 && s.cut_before && !cuts.some(x => Math.abs(x - (+s.start || 0)) < 0.01) && d < nd) { nd = d; near = s; } });
    if (near && nd <= 1.2) { log.push({ rule: 'measuredCuts', snapped: [near.start, c] }); near.start = c; near.cut_before = true; }
    else log.push({ rule: 'measuredCuts', missing: c });
  }
  if (shots.length) shots[0].start = 0;
  for (let i = 0; i < shots.length; i++) {
    const next = shots[i + 1];
    shots[i].end = next ? next.start : (dur || +shots[i].end || shots[i].start + 1);
    // RULE measuredCuts — a cut exists ONLY where one was measured. Until 2026-10-30 the writer's own
    // cut_before survived whenever at least ONE cut was measured (it was cleared only on zero cuts), so
    // an invented cut rode along with a real one (VQL 2026-10-30-01: plaza, 1 measured cut + 1 invented
    // at 4.1 s → a jump cut in the take).
    if (i > 0 && cuts.some(c => Math.abs(c - shots[i].start) < 0.01)) shots[i].cut_before = true;
    else if (i > 0) { if (shots[i].cut_before) log.push({ rule: 'measuredCuts', dropped: shots[i].start }); shots[i].cut_before = false; }
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
  const look = S.look === 'cinema' && !opts.unfocus ? 'Cinematic vertical video, real camera, natural light' : 'Realistic vertical smartphone video, natural light'; // RULE unfocus: never the cinema look
  const parts = [];
  parts.push(sentence(`${look}${dur ? `, ${Math.round(dur)} seconds` : ''}${known(S.setting) ? `, ${clean(S.setting)}` : ''}`));
  // RULE outfitOnce
  const top = known(outfit.top_name);
  const sides = [known(outfit.top_front) && `front: ${clean(outfit.top_front)}`, known(outfit.top_back) && `back: ${clean(outfit.top_back)}`].filter(Boolean);
  const rest = [known(stripIdentity(outfit.bottom)), known(stripIdentity(outfit.shoes)), known(stripIdentity(outfit.accessories))].filter(Boolean);
  // RULE bareTop (2026-10-12): a SHIRTLESS source was compiled as "Kryfex wears no top worn, shirtless (front: not
  // shown, bare chest …) — the same outfit, fully dressed, in every shot": the prompt contradicted itself on every
  // bare-torso video. A shirtless outfit is said as such; any other outfit that leaves torso or legs bare drops
  // "fully dressed" (it still says "same outfit in every shot").
  const skin = Array.isArray(outfit.bare_skin) ? outfit.bare_skin.map(x => String(x).toLowerCase()) : [];
  // 2026-10-31 (VQL 2026-10-26-01): an OPEN top is not "no top". A café polo "worn open at the collar" whose front read
  // "… bare chest" compiled as "Kryfex is shirtless …" while every shot named the polo, and the take went shirtless twice.
  // The shirtless words count only in the top's NAME, and not when that name is a garment ("no shirt" is not one); the
  // front description decides only when no top is named. Twin of the tool's rlIdentityMode (RL_SHIRTLESS, RL_TOP_GARMENT,
  // RL_NO_TOP, RL_NEG_GARMENT) — keep the four lists identical.
  const BARE_TOP = /\b(shirtless|topless|no top|bare[- ]?chest(ed)?|bare[- ]torso)\b/i;
  const TOP_GARMENT = /\b(shirt|t-shirt|tee|polo|henley|blouse|jacket|blazer|coat|hoodie|sweater|jumper|cardigan|overshirt|jersey|vest|waistcoat|kimono|robe|suit)\b/i;
  const NEG_GARMENT = /\b(no|without)\s+(an?\s+)?(shirt|t-shirt|tee|polo|henley|blouse|jacket|blazer|coat|hoodie|sweater|jumper|cardigan|overshirt|jersey|vest|waistcoat|kimono|robe|suit)s?\b/gi;
  const NO_TOP = /^(|none|n\/?a|unknown|not shown|not visible|cannot be determined|no top|nothing|-)\.?$/i;
  const topName = String(outfit.top_name || '');
  const bareTop = (BARE_TOP.test(topName) && !TOP_GARMENT.test(topName.replace(NEG_GARMENT, '')))
    || (NO_TOP.test(topName.trim()) && (BARE_TOP.test(`${outfit.top_front || ''}`) || skin.some(x => x === 'chest' || x === 'belly')));
  const bareSome = bareTop || skin.some(x => ['shoulders', 'chest', 'belly', 'back', 'legs', 'feet'].includes(x));
  const noMainPerson = productOnly && !shots.some(x => x.main_visible !== false);   // visible counts, even without actions (reviewer)
  if (noMainPerson) { /* 📦 nobody to dress — the outfit lines would describe a person who is not there */ }
  else if (bareTop) {
    parts.push(sentence(`${name} is shirtless${rest.length ? `, wearing ${rest.join(', ')}` : ''} — the same in every shot, the bare chest, belly and back showing ${name}'s own skin from the reference images`));
    log.push({ rule: 'bareTop' });
  } else if (top || rest.length) {
    parts.push(sentence(`${name} wears ${top || 'the outfit'}${sides.length ? ` (${sides.join('; ')})` : ''}${rest.length ? `, ${rest.join(', ')}` : ''} — the same outfit${bareSome ? '' : ', fully dressed,'} in every shot`));
  }
  // References — bindings come from the caller (phase 2+): Wan "Image N", Seedance "@Image N".
  const tag = (n) => (model === 'seedance' ? `@Image ${n}` : `Image ${n}`);
  const refs = Array.isArray(opts.refs) ? opts.refs : [];
  const bind = refs.map((r, i) => {
    const t = tag(i + 1);
    if (r.kind === 'face') return `${t} shows ${name}'s face`;
    // 2026-10-12: a tattooed influencer's own master photos (the Classic recreate's video references).
    // 2026-10-30 (VQL 2026-10-30-02): "body" only where skin shows — on a clothed scene the word pointed the model at the
    // masters' bare torso (a henley close-up came back shirtless); there the pictures are for face, hair and ink only.
    if (r.kind === 'identity') return `${t} shows ${name} — the face, hair${bareSome ? ', body' : ''} and every tattoo`;
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
    // RULE castChange — the label stays the id everywhere; the change rides once, here, after the clothing.
    const withChange = (p) => { const c = productOnly ? '' : castChangeText(p); if (c) log.push({ rule: 'castChange', id: p.id }); return c; };
    parts.push(sentence(`Also in the video: ${cast.map(p => { const c = withChange(p); const look = known(p.look) ? clean(p.look) : ''; return clean(p.label) + (look || c ? ` (${[look, c && 'with ' + c].filter(Boolean).join('; ')})` : ''); }).join('; ')}`));
    if (S.people_move !== false) parts.push(noMainPerson ? 'The people in the video keep moving naturally throughout; nobody is frozen.' : 'The people around ' + name + ' keep moving naturally throughout; nobody is frozen.');
  }

  // ── Segments ────────────────────────────────────────────────────────────────────────────
  // RULE oneHeaderPerTake (2026-10-30, VQL 2026-10-30-01): "Shot N [a-bs]:" is Wan's OWN cut syntax
  // (Alibaba's multi-shot guide), so it is written only where a MEASURED cut starts a new take. The
  // phases inside one take are plain "[a-bs]" lines under it — the shape Classic has used since
  // 2026-10-01 ("do NOT write Shot labels … it is one continuous take"). Until then every phase got a
  // "Shot N" header plus the sentence "Seamlessly continue from the last frame.", and the takes jumped
  // at phase boundaries (plaza: 5 jumps in a source with none).
  const takes = [];
  shots.forEach((s, i) => { if (i === 0 || s.cut_before) takes.push([]); takes[takes.length - 1].push(i); });
  const segs = [];
  let prevFrame = null;   // { size, angle, cam } of the phase before, inside the current take
  let prevTb = null;      // whole-second rounding must stay contiguous (reviewer 2026-10-30: Seedance printed Shot 1 [0-3s] then Shot 2 [2-10s])
  takes.forEach((idxs, k) => {
    const lines = [];
    idxs.forEach((i, j) => {
      const s = shots[i];
      const a = i === 0 ? 0 : s.start, b = s.end;
      let ta = fmt(a, whole), tb = fmt(b, whole);
      if (whole && prevTb !== null && +ta < +prevTb) ta = prevTb;
      // A phase that rounds to nothing inside a take joins the line before it (its actions kept, no
      // 1 s bump that would push past the next cut); a take's FIRST phase still gets its 1 s.
      const collapsed = whole && +tb <= +ta && j > 0;
      if (whole && +tb <= +ta && !collapsed) tb = String(+ta + 1);
      if (!collapsed) prevTb = tb;
      const bits = [];
      const size = known(s.size), angle = known(s.angle);
      const camS = cameraSentence(s.camera, measuredCameraFor(opts.camera, a, b), log, i + 1); // RULES measuredCamera + fixedShot
      if (j === 0) {
        bits.push(sentence([size, angle, camS].filter(Boolean).join(', ')));
      } else {
        // RULE framingInTake — inside one take the size is not restated as a new framing with a held
        // camera (only a cut can deliver that); a change is written as the framing moving within the
        // take, and an unchanged framing/camera is not repeated.
        const fixed = /^fixed shot/.test(camS);
        const sizeChanged = size && prevFrame && prevFrame.size && size.toLowerCase() !== prevFrame.size.toLowerCase();
        const angleChanged = angle && prevFrame && prevFrame.angle && angle.toLowerCase() !== prevFrame.angle.toLowerCase();
        if (sizeChanged || angleChanged) {
          const to = [size ? sizePhrase(size) : '', angleChanged ? angle : ''].filter(Boolean).join(', ');
          const ra = sizeRank(prevFrame.size), rb = sizeRank(size);
          const verb = sizeChanged && ra >= 0 && rb >= 0 ? (rb < ra ? 'tightens' : rb > ra ? 'widens' : 'moves') : 'moves';
          // A held camera cannot zoom: the framing changed because MAIN moved (reviewer 2026-10-30 — "the framing
          // tightens" with a fixed camera invites the 09-30 push-in drift). A moving camera says how it moved.
          const dist = fixed && sizeChanged && s.main_visible !== false && prevFrame.mainVisible && verb !== 'moves' ? `${name} has ${verb === 'tightens' ? 'come closer' : 'moved further away'}: ` : '';
          if (fixed) bits.push(sentence(`${dist}within the same take the framing is now ${to}, the camera still does not move`));
          else bits.push(sentence(`within the same take the framing ${verb} to ${to}, ${camS}`));
          log.push({ rule: 'framingInTake', shot: i + 1, from: prevFrame.size, to: size });
        } else if (camS !== prevFrame.cam) {
          bits.push(sentence(fixed ? 'the camera now holds still' : camS));
        }
      }
      prevFrame = { size: size || (prevFrame && prevFrame.size) || '', angle: angle || (prevFrame && prevFrame.angle) || '', cam: camS, mainVisible: s.main_visible !== false };
      const hook = i === 0;
      const ev = trimEvents((Array.isArray(s.main_events) ? s.main_events : []).map(noTempo).filter(Boolean), b - a, hook, log, i + 1); // RULES noTempoWords + fewerActions
      if (hook && props.length && s.main_visible !== false) bits.push(sentence(`At the start: ${props.join('; ')}`)); // RULE propsPlaced
      if (ev.length && s.main_visible !== false) bits.push(sentence(`${name} ${ev.join(', then ')}`));
      else if (s.main_visible === false && !productOnly) bits.push(sentence(`${name} is not in ${idxs.length > 1 ? 'the frame' : 'this shot'}`));
      if (productOnly) {   // 📦 the product's own action in this shot — the hook (shot 1) gets the most detail upstream
        const pev = (Array.isArray(s.product_events) ? s.product_events : []).map(noTempo).filter(Boolean);
        if (pev.length) bits.push(sentence(`${productName} ${pev.join(', then ')}`));
      }
      const g = s.main_visible === false ? '' : garmentClause(clean(s.garment_side).toLowerCase(), outfit, name); // RULE garmentSide
      if (g) bits.push(sentence(g));
      for (const o of (Array.isArray(s.others) ? s.others : [])) {
        const who = label[o.id] || known(o.label);
        const oev = (Array.isArray(o.events) ? o.events : []).map(noTempo).filter(Boolean);
        if (who && oev.length) bits.push(sentence(`${who} ${oev.join(', then ')}`));
      }
      if (known(s.background)) bits.push(sentence(noTempo(s.background)));
      const lastInTake = j === idxs.length - 1;
      if (known(s.end_state)) {
        const es = noTempo(s.end_state).replace(/^(the shot ends with|end of the shot:?)\s*/i, '');
        bits.push(sentence(lastInTake ? `End of the shot: ${es}` : `At ${tb}s: ${es}`));
      }
      if (lastInTake && k < takes.length - 1) bits.push('Hard cut.');
      if (collapsed) { const prev = lines[lines.length - 1]; prev.body += ' ' + bits.filter(x => !prev.body.includes(x)).join(' '); prev.body = prev.body.trim(); }
      else lines.push({ ta, tb, body: bits.join(' ') });
    });
    const ka = lines[0].ta, kb = lines[lines.length - 1].tb;
    if (takes.length > 1) {
      if (lines.length === 1) segs.push(`Shot ${k + 1} [${ka}-${kb}s]: ${lines[0].body}`);
      else segs.push([`Shot ${k + 1} [${ka}-${kb}s]:`, ...lines.map(l => `[${l.ta}-${l.tb}s] ${l.body}`)].join('\n'));
    } else {
      segs.push(lines.map(l => `[${l.ta}-${l.tb}s] ${l.body}`).join('\n'));
    }
  });

  const tail = [];
  // RULE phoneLayer (Mike, 2026-10-20: "can we use this on all non high end videos we make?" → "yes build it"):
  // the old-phone layer rides on EVERY phone-look video, not only when the owner's unfocus switch is on. A
  // cinema-look source keeps no phone layer, unless the switch turns it into a phone video (RULE unfocus).
  if (opts.unfocus || S.look !== 'cinema') {
    tail.push(UNFOCUS_LAYER);   // the autofocus moment is added after generation (focusblur.js), never prompted
  }
  if (!multi) tail.push('Generate single shot.');
  if (model === 'wan') tail.push('No dialogue. No background music.'); // RULE wanAudio
  const prompt = nameMain([parts.join(' '), segs.join('\n'), tail.join(' ')].filter(Boolean).join('\n\n'), name);
  return { prompt, words: prompt.split(/\s+/).filter(Boolean).length, segments: shots.map(s => ({ start: s.start, end: s.end, cut_before: !!s.cut_before })), log, rules: Object.keys(RULES) };
}

module.exports = { compile, RULES, RULE_GATE, measuredCameraFor, cameraSentence, garmentClause, stripIdentity, nameMain };
