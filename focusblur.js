// 🔍 FOCUS BLUR AFTER GENERATION (2026-10-14, Mike). The Real Unfocus Look used to ASK the video model for
// an autofocus moment in the prompt. Measured that day with ffmpeg blurdetect: Wan 3.0 rendered no dip at
// all on two takes that carried the sentence (lipstick, via the normal route with measured timings; Monaco,
// hand-built). So the prompt sentence is gone (unfocus.js) and the moment is added here, to the finished
// video, where it lands exactly where we put it, every time.
//
// WHERE IT GOES — Mike's rules, same day:
//   - "most people watch the beginning not the end": early in the video, never at the end;
//   - "not during the action": never on the moment that matters, so a calm stretch, ideally just before
//     the action starts (his approved take: 0.5–1.05 s, sharp again exactly as the grandmother turns);
//   - "doesn't need to be the first second always … where it fits best without blocking important shots";
//   - never in a close-up (an older house rule: the focus never drops while the person is shown up close).
// The first frame stays sharp too: it is the thumbnail and the hook frame.
'use strict';

const LEN = 0.55;          // seconds of soft image (in 0.1, soft 0.35, out 0.1)
const FIRST = 0.4;         // never before this — the opening frame stays sharp
const EARLY_END = 4.0;     // "preferably in the beginning": search here first
const CUT_GAP = 0.2;       // a blur across or right next to a cut reads as an edit, not a phone
const EARLY_BONUS = 0.08;  // score per second of delay — earlier wins when the motion is similar

const r2 = (x) => Math.round(x * 100) / 100;

/** When the main action starts: the first moment the people's own movement (subjectmotion.py) clearly rises
 *  above the opening level. null when the video never settles or never rises. */
function actionOnset(motion, step = 0.1) {
  const at = (i) => { const xs = [motion[i - 1], motion[i], motion[i + 1]].filter((v) => Number.isFinite(v)); return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN; };
  const all = motion.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (all.length < 8) return null;
  const median = all[Math.floor(all.length / 2)];
  const opening = motion.slice(1, Math.round(0.45 / step)).filter((v) => Number.isFinite(v));
  if (!opening.length) return null;
  const base = opening.reduce((s, v) => s + v, 0) / opening.length;
  const bar = Math.max(1.6 * base, 0.8 * median);
  for (let i = Math.round(0.3 / step); i < motion.length - 1; i++) if (at(i) > bar) return r2(i * step);
  return null;
}

/**
 * Pick the soft moment. Pure, so the selftest can pin it.
 * motion: per-sample movement of the PEOPLE (subjectmotion.py, camera move removed), `step` s apart from t=0.
 * cuts:   cut times in seconds (measured on the generated video).
 * avoid:  [[from,to]] ranges that must stay sharp (close-ups from the shot plan).
 * Returns { from, to, reason } or null when nothing fits.
 *
 * First choice — Mike's approved take: soft just BEFORE the action and sharp again right as it begins
 * (the window ends ~0.3 s after the onset, so the snap-to-sharp lands on the first move). Then the same
 * spot moved EARLIER (never later, into the action) to clear a cut or a close-up. Last resort: the earliest
 * clear stretch that is calmer than the video's typical movement; otherwise no blur at all.
 */
function pickBlurWindow({ duration, motion = [], step = 0.1, cuts = [], avoid = [] }) {
  const D = Number(duration) || 0;
  if (D < FIRST + LEN + 0.5) return null;
  const lastStart = Math.min(EARLY_END, D - LEN - 0.5);
  const clear = (a, b) => !cuts.some((c) => c > a - CUT_GAP && c < b + CUT_GAP)
    && !avoid.some(([x, y]) => a < y && b > x);
  const onset = actionOnset(motion, step);
  if (onset !== null) {
    // The soft moment may run at most ~0.3 s into the action (so it snaps sharp on the first move), or to
    // FIRST+LEN when the action starts in the first half-second — Mike's approved take: onset 0.5, blur 0.5–1.05.
    // To clear a cut or a close-up it only ever moves EARLIER, never later into the action (reviewer, 2026-10-14).
    const ideal = Math.max(FIRST, onset + 0.3 - LEN);
    for (let d = 0; d >= -1.0 - 1e-9; d -= 0.1) {
      const a = r2(ideal + d);
      if (a < FIRST - 1e-9 || a > lastStart + 1e-9) continue;
      if (clear(a, r2(a + LEN))) return { from: a, to: r2(a + LEN), reason: `before the action (starts ~${onset}s)`, onset };
    }
  }
  const vals = motion.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] || 1e-6 : 1;
  const meanAt = (a, b) => {
    const xs = motion.slice(Math.max(0, Math.floor(a / step)), Math.min(motion.length, Math.ceil(b / step))).filter((v) => Number.isFinite(v));
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : Infinity;
  };
  // Only seconds that were actually measured count — beyond the motion samples nothing is known to be calm.
  const measuredEnd = motion.length * step;
  const search = (last) => {
    last = Math.min(last, measuredEnd - LEN);
    let best = null;
    for (let s = FIRST; s <= last + 1e-9; s += 0.1) {
      const a = r2(s), b = r2(s + LEN);
      if (!clear(a, b)) continue;
      // Calmer than the video's typical movement, or it is part of the action — and then no blur beats a blur
      // on the action (Mike: "not during the action").
      if (!(meanAt(a, b) < 0.9 * median)) continue;
      const score = meanAt(a, b) / median + EARLY_BONUS * a;
      if (!best || score < best.score) best = { from: a, to: b, score };
    }
    return best;
  };
  const early = search(lastStart);
  if (early) return { from: early.from, to: early.to, reason: 'calmest clear stretch early in the video', onset };
  const late = search(D - LEN - 1.0);
  if (late) return { from: late.from, to: late.to, reason: 'no clear early stretch; the first clear one later', onset };
  return null;
}

/** The ffmpeg video filter for a window: soft in, soft, sharp again. (The 2026-10-14 fixed curve, kept for
 *  the tests that pin it; planFilter below is what the route uses since 2026-10-15.) */
function blurFilter({ from }) {
  const a = r2(from), b = r2(from + 0.1), c = r2(from + 0.45), d = r2(from + LEN);
  return `gblur=sigma=3:enable='between(t,${a},${b})',gblur=sigma=8:enable='between(t,${b},${c})',gblur=sigma=2.5:enable='between(t,${c},${d})'`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🎲 RANDOMIZED FOCUS (2026-10-15, Mike: "if we do exactly the same on every video on an account, then it's
// going to be obvious that it's fake … the autofocus was a little bit too much"). Measured that day against the
// grandmother reel the look was modelled on, both at 480 px: the reel's deepest dip falls to 12–18 % of its
// normal sharpness and comes back over ~0.3–0.7 s; ours fell to ~1 % (sigma 8) and snapped back in one frame,
// always once, always early. Mike approved five changes, all here:
//   1. STRENGTH — weaker and varied: mostly a mild hunt (peak sigma 0.9–1.5 at 720 p ≈ 35–55 % sharpness),
//      sometimes a deeper dip (sigma 1.9–2.7 ≈ 8–15 %, the reel's range). Never sigma 8 again.
//   2. SHAPE — a quick drop, a short hold, then focus creeping back in steps, like a phone finding it again.
//   3. COUNT — some videos none, most one, a few two (of different strengths).
//   4. WHERE — a random clear spot in the first two thirds, not always the start; still never the opening
//      frame (thumbnail/hook), a cut, a close-up or the action itself.
//   5. MEMORY — `recent` (the influencer's last plans, kept by the tool) steers away from repeating them.
// The reel itself may be AI-made too (Mike); it is the taste target, not proof of phone physics.
const MILD = [0.9, 1.5], DEEP = [1.9, 2.7];
const P_NONE = 0.2, P_TWO = 0.2, P_DEEP = 0.35;
const MAX_END_FRAC = 2 / 3;   // never in the last third
const GAP_TWO = 1.5;          // two moments at least this far apart
const NEAR_RECENT = 0.7;      // a start this close to a recent video's start counts as "the same spot"

/** mulberry32 — a seeded generator so the selftest can pin a draw; production passes no seed. */
function rngFrom(seed) {
  if (seed === undefined || seed === null) return Math.random;
  let a = (Number(seed) >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (rng, [lo, hi]) => lo + (hi - lo) * rng();

/** The shape of ONE moment: drop, hold, recover. Lengths are part of the randomness. */
function drawShape(rng, depth) {
  const peak = Math.round(between(rng, depth === 'deep' ? DEEP : MILD) * 10) / 10;
  const drop = r2(between(rng, [0.06, 0.12]));
  const hold = r2(between(rng, depth === 'deep' ? [0.25, 0.5] : [0.15, 0.35]));
  const recover = r2(between(rng, depth === 'deep' ? [0.35, 0.65] : [0.25, 0.45]));
  return { depth, peak, drop, hold, recover, len: r2(drop + hold + recover) };
}

/**
 * Plan 0–2 soft moments for one video. Pure (given `seed`), so the selftest can pin it.
 * Same inputs as pickBlurWindow plus `recent`: [{ count, events:[{from, depth}] }] newest first.
 * Returns { events:[{from,to,depth,peak,drop,hold,recover,reason}], count, reason }.
 */
function planFocusBlur({ duration, motion = [], step = 0.1, cuts = [], avoid = [], recent = [], seed } = {}) {
  const rng = rngFrom(seed);
  const D = Number(duration) || 0;
  const rec = (Array.isArray(recent) ? recent : []).slice(0, 5);
  const none = (reason) => ({ events: [], count: 0, reason });
  if (D < FIRST + 1.2) return none('video too short');

  // 3. COUNT — never "none" twice in a row for one influencer, never "two" twice in a row.
  let pNone = P_NONE, pTwo = P_TWO;
  if (rec[0] && rec[0].count === 0) pNone = 0;
  if (rec[0] && rec[0].count >= 2) pTwo = 0;
  const u = rng();
  const want = u < pNone ? 0 : (u < pNone + pTwo ? 2 : 1);
  if (want === 0) return none('none this time (random, so not every video has one)');

  // 1. STRENGTH — if the last two first-moments were the same depth, take the other one.
  const lastDepths = rec.map((r) => r && r.events && r.events[0] && r.events[0].depth).filter(Boolean);
  let depth1 = rng() < P_DEEP ? 'deep' : 'mild';
  if (lastDepths.length >= 3 && lastDepths[0] === lastDepths[1] && lastDepths[1] === lastDepths[2]) depth1 = lastDepths[0] === 'deep' ? 'mild' : 'deep';
  const shapes = [drawShape(rng, depth1)];
  if (want === 2) shapes.push(drawShape(rng, depth1 === 'deep' ? 'mild' : (rng() < 0.5 ? 'deep' : 'mild')));

  // 4. WHERE — every clear, calm start in [FIRST, 2/3 of the video], weighted toward calm, plus the spot just
  // before the action (Mike's approved take) as one candidate among them rather than the rule.
  const vals = motion.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] || 1e-6 : 1;
  const measuredEnd = motion.length * step;
  // The calm bar adapts to the video. With real action peaks (the busiest quarter well above the median) a spot
  // must be clearly calmer than typical, < 0.9 × median — the 2026-10-14 rule; loosening it to 1.1 put a deep
  // dip on the grandmother's pointing (3.3 s, sample render 2026-10-15). A FLAT video (busiest quarter close to
  // the median) has every calm second AT its median, so there ≤ 1.1 × median counts as calm.
  const p75 = vals.length ? vals[Math.floor(vals.length * 0.75)] : 0;
  const calmBar = p75 <= 1.3 * median ? 1.1 * median : 0.9 * median;
  const meanAt = (a, b) => {
    const xs = motion.slice(Math.max(0, Math.floor(a / step)), Math.min(motion.length, Math.ceil(b / step))).filter((v) => Number.isFinite(v));
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : Infinity;
  };
  const clear = (a, b, taken) => !cuts.some((c) => c > a - CUT_GAP && c < b + CUT_GAP)
    && !avoid.some(([x, y]) => a < y && b > x)
    && !taken.some(([x, y]) => a < y + GAP_TWO && b > x - GAP_TWO);
  const recentStarts = rec.flatMap((r) => (r && Array.isArray(r.events) ? r.events.map((e) => Number(e.from)) : [])).filter(Number.isFinite);
  const onset = actionOnset(motion, step);
  // Start of the before-the-action spot for a moment of this length: ends ~0.3 s after the onset.
  // When the action starts very early it is clamped to FIRST and may then run up to ~0.9 s into the first move,
  // as Mike's approved take did (onset 0.5, soft 0.5–1.05; the tail is the faint refocus).
  const before = (sh) => {
    if (onset === null) return null;
    const a = r2(Math.max(FIRST, onset + 0.3 - sh.len));
    return a + sh.len <= onset + 0.9 + 1e-9 ? a : null;
  };

  const events = [], taken = [];
  for (const sh of shapes) {
    const lastStart = Math.min(D * MAX_END_FRAC - sh.len, measuredEnd - sh.len);
    const cands = [];
    const starts = [];
    for (let s = FIRST; s <= lastStart + 1e-9; s += 0.1) starts.push(r2(s));
    if (before(sh) !== null && before(sh) <= lastStart + 1e-9 && !starts.some((x) => Math.abs(x - before(sh)) < 0.05)) starts.push(before(sh));
    for (const a0 of starts) {
      const a = r2(a0), b = r2(a + sh.len);
      if (!clear(a, b, taken)) continue;
      const m = meanAt(a, b);
      // The spot just before the action (Mike's approved take) ends ~0.3 s into the first move by design, so it
      // is exempt from the calm test; every other spot must pass the calm bar below — on
      // the action → never (Mike: "not during the action").
      const isBefore = before(sh) !== null && Math.abs(a - before(sh)) < 0.05;
      if (!isBefore && !(m <= calmBar)) continue;
      // calmer = likelier; a recent video's spot = much less likely (5. MEMORY)
      // Flat-ish weights: calmer helps, but every clear calm spot keeps a real chance (spread, not a habit).
      let w = isBefore ? 1.5 : 0.4 + 0.6 * Math.max(0, 1 - m / median);
      if (recentStarts.some((r) => Math.abs(r - a) < NEAR_RECENT)) w *= 0.15;
      cands.push({ a, b, w, isBefore });
    }
    if (!cands.length) continue;
    let x = rng() * cands.reduce((s, c) => s + c.w, 0), pick = cands[cands.length - 1];
    for (const c of cands) { x -= c.w; if (x <= 0) { pick = c; break; } }
    taken.push([pick.a, pick.b]);
    events.push({ from: pick.a, to: pick.b, ...sh,
      reason: pick.isBefore ? `just before the action (~${onset}s)` : 'random calm spot' });
  }
  events.sort((p, q) => p.from - q.from);
  if (!events.length) return none('no clear calm stretch');
  return { events, count: events.length, reason: events.map((e) => `${e.from}-${e.to}s ${e.depth}`).join(', ') };
}

/** The ffmpeg filter for a plan: per moment a quick drop to the peak, a hold, then focus returning in steps. */
function planFilter(events) {
  const parts = [];
  for (const e of events || []) {
    const a = r2(e.from), d1 = r2(a + e.drop), h = r2(d1 + e.hold), end = r2(h + e.recover);
    // Half-open [x, y): ffmpeg's between() includes both ends, so a frame landing exactly on a shared boundary
    // got two blurs stacked (reviewer, 2026-10-15: up to sigma 3.22 and a one-frame jump in the recovery).
    const seg = (sig, x, y) => { if (y > x && sig >= 0.2) parts.push(`gblur=sigma=${r2(sig)}:enable='gte(t,${x})*lt(t,${y})'`); };
    seg(e.peak * 0.5, a, d1);
    seg(e.peak, d1, h);
    const third = (end - h) / 3;
    seg(e.peak * 0.65, h, r2(h + third));
    seg(e.peak * 0.4, r2(h + third), r2(h + 2 * third));
    seg(e.peak * 0.2, r2(h + 2 * third), end);
  }
  return parts.join(',');
}

module.exports = { pickBlurWindow, actionOnset, blurFilter, planFocusBlur, planFilter, rngFrom, LEN, FIRST, EARLY_END, MILD, DEEP };
