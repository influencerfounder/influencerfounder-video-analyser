#!/usr/bin/env node
// 🔍 Real Unfocus Look (2026-10-13): the rules agreed with Mike, executed against unfocus.js and the two
// places that use it (/api/clone in index.js, v2/compile.js).
const fs = require('fs'), path = require('path'), assert = require('assert');
const { UNFOCUS_LAYER, focusSentences } = require('../unfocus');
const { compile } = require('../v2/compile');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

// The grandmother reel, measured by focusshift.py.
const GRANDMA = [{ from: 0.0, to: 0.2, low: 0.3 }, { from: 1.5, to: 2.1, low: 0.09 }, { from: 4.6, to: 4.8, low: 0.42 }];

t('measured moments are used: soft start + the dips after the hook, timed', () => {
  const s = focusSentences(GRANDMA, { durationSec: 7.1, who: 'Dorzy' });
  assert.ok(/starts slightly soft for the first moment/.test(s), s);
  assert.ok(/At 1\.5s the phone's autofocus loses focus — the image goes very blurry — and finds it again by 2\.1s\./.test(s), s);
  assert.ok(/At 4\.6s .* goes soft — and finds it again by 4\.8s\./.test(s), s);
  assert.ok(!/briefly hunts/.test(s), 'no invented moment when measured ones exist');
});
t('the hook stays sharp: a dip inside the hook (other than a soft start) is never written', () => {
  const s = focusSentences([{ from: 0.6, to: 1.1, low: 0.2 }], { hookEnd: 1.4, durationSec: 7 });
  assert.ok(!/At 0\.6s/.test(s), s);
  assert.ok(/after the first two seconds, the autofocus briefly hunts/.test(s), 'falls back to one moment after the hook');
  assert.ok(/The opening stays sharp/.test(s));
});
t('at most 2 moments, never on the subject up close', () => {
  const many = [1, 2, 3, 4, 5].map((x) => ({ from: x + 0.5, to: x + 0.8, low: 0.3 }));
  const s = focusSentences(many, { durationSec: 9, who: 'Kryfex' });
  assert.strictEqual((s.match(/autofocus loses focus/g) || []).length, 2, s);
  assert.ok(/never drops while Kryfex is shown up close\./.test(s));
});
t('no measured moments → exactly one natural moment', () => {
  const s = focusSentences([], { who: '[INFLUENCER]' });
  assert.strictEqual((s.match(/autofocus/g) || []).length, 1, s);
  assert.ok(/snaps sharp again on \[INFLUENCER\]/.test(s));
  assert.ok(!/moving closer|passing close/.test(s), 'no cause named: "the phone moving closer" was acted out as a push-in');
});
t('the old-phone layer drops the cinema look', () => {
  assert.ok(/older iPhone/.test(UNFOCUS_LAYER) && /no cinematic grade, no film grain, no vignette/.test(UNFOCUS_LAYER));
});
t('/api/clone: the switch replaces the lane layer and the measured dips reach the prompt', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(/const unfocus = req\.body\.unfocus === true;/.test(SRC));
  assert.ok(/execFile\(PYTHON, \[path\.join\(__dirname, 'focusshift\.py'\), videoPath/.test(SRC), 'focus is measured');
  assert.ok(/const sentPrompt = unfocusText \? `\$\{basePrompt\} \$\{unfocusText\}` : clonePrompt;/.test(SRC), 'lane layer replaced, never stacked');
  assert.ok(/clonePrompt: sentPrompt,/.test(SRC), 'the unfocus version is what is returned');
});
t('NEW compile: the switch adds the layer + moments and never the cinema look; off = unchanged', () => {
  const spec = { look: 'cinema', setting: 'a hall', outfit: { top_name: 'a coat' }, shots: [{ start: 0, main_events: ['walks'], camera: { move: 'fixed' } }] };
  const off = compile(spec, { name: 'Dorzy', durationSec: 7 }).prompt;
  const on = compile(spec, { name: 'Dorzy', durationSec: 7, unfocus: true, focus: GRANDMA }).prompt;
  assert.ok(/^Cinematic vertical video/.test(off) && !/older iPhone/.test(off), 'off: exactly as before');
  assert.ok(/^Realistic vertical smartphone video/.test(on), 'on: never the cinema look');
  assert.ok(on.includes(UNFOCUS_LAYER) && /At 1\.5s the phone's autofocus/.test(on), on.slice(-600));
});
t('the 3-minute caches never serve an unfocus answer to an off request (or back)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const body = SRC.slice(SRC.indexOf('function cloneJoinKey(b)'), SRC.indexOf('function cloneJoinKey(b)') + 1500);
  const fn = new Function('return ' + body.slice(0, body.indexOf('\n}\n') + 2))();
  const base = { locationId: 'x', videoUrl: 'u' };
  assert.notStrictEqual(fn(base), fn({ ...base, unfocus: true }));
  const { v2JoinKey } = require('../v2/cloneV2');
  if (typeof v2JoinKey === 'function') assert.notStrictEqual(v2JoinKey(base), v2JoinKey({ ...base, unfocus: true }));
  else { const V = fs.readFileSync(path.join(__dirname, '..', 'v2', 'cloneV2.js'), 'utf8'); assert.ok(/function v2JoinKey\(b\)[^\n]*\n[^\n]*b\.unfocus === true/.test(V)); }
});

console.log(`\nunfocus: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
