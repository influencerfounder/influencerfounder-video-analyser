#!/usr/bin/env node
// 🎬 Opening candidates (2026-10-16): only from the hook (first 3 s), earliest first, only frames where MAIN can be
// swapped (clear / small — never obscured or absent), spaced and capped at 3. Pure helpers executed.
const assert = require('assert');
const v = require('../v2/cloneV2');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
t('candidate times stay inside the first 3 s (and inside a short video)', () => {
  const T = v.openingCandidateTimes(12);
  assert.strictEqual(T[0], 0.05); assert.ok(T.every(x => x <= 3), T.join(',')); assert.ok(T.length <= 8);
  assert.ok(v.openingCandidateTimes(1.2).every(x => x <= 0.7));
});
t('the door case: an obscured opening is never a candidate; the first clear frame after it is', () => {
  const T = v.openingCandidateTimes(10);
  const c = v.chooseOpenings(T, [{ i: 0, main: 'obscured' }, { i: 1, main: 'obscured' }, { i: 2, main: 'clear', where: 'centre, grey suit' }]);
  assert.deepStrictEqual(c.map(x => x.t), [0.8]); assert.strictEqual(c[0].where, 'centre, grey suit');
});
t('earliest first, at most 3, never two closer than 0.35 s', () => {
  const T = [0.05, 0.2, 0.4, 0.8, 1.2, 1.6];
  const c = v.chooseOpenings(T, T.map((_, i) => ({ i, main: 'clear' })));
  assert.deepStrictEqual(c.map(x => x.t), [0.05, 0.4, 0.8]);
});
t('small counts (a whole person in a wide shot), absent or obscured everywhere → no candidates', () => {
  const T = v.openingCandidateTimes(10);
  assert.deepStrictEqual(v.chooseOpenings(T, [{ i: 0, main: 'small' }]).map(x => x.main), ['small']);
  assert.deepStrictEqual(v.chooseOpenings(T, [{ i: 0, main: 'absent' }, { i: 1, main: 'obscured' }]), []);
  assert.deepStrictEqual(v.chooseOpenings(T, null), []);
});
t('the judge is told what obscured means (glass, reflection, silhouette, face turned away)', () => {
  assert.ok(/behind glass, a window or a screen, only a reflection, a dark silhouette/.test(v.OPENING_PICK_SYSTEM));
});
console.log(`\nv2-openings: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
