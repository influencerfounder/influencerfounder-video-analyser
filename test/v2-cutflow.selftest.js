#!/usr/bin/env node
// 🎞 RECREATE v2 — motion is not a cut (2026-10-09). measureCuts runs on a synthetic clip with one
// real cut; the optical-flow verdict is injected, so this tests the decision, not OpenCV.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { measureCuts, CUT_FLOW_RATIO } = require('../v2/cloneV2');
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
(async () => {
  const v = path.join(os.tmpdir(), `cutflow-${process.pid}.mp4`);
  // 2 s of a moving test pattern, then a hard switch to colour bars: one real cut at 2.0 s.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=30:duration=2', '-f', 'lavfi', '-i', 'smptebars=size=180x320:rate=30:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[o]', '-map', '[o]', '-pix_fmt', 'yuv420p', '-y', v]);
  const run = (fc) => measureCuts('ffmpeg', v, 4, fc);
  let seen = null;
  await t('the threshold sits in the measured gap (fakes <= 0.644, real cuts >= 0.69)', () => assert.ok(CUT_FLOW_RATIO > 0.644 && CUT_FLOW_RATIO < 0.69));
  await t('a candidate the flow cannot explain stays a cut', async () => {
    const r = await run(async (ts) => { seen = ts; return { ratios: Object.fromEntries(ts.map(x => [String(x), 0.95])) }; });
    assert.ok(seen && seen.length >= 1, 'the flow check was asked'); assert.strictEqual(r.cuts.length, 1, JSON.stringify(r)); assert.ok(Math.abs(r.cuts[0] - 2) < 0.1);
  });
  await t('a candidate the flow explains is motion, not a cut', async () => {
    const r = await run(async (ts) => ({ ratios: Object.fromEntries(ts.map(x => [String(x), 0.3])) }));
    assert.strictEqual(r.cuts.length, 0, JSON.stringify(r)); assert.strictEqual(r.motionCuts.length, 1); assert.strictEqual(r.motionCuts[0].flow, 0.3);
  });
  await t('no python / a failed check fails OPEN: judged as before', async () => {
    const a = await run(async () => null), b = await run(async () => { throw new Error('no cv2'); }), c = await run();
    for (const r of [a, b, c]) { assert.strictEqual(r.cuts.length, 1, JSON.stringify(r)); assert.strictEqual(r.motionCuts.length, 0); }
  });
  try { fs.unlinkSync(v); } catch (_) {}
  console.log(`\nv2-cutflow: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
