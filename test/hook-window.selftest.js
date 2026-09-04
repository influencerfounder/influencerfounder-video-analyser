#!/usr/bin/env node
// 🪝 HOOK WINDOW — does the prompt builder actually SEE and PRESERVE the source's hook?
//
// ⚠️ Every block below is read out of index.js AT RUN TIME and evaluated. An earlier
// version of this file had the blocks INLINED by a generator script, which produced a
// false pass: it asserted "avoid-list KEPT at 12 words" after the constant had already
// been deleted, because it was grepping its own frozen copy. If an anchor drifts now,
// extraction throws loudly instead of testing a stale snapshot.
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

const grab = (start, end, label) => {
  const i = SRC.indexOf(start);
  if (i === -1) throw new Error('anchor drifted, start not found: ' + label);
  const j = SRC.indexOf(end, i);
  if (j === -1) throw new Error('anchor drifted, end not found: ' + label);
  return SRC.slice(i, j);
};

const hookc  = grab('    const hookContent = (hookFrames.length', '    const hookImgCount', 'hookContent');
const himg   = grab('    const hookImgCount', '\n\n    const userText', 'hookImgCount');
const budget = grab('      const KIE_SAFE_FRAME_COUNT = 20;', '      const note =', 'kie budget');
const block  = grab("    let hookBlock = '';", "catch (_) { hookBlock = ''; }", 'hookBlock') + "catch (_) { hookBlock = ''; }";

// Compile the REAL code, once, with its free variables as parameters.
const run = new Function('hookFrames', 'isBgSwap', 'imageCount', 'hookReport', `
${hookc}
${himg}
  const imageContent = Array.from({length: imageCount}, (_, i) => ({ type:'image', tag:'even'+i }));
${budget}
${block}
  return { hookContent, hookImgCount, n, subset, kieContent: [...hookContent, ...subset], hookBlock };
`);

const HF = [0.3, 1.0, 2.0, 3.0].map(ts => ({ ts, dataUrl: 'data:image/jpeg;base64,AAA' + ts }));

console.log('\n── the builder can see the hook ──');
t('hook frames LEAD the content, labelled, with real timestamps', () => {
  const r = run(HF, false, 80, null);
  assert(r.hookContent[0].type === 'text', 'first block should be the label');
  assert(/HOOK WINDOW/.test(r.hookContent[0].text));
  assert(/0\.3s, 1s, 2s, 3s/.test(r.hookContent[0].text), 'got: ' + r.hookContent[0].text);
  assert(r.hookContent.slice(1, 5).every(b => b.type === 'image'), '4 images follow the label');
  assert(/FULL CLIP/.test(r.hookContent[5].text), 'clip label closes the block');
});
t('base64 prefix is stripped — a data: URL would be rejected by the API', () => {
  assert.strictEqual(run(HF, false, 80, null).hookContent[1].source.data, 'AAA0.3');
});

console.log('\n── the Kie image ceiling still holds ──');
t('total stays at the proven 20 images, not 24', () => {
  const r = run(HF, false, 80, null);
  assert.strictEqual(r.kieContent.filter(b => b.type === 'image').length, 20);
  assert.strictEqual(r.n, 16, 'even-sampled frames make room for the hook');
});
t('the even-sampled subset stays PURE images — no label spliced in', () => {
  assert(run(HF, false, 80, null).subset.every(b => b.type === 'image'));
});
t('a short clip with only 2 hook frames still totals 20', () => {
  const r = run(HF.slice(0, 2), false, 80, null);
  assert.strictEqual(r.hookImgCount, 2);
  assert.strictEqual(r.n, 18);
  assert.strictEqual(r.kieContent.filter(b => b.type === 'image').length, 20);
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
  const r = run(HF, false, 80, { hook_type: 'curiosity gap', scroll_stop_grade: 'B',
    grade_reason: 'opens mid-pour with the result hidden', mute_test: { pass: true },
    first_frame_verdict: 'strong thumbnail, face large' });
  ['MEASURED HOOK REPORT', 'mechanism: curiosity gap', 'scroll-stop grade: B',
   'opens mid-pour', 'sound off: YES', 'strong thumbnail'].forEach(x =>
    assert(r.hookBlock.includes(x), 'missing: ' + x));
  // "shot", not "beat" — Mike's standing vocabulary rule (2026-09-02): "beat" is
  // reserved for the music Beat Edit feature. The rename landed in the prompt and
  // this assertion was not updated with it. Do not change it back.
  assert(/shot \[0-2s\]/.test(r.hookBlock), 'must name the shot to rebuild');
});
t('mute_test:false asks for a VISUAL equivalent instead', () => {
  const r = run(HF, false, 80, { hook_type: 'bold claim', mute_test: { pass: false } });
  assert(/sound off: NO/.test(r.hookBlock) && /VISUAL equivalent/.test(r.hookBlock));
});
t('no report → empty block (pass 1, and the whole phone-app worker)', () => {
  assert.strictEqual(run(HF, false, 80, null).hookBlock, '');
  assert.strictEqual(run(HF, false, 80, undefined).hookBlock, '');
});
t('malformed report degrades to empty and never throws', () => {
  ['nope', 42, [], {}, { hook_type: null }].forEach(bad =>
    assert.strictEqual(run(HF, false, 80, bad).hookBlock, '', JSON.stringify(bad)));
});
t('fields are length-capped — this text lands inside a prompt', () => {
  const r = run(HF, false, 80, { hook_type: 'x'.repeat(9999), grade_reason: 'y'.repeat(9999) });
  assert(r.hookBlock.length < 700, 'block grew to ' + r.hookBlock.length);
});

console.log('\n── the code-appended tail is gone entirely (2026-08-31) ──');
// Comments are stripped first: the tombstone names footwear/music/avoid on purpose and
// must not be able to satisfy these.
const LIVE = SRC.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
t('LANE_SUFFIX no longer exists and nothing interpolates it', () => {
  assert(!/const LANE_SUFFIX/.test(LIVE), 'the constant is back');
  assert(!/\$\{LANE_SUFFIX\}/.test(LIVE), 'something still interpolates it');
});
t('the clone prompt is base, plus the realism layer only where it belongs', () => {
  // promptStyle split the assembly three ways (2026-09-02, verified on real output):
  // 'original' is the bare 1:1 May prompt with NO realism layer, while realism/improve
  // append it. The invariant this guards is unchanged from 2026-08-31 — the layer is
  // the ONLY thing appended, and the deleted LANE_SUFFIX tail never comes back.
  const m = LIVE.match(/const clonePrompt = ([^\n]*);/);
  assert(m, 'clonePrompt assembly not found — anchor drifted');
  assert(/`\$\{basePrompt\} \$\{LANE_LAYERS\[lane\]\}`/.test(m[1]),
    'the realism arm no longer appends exactly basePrompt + the lane layer');
  assert(/:\s*basePrompt/.test(m[1]),
    'the original arm no longer returns the bare base prompt');
  assert(!/LANE_SUFFIX/.test(m[1]), 'the deleted tail is back in the assembly');
});
t('footwear / no-music / avoid-list exist ONLY in the tombstone', () => {
  ['Footwear fits the setting', 'No music —', 'Avoid jitter'].forEach(x =>
    assert(!LIVE.includes(x), 'still live in code: ' + x));
});
t('the realism layers themselves survived', () => {
  assert(/Filmed on a smartphone/.test(LIVE) && /Shot on a cinema camera/.test(LIVE));
});
t('STEP 3 no longer promises a "negative suffix" it does not append', () => {
  assert(!/the negative suffix in code/.test(SRC), 'stale instruction survived');
  assert(/deliberately NO avoid-list/.test(SRC), 'Claude is not told to skip avoid-lines of its own');
});
t('the version marker was bumped (the free deploy signal)', () => {
  const m = SRC.match(/version: '(\d+\.\d+\.\d+)'/);
  assert(m, 'version field missing');
  // Assert the marker exists and is at/past the version this feature shipped in —
  // never pin an exact value. The point of the field is that it gets BUMPED on every
  // deploy (the free proof a prompt-only Railway change actually landed), so an
  // equality check is guaranteed to fail on the next one. It sat stale at 2.3.0
  // while the service reached 2.26.0.
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; };
  assert(cmp(m[1], '2.3.0') >= 0, 'version went backwards: ' + m[1]);
});

console.log('\n' + (fail ? 'x FAIL' : 'OK') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
