// 🔍 REAL UNFOCUS LOOK (2026-10-13, Mike: "I want to test focus jumps on every video, doesn't matter if it
// is high quality or authentic — this makes it look real"). An owner-only, per-remake switch (default ON
// for the owner during the test). Two parts, both written here so the Classic route (/api/clone) and the
// NEW compile (v2/compile.js) say the same thing:
//   1. the OLD-PHONE layer, which replaces the lane layer — also on a HIGH-END source, whose cinema layer
//      ("Shot on a cinema camera… film grain") is exactly what made the church take look professional;
//   2. 1–2 AUTOFOCUS moments, timed. Measured ones first (focusshift.py on the source); when the source has
//      none, ONE natural moment. Rules agreed with Mike: the hook stays sharp (only a short focus-finding at
//      the very start is allowed), at most 2 moments, and never on the moment the subject is shown up close.
// Evidence: the grandmother reel's real phone dips (0.0–0.2 s soft start, 1.5–2.1 s down to 9 %, 4.6–4.8 s)
// vs our recreates, evenly razor-sharp in every frame (0 dips measured on three takes). One test take
// (church, 2026-10-13) with a written "man steps in front of the lens, autofocus jumps" produced a real
// 2.3–3.6 s dip — so Wan does act on it.
'use strict';

const UNFOCUS_LAYER = 'Filmed on an older iPhone: handheld with small hand tremor and framing corrections, mild lens softness, faint sensor noise, mild compression and auto-exposure shifts, real skin with visible pores, no cinematic grade, no film grain, no vignette.';
const HOOK_SAFE = 1.5;   // seconds that stay sharp (only a soft start at t≈0 is allowed inside it)
const MAX_MOMENTS = 2;

const r1 = (x) => Math.round(Number(x) * 10) / 10;

// events: [{from,to,low}] from focusshift.py. hookEnd: the measured end of the hook when known.
// who: the name or placeholder the prompt uses for the main person.
function focusSentences(events, { hookEnd = 0, durationSec = 0, who = 'the main person' } = {}) {
  const ev = (Array.isArray(events) ? events : []).filter((e) => e && Number.isFinite(+e.from) && Number.isFinite(+e.to) && +e.to > +e.from);
  const safe = Math.max(HOOK_SAFE, Math.min(3, Number(hookEnd) || 0));
  const out = [];
  if (ev.some((e) => +e.from <= 0.05 && +e.to <= 0.5)) out.push('The image starts slightly soft for the first moment and then sharpens, the way a phone camera finds its focus.');
  const later = ev.filter((e) => +e.from >= safe && (!durationSec || +e.from < durationSec - 0.2)).slice(0, MAX_MOMENTS);
  for (const e of later) {
    const deep = Number(e.low) > 0 && Number(e.low) < 0.15;
    out.push(`At ${r1(e.from)}s the phone's autofocus loses focus — the image goes ${deep ? 'very blurry' : 'soft'} — and finds it again by ${r1(e.to)}s.`);
  }
  if (!later.length) {
    out.push(`Once, after the first two seconds, at a natural moment such as someone passing close to the lens or the phone moving closer, the autofocus briefly hunts: the image goes soft for about half a second, then snaps sharp again on ${who}.`);
  }
  // "or the main object" was cut (reviewer): naming an object that may not exist invites the model to add one.
  out.push(`The opening stays sharp, and the focus never drops while ${who} is shown up close.`);
  return out.join(' ');
}

module.exports = { UNFOCUS_LAYER, focusSentences, HOOK_SAFE, MAX_MOMENTS };
