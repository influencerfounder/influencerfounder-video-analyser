// 🔍 REAL UNFOCUS LOOK (2026-10-13, Mike: "I want to test focus jumps on every video, doesn't matter if it
// is high quality or authentic — this makes it look real"). An owner-only, per-remake switch (default ON
// for the owner during the test). Two parts, both written here so the Classic route (/api/clone) and the
// NEW compile (v2/compile.js) say the same thing:
//   1. the OLD-PHONE layer, which replaces the lane layer — also on a HIGH-END source, whose cinema layer
//      ("Shot on a cinema camera… film grain") is exactly what made the church take look professional;
//   2. 1–2 AUTOFOCUS moments, timed. Measured ones first (focusshift.py on the source); when the source has
//      none, ONE natural moment. Rules agreed with Mike: the hook stays sharp (only a short focus-finding at
//      the very start is allowed), at most 2 moments, and never on the moment the subject is shown up close.
// ⚠️ 2026-10-14 — PART 2 MOVED OUT OF THE PROMPT. Measured with ffmpeg blurdetect: Wan 3.0 rendered no dip on
// two takes that carried the timed sentence. The soft moment is now added to the finished video (focusblur.js,
// POST /api/focus-blur), placed just before the action. This file keeps only the old-phone layer.
// Evidence (original): the grandmother reel's real phone dips (0.0–0.2 s soft start, 1.5–2.1 s down to 9 %, 4.6–4.8 s)
// vs our recreates, evenly razor-sharp in every frame (0 dips measured on three takes). One test take
// (church, 2026-10-13) with a written "man steps in front of the lens, autofocus jumps" produced a real
// 2.3–3.6 s dip — so Wan does act on it.
'use strict';

const UNFOCUS_LAYER = 'Filmed on an older iPhone: handheld with small hand tremor and framing corrections, mild lens softness, faint sensor noise, mild compression and auto-exposure shifts, real skin with visible pores, no cinematic grade, no film grain, no vignette.';
module.exports = { UNFOCUS_LAYER };
