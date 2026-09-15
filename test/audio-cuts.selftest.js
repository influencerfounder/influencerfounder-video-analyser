#!/usr/bin/env node
// 🎙 AUDIO CUTS — the splitter behind the long-form talking head (2026-09-15).
// pickAudioCuts turns ONE continuous voice track into ≤ maxChunks pieces cut on silences, so a
// 60s script becomes six ~10s Wan shots that each lip-sync to their own chunk. Every chunk must
// sit inside [minSec, maxSec] — Wan refuses audio over 15s, and a 1-second tail would ask the
// model for a 1-second video — and the code path is read out of index.js at run time so an
// anchor drift fails loudly instead of testing a stale copy.
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const grab = (start, end, label) => {
  const i = SRC.indexOf(start); if (i === -1) throw new Error('anchor drifted, start not found: ' + label);
  const j = SRC.indexOf(end, i); if (j === -1) throw new Error('anchor drifted, end not found: ' + label);
  return SRC.slice(i, j);
};
const code = grab('function pickAudioCuts(silences, totalSec, opts = {}) {', "app.post('/api/audio-split'", 'pickAudioCuts + envelopeSilences');
const { pickAudioCuts, envelopeSilences } = new Function(code + '\nreturn { pickAudioCuts, envelopeSilences };')();

// A silence every ~9.8s, the way MiniMax leaves gaps between sentences.
const every = (step, total, w = 0.35) => { const out = []; for (let x = step; x < total; x += step) out.push({ start: x - w / 2, end: x + w / 2 }); return out; };
const within = (chunks, lo, hi) => chunks.every(c => c.sec >= lo - 1e-9 && c.sec <= hi + 1e-9);
const contiguous = (chunks, total) => Math.abs(chunks[0].start) < 1e-9 && Math.abs(chunks[chunks.length - 1].end - total) < 1e-9 && chunks.every((c, i) => i === 0 || Math.abs(c.start - chunks[i - 1].end) < 1e-9);

t('60s with a silence every 9.8s → 6 chunks, all inside [3,14], contiguous, none forced', () => {
  const r = pickAudioCuts(every(9.8, 60), 60, { targetSec: 10, minSec: 3, maxSec: 14, maxChunks: 6 });
  assert(!r.error, r.error); assert.strictEqual(r.chunks.length, 6);
  assert(within(r.chunks, 3, 14)); assert(contiguous(r.chunks, 60)); assert(r.chunks.every(c => !c.forced));
});
t('cuts land IN the silences, nearest the 10s ideal', () => {
  const r = pickAudioCuts(every(9.8, 60), 60);
  assert(Math.abs(r.chunks[0].end - 9.8) < 0.01, 'first cut at ' + r.chunks[0].end);
  assert(Math.abs(r.chunks[1].end - 19.6) < 0.01, 'second cut at ' + r.chunks[1].end);
});
t('7.65s (one sentence) → a single chunk, untouched', () => {
  const r = pickAudioCuts(every(3, 7.65), 7.65);
  assert.strictEqual(r.chunks.length, 1); assert.strictEqual(r.chunks[0].sec, 7.65);
});
t('25s → 3 chunks, the 5s tail kept (≥ minSec), not merged into a 15s shot', () => {
  const r = pickAudioCuts(every(10, 25), 25);
  assert.strictEqual(r.chunks.length, 3, JSON.stringify(r.chunks)); assert(within(r.chunks, 3, 14)); assert(contiguous(r.chunks, 25));
});
t('NO silences at all → forced cuts at maxSec, flagged, still inside the window', () => {
  const r = pickAudioCuts([], 40, { targetSec: 10, minSec: 3, maxSec: 14 });
  assert(!r.error); assert(within(r.chunks, 3, 14)); assert(contiguous(r.chunks, 40));
  assert(r.chunks.slice(0, -1).every(c => c.forced), 'every non-final chunk is forced');
});
t('a silence that would strand a 1s tail is skipped — the last shot is never shorter than minSec', () => {
  // total 16: candidates at 5 (tail 11, fine) and 15 (tail 1 → must be skipped)
  const r = pickAudioCuts([{ start: 4.8, end: 5.2 }, { start: 14.8, end: 15.2 }], 16, { targetSec: 10, minSec: 3, maxSec: 14 });
  assert(!r.error); assert(r.chunks.every(c => c.sec >= 3 - 1e-9), JSON.stringify(r.chunks)); assert(contiguous(r.chunks, 16));
});
t('forced cut never leaves a tail under minSec either', () => {
  const r = pickAudioCuts([], 15.5, { targetSec: 10, minSec: 3, maxSec: 14 });
  assert(!r.error); assert(r.chunks.every(c => c.sec >= 3 - 1e-9), JSON.stringify(r.chunks)); assert(contiguous(r.chunks, 15.5));
});
t('84s at maxChunks 6 → a plain error naming the count, no throw', () => {
  const r = pickAudioCuts(every(9.8, 84.5), 84.5, { maxChunks: 6 });
  assert(r.error && /shots/.test(r.error), r.error); assert(r.chunks.length > 6);
});
t('zero / missing duration → error, empty chunks', () => {
  assert(pickAudioCuts([], 0).error); assert.deepStrictEqual(pickAudioCuts([], 0).chunks, []);
});
t('a 400ms sentence pause 1s off the mark beats a 100ms word dip sitting exactly on it', () => {
  const r = pickAudioCuts([{ start: 9.95, end: 10.05 }, { start: 10.8, end: 11.2 }], 20, { targetSec: 10, minSec: 3, maxSec: 14 });
  assert(Math.abs(r.chunks[0].end - 11.0) < 0.01, 'cut at ' + r.chunks[0].end + ' (expected the long pause at 11.0)');
});
// envelopeSilences: synthesise 8kHz mono — speech-like noise at -20dB with gaps at the file's own floor
const synth = (segments, sr = 8000, floorDb = -34) => {
  const out = []; let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1;
  for (const [sec, loud] of segments) { const amp = Math.pow(10, (loud ? -20 : floorDb) / 20); for (let i = 0; i < sec * sr; i++) out.push(rnd() * amp * 1.7); }
  return Float64Array.from(out);
};
t('envelopeSilences finds the gaps in a file whose floor is -34dB (where a fixed -40dB finds none)', () => {
  const s = synth([[3, true], [0.4, false], [4, true], [0.3, false], [3, true]]);
  const d = envelopeSilences(s, 8000, { minGapSec: 0.12 });
  assert.strictEqual(d.silences.length, 2, JSON.stringify(d));
  assert(Math.abs(d.silences[0].start - 3.0) < 0.06 && Math.abs(d.silences[0].end - 3.4) < 0.06, 'first gap ' + JSON.stringify(d.silences[0]));
  assert(d.thresholdDb > d.floorDb && d.thresholdDb <= -25, 'threshold sits just above the file floor: ' + d.thresholdDb + ' vs ' + d.floorDb);
});
t('a 90ms dip is NOT a gap at minGap 120ms (inter-word dips must not split a sentence)', () => {
  const s = synth([[3, true], [0.09, false], [3, true]]);
  assert.strictEqual(envelopeSilences(s, 8000, { minGapSec: 0.12 }).silences.length, 0);
});
t('digital silence (a padded WAV) still yields a sane threshold, never below -55dB', () => {
  const s = synth([[2, true], [0.5, false], [2, true]], 8000, -120);
  const d = envelopeSilences(s, 8000);
  assert(d.thresholdDb >= -55 && d.silences.length === 1, JSON.stringify(d));
});
t('too few samples → no silences, no throw', () => {
  assert.deepStrictEqual(envelopeSilences(new Float64Array(10), 8000).silences, []);
});

console.log(fail ? `FAIL ${fail} failed, ${pass} passed` : `OK ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
