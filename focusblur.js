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

/** The ffmpeg video filter for a window: soft in, soft, sharp again. */
function blurFilter({ from }) {
  const a = r2(from), b = r2(from + 0.1), c = r2(from + 0.45), d = r2(from + LEN);
  return `gblur=sigma=3:enable='between(t,${a},${b})',gblur=sigma=8:enable='between(t,${b},${c})',gblur=sigma=2.5:enable='between(t,${c},${d})'`;
}

module.exports = { pickBlurWindow, actionOnset, blurFilter, LEN, FIRST, EARLY_END };
