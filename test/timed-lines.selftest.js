#!/usr/bin/env node
// ⏱ normalizeTimedLines rewrites loose timed lines into "[a-bs] " — and must leave prose alone
// (/toolscan 2026-10-09). The closing group accepted the FIRST LETTER of the next word as the "s"
// unit, so "2-3 seconds later" became "[2-3s] econds later": a garbled word AND a fake shot boundary
// that hookSegment / the garment insertion then treat as a new shot. Runs the live module.
const assert = require('assert');
const { normalizeTimedLines } = require('../hookGuard.js');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

t('loose timed lines are still normalised', () => {
  for (const [a, b] of [['0–3s: He smiles.', '[0-3s] He smiles.'], ['0s-2s: He turns.', '[0-2s] He turns.'], ['0-3.5s] Walks.', '[0-3.5s] Walks.'], ['2-4: He sits.', '[2-4s] He sits.'], ['Shot 2 [1.2-3s]: Cut.', 'Shot 2 [1.2-3s] Cut.']])
    assert.strictEqual(normalizeTimedLines(a).text, b, a);
});
t('a range followed by a word that starts with s is prose, not a timed line', () => {
  for (const s of ['2-3 seconds later the crowd cheers.', '10-15 steps behind him a dog follows.', '1–2 small nods to the camera.', '3-4 sips of coffee.'])
    assert.deepStrictEqual(normalizeTimedLines(s), { text: s, changed: 0 }, s);
});
t('a single number at the start of a sentence is left alone', () => {
  assert.deepStrictEqual(normalizeTimedLines('5 seconds later he waves.'), { text: '5 seconds later he waves.', changed: 0 });
});

console.log(`\ntimed-lines: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
