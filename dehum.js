'use strict';
// 🔇 DEHUM (VQL 2026-11-17-04, Mike: "Yes, build it"). Wan lays a steady low hum under many takes: measured on 44
// takes, 21 carried a tone under 250 Hz in >= 85 % of frames, and the test takes with the new Sound line (analyser
// 2.102.0) still kept one (car 54 Hz, hallway 97 Hz). A filter on exactly those tones + the rumble under 80 Hz took
// both to "no hum line, not frozen" in the case's measurement. dehum.py finds the tones; this file decides and
// builds the filter. TRIGGERED, never permanent: a take without a hum tone is returned untouched.
// The picture is never re-encoded (-c:v copy, R10); only the audio is re-encoded (AAC 192k, above Wan's 128k).

// Real phone sound changes a lot from frame to frame (flux 0.82-0.97 measured); a tone in such a track is more
// likely a music note than a hum, and Mike's files never carry music — so a lively track is left alone.
const FLUX_MAX = 0.75;
const MAX_NOTCHES = 4;

// A take that carries speech (own voice / talking head) keeps every tone above 100 Hz: voice fundamentals live at
// ~85-250 Hz, and thinning a voice is worse than a faint hum (reviewer 2026-11-17).
const VOICE_MAX_HZ = 100;
function decide(det, { voice = false } = {}) {
  const hum = (det && Array.isArray(det.hum) ? det.hum : []).filter((h) => h && Number(h.hz) >= 35 && Number(h.hz) <= 250);
  if (!hum.length) return { clean: false, reason: (det && det.reason) || 'no steady hum tone' };
  if (det.flux != null && Number(det.flux) >= FLUX_MAX) return { clean: false, reason: `lively track (flux ${det.flux}) — a tone there may be music, left alone` };
  if (voice) {
    const low = hum.filter((h) => Number(h.hz) <= VOICE_MAX_HZ);
    if (!low.length) return { clean: false, reason: `hum at ${hum.map((h) => Math.round(h.hz)).join(', ')} Hz left alone: the take has a voice` };
    hum.splice(0, hum.length, ...low);
  }
  const tones = hum.sort((a, b) => b.prom - a.prom).slice(0, MAX_NOTCHES).map((h) => Math.round(h.hz)).sort((a, b) => a - b);
  return { clean: true, tones, reason: `hum at ${tones.join(', ')} Hz` };
}

// 2-pole high-pass at 80 Hz (rumble a phone mic barely records) + a -25 dB notch at Q 8 (dehum.py places the tone between bins). Measured with sine sweeps: a 97 Hz notch costs 150 Hz 1.6 dB and 200 Hz 0.5 dB (Q 2 cost 8.4 / 4.5 dB — reviewer 2026-11-17) per detected tone.
function filterFor(tones) {
  return ['highpass=f=80:poles=2', ...tones.map((hz) => `equalizer=f=${hz}:t=q:w=8:g=-25`)].join(',');
}

module.exports = { decide, filterFor, FLUX_MAX, MAX_NOTCHES, VOICE_MAX_HZ };
