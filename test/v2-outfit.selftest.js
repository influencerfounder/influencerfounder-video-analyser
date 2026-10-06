#!/usr/bin/env node
// 🧪 RECREATE v2 phase 2 — the outfit crop maths (v2/cloneV2.js cropRect + specShotAt).
const assert = require('assert');
const { cropRect, specShotAt } = require('../v2/cloneV2');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
t('percent box → pixels, padded 2% on the sides and bottom, never above (the chin)', () => {
  assert.deepStrictEqual(cropRect([20, 30, 60, 90], 720, 1280), { x: 130, y: 384, w: 316, h: 794 });
});
t('0-1 fractions are read as percent', () => assert.deepStrictEqual(cropRect([0.2, 0.3, 0.6, 0.9], 720, 1280), cropRect([20, 30, 60, 90], 720, 1280)));
t('the box is clamped to the frame', () => { const r = cropRect([-5, 10, 120, 110], 720, 1280); assert.ok(r.x === 0 && r.x + r.w <= 720 && r.y + r.h <= 1280); });
t('a sliver or a broken box is refused (no crop beats a wrong crop)', () => { assert.strictEqual(cropRect([10, 10, 12, 90], 720, 1280), null); assert.strictEqual(cropRect([10, 'x', 50, 90], 720, 1280), null); assert.strictEqual(cropRect(null, 720, 1280), null); });
t('even width/height (video filters and encoders want even sizes)', () => { const r = cropRect([13, 17, 61, 93], 721, 1279); assert.ok(r.w % 2 === 0 && r.h % 2 === 0); });
t('specShotAt picks the phase that covers a time', () => {
  const spec = { shots: [{ start: 0, garment_side: 'back' }, { start: 1.21, garment_side: 'front' }, { start: 5.08, main_visible: false }] };
  assert.strictEqual(specShotAt(spec, 0.5).garment_side, 'back');
  assert.strictEqual(specShotAt(spec, 2).garment_side, 'front');
  assert.strictEqual(specShotAt(spec, 6).main_visible, false);
});
t('candidates come from spec phases: a one-take video still yields front AND back times', () => {
  const { outfitCandidateTimes } = require('../v2/cloneV2');
  const spec = { shots: [{ start: 0, garment_side: 'front' }, { start: 4, garment_side: 'side' }, { start: 9, garment_side: 'back' }, { start: 12, garment_side: 'not visible' }, { start: 14, main_visible: false, garment_side: 'back' }] };
  const c = outfitCandidateTimes(spec, 23);
  assert.deepStrictEqual(c.map(x => x.side), ['front', 'front', 'back', 'back']);
  assert.ok(c.every(x => (x.side === 'front' && x.t < 4) || (x.side === 'back' && x.t >= 9 && x.t < 12)), JSON.stringify(c));
});
console.log(`\nv2-outfit: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
