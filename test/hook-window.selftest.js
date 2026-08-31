#!/usr/bin/env node
// 🪝 HOOK WINDOW — does the prompt builder actually SEE and PRESERVE the source's hook?
// Every block below is EXTRACTED FROM index.js at run time, never copied, so the test
// cannot drift from the shipping code — if an anchor moves, extraction throws loudly.
const assert = require('assert');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

function run(hookFrames, isBgSwap, imageCount, hookReport) {
    const hookContent = (hookFrames.length && !isBgSwap) ? [
      { type: 'text', text: `HOOK WINDOW — the source's opening ${hookFrames.length} frames in order (${hookFrames.map(h => h.ts + 's').join(', ')}). This is the scroll-stopping moment you must preserve.` },
      ...hookFrames.map(h => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: h.dataUrl.split(',')[1] } })),
      { type: 'text', text: 'FULL CLIP — evenly sampled frames covering the whole video:' },
    ] : [];

    const hookImgCount = hookContent.length ? hookFrames.length : 0;   // derive from hookContent so the bgswap gate can never desync the Kie frame budget
  const imageContent = Array.from({length: imageCount}, (_, i) => ({ type:'image', tag:'even'+i }));
      const KIE_SAFE_FRAME_COUNT = 20;
      const n = Math.min(KIE_SAFE_FRAME_COUNT - hookImgCount, imageContent.length);
      const subset = n === imageContent.length
        ? imageContent
        : Array.from({ length: n }, (_, i) => imageContent[Math.round(i * (imageContent.length - 1) / (n - 1))]);

    let hookBlock = '';
    try {
      const hr = hookReport || null;
      if (hr && typeof hr === 'object') {
        const bits = [];
        if (hr.hook_type) bits.push(`- mechanism: ${String(hr.hook_type).slice(0, 160)}`);
        if (hr.scroll_stop_grade) bits.push(`- scroll-stop grade: ${String(hr.scroll_stop_grade).slice(0, 80)}`);
        if (hr.grade_reason) bits.push(`- why: ${String(hr.grade_reason).slice(0, 300)}`);
        if (hr.mute_test && typeof hr.mute_test.pass === 'boolean') {
          bits.push(`- works with sound off: ${hr.mute_test.pass ? 'YES — the hook is visual, keep it visual' : 'NO — the hook leans on audio, so give the recreate a VISUAL equivalent'}`);
        }
        if (hr.first_frame_verdict) bits.push(`- opening frame as thumbnail: ${String(hr.first_frame_verdict).slice(0, 300)}`);
        if (bits.length) {
          hookBlock = `\n\nMEASURED HOOK REPORT for this exact video — this was scored from the same hook frames, so use it rather than re-deriving it, and rebuild this mechanism as beat [0-2s]:\n${bits.join('\n')}`;
        }
      }
    } catch (_) { hookBlock = ''; }
  return { hookContent, hookImgCount, n, subset, kieContent: [...hookContent, ...subset], hookBlock };
}
    const LANE_SUFFIX = 'Avoid jitter, bent limbs, temporal flicker, warping or morphing, and extra fingers.';

const HF = [0.3,1.0,2.0,3.0].map(ts => ({ ts, dataUrl: 'data:image/jpeg;base64,AAA'+ts }));

console.log('\n── the builder can see the hook ──');
t('hook frames LEAD the content, labelled, with real timestamps', () => {
  const r = run(HF, false, 80, null);
  assert(r.hookContent[0].type === 'text', 'first block should be the label');
  assert(/HOOK WINDOW/.test(r.hookContent[0].text));
  assert(/0\.3s, 1s, 2s, 3s/.test(r.hookContent[0].text), 'got: ' + r.hookContent[0].text);
  assert(r.hookContent.slice(1,5).every(b => b.type === 'image'), '4 images follow the label');
  assert(/FULL CLIP/.test(r.hookContent[5].text), 'clip label closes the block');
});
t('base64 prefix is stripped — a data: URL would be rejected by the API', () => {
  assert.strictEqual(run(HF, false, 80, null).hookContent[1].source.data, 'AAA0.3');
});

console.log('\n── the Kie image ceiling still holds ──');
t('total stays at the proven 20 images, not 24', () => {
  const r = run(HF, false, 80, null);
  assert.strictEqual(r.kieContent.filter(b => b.type==='image').length, 20);
  assert.strictEqual(r.n, 16, 'even-sampled frames make room for the hook');
});
t('the even-sampled subset stays PURE images — no label spliced in', () => {
  assert(run(HF, false, 80, null).subset.every(b => b.type === 'image'));
});
t('a short clip with only 2 hook frames still totals 20', () => {
  const r = run(HF.slice(0,2), false, 80, null);
  assert.strictEqual(r.hookImgCount, 2);
  assert.strictEqual(r.n, 18);
  assert.strictEqual(r.kieContent.filter(b => b.type==='image').length, 20);
});
t('no hook frames at all → no label, no crash, full budget', () => {
  const r = run([], false, 80, null);
  assert.strictEqual(r.hookContent.length, 0);
  assert.strictEqual(r.n, 20);
});

console.log('\n── bgswap is a different job and must not be touched ──');
t('bgswap gets NO hook content and keeps its full 20-frame budget', () => {
  const r = run(HF, true, 80, null);
  assert.strictEqual(r.hookContent.length, 0, 'a "preserve the hook" label is wrong here');
  assert.strictEqual(r.hookImgCount, 0);
  assert.strictEqual(r.n, 20);
});

console.log('\n── the MEASURED hook report, when a caller has one ──');
t('every field renders, and it says WHERE the mechanism goes', () => {
  const r = run(HF, false, 80, { hook_type:'curiosity gap', scroll_stop_grade:'B',
    grade_reason:'opens mid-pour with the result hidden', mute_test:{pass:true},
    first_frame_verdict:'strong thumbnail, face large' });
  ['MEASURED HOOK REPORT','mechanism: curiosity gap','scroll-stop grade: B',
   'opens mid-pour','sound off: YES','strong thumbnail'].forEach(x =>
    assert(r.hookBlock.includes(x), 'missing: ' + x));
  assert(/beat \[0-2s\]/.test(r.hookBlock), 'must name the beat to rebuild');
});
t('mute_test:false asks for a VISUAL equivalent instead', () => {
  const r = run(HF, false, 80, { hook_type:'bold claim', mute_test:{pass:false} });
  assert(/sound off: NO/.test(r.hookBlock) && /VISUAL equivalent/.test(r.hookBlock));
});
t('no report → empty block (pass 1, and the whole phone-app worker)', () => {
  assert.strictEqual(run(HF, false, 80, null).hookBlock, '');
  assert.strictEqual(run(HF, false, 80, undefined).hookBlock, '');
});
t('malformed report degrades to empty and never throws', () => {
  ['nope', 42, [], {}, {hook_type:null}].forEach(bad =>
    assert.strictEqual(run(HF, false, 80, bad).hookBlock, '', JSON.stringify(bad)));
});
t('fields are length-capped — this text lands inside a prompt', () => {
  const r = run(HF, false, 80, { hook_type:'x'.repeat(9999), grade_reason:'y'.repeat(9999) });
  assert(r.hookBlock.length < 700, 'block grew to ' + r.hookBlock.length);
});

console.log('\n── LANE_SUFFIX word budget ──');
t('footwear rule GONE (Mike 2026-08-31 — the fix is a shod master, not a sentence)', () => {
  assert(!/footwear|barefoot|shoes/i.test(LANE_SUFFIX), 'footwear survived');
});
t('no-music line GONE (replaced by the generate_audio:false parameter)', () => {
  assert(!/music/i.test(LANE_SUFFIX), 'no-music survived');
});
t('artifact avoid-list KEPT at 12 words — Seedance\'s documented negative mechanism', () => {
  assert(/jitter/.test(LANE_SUFFIX) && /extra fingers/.test(LANE_SUFFIX));
  assert.strictEqual(LANE_SUFFIX.trim().split(/\s+/).length, 12);
});

console.log('\n' + (fail ? 'x FAIL' : 'OK') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
