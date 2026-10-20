#!/usr/bin/env node
// 🔍 Real Unfocus Look (2026-10-13): the rules agreed with Mike, executed against unfocus.js and the two
// places that use it (/api/clone in index.js, v2/compile.js).
const fs = require('fs'), path = require('path'), assert = require('assert');
const { UNFOCUS_LAYER } = require('../unfocus');
const unfocusMod = require('../unfocus');
const { compile } = require('../v2/compile');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

// The grandmother reel, measured by focusshift.py.
const GRANDMA = [{ from: 0.0, to: 0.2, low: 0.3 }, { from: 1.5, to: 2.1, low: 0.09 }, { from: 4.6, to: 4.8, low: 0.42 }];

t('2026-10-14: no autofocus sentence is written any more — the moment is added after generation', () => {
  assert.strictEqual(typeof unfocusMod.focusSentences, 'undefined', 'focusSentences must stay gone');
  assert.ok(!/autofocus/i.test(UNFOCUS_LAYER), UNFOCUS_LAYER);
});
t('the old-phone layer drops the cinema look', () => {
  assert.ok(/older iPhone/.test(UNFOCUS_LAYER) && /no cinematic grade, no film grain, no vignette/.test(UNFOCUS_LAYER));
});
t('/api/clone: the switch replaces the lane layer with the old-phone layer only', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(/const unfocus = req\.body\.unfocus === true;/.test(SRC));
  assert.ok(/\? unfocusLib\.UNFOCUS_LAYER   \/\/ the autofocus moment itself is added after generation/.test(SRC), 'layer only');
  assert.ok(/const sentPrompt = unfocusText \? `\$\{basePrompt\} \$\{unfocusText\}` : clonePrompt;/.test(SRC), 'lane layer replaced, never stacked');
  assert.ok(/clonePrompt: sentPrompt,/.test(SRC), 'the unfocus version is what is returned');
});
t('NEW compile: the switch adds the layer + moments and never the cinema look; off = unchanged', () => {
  const spec = { look: 'cinema', setting: 'a hall', outfit: { top_name: 'a coat' }, shots: [{ start: 0, main_events: ['walks'], camera: { move: 'fixed' } }] };
  const off = compile(spec, { name: 'Dorzy', durationSec: 7 }).prompt;
  const on = compile(spec, { name: 'Dorzy', durationSec: 7, unfocus: true, focus: GRANDMA }).prompt;
  assert.ok(/^Cinematic vertical video/.test(off) && !/older iPhone/.test(off), 'off: exactly as before');
  assert.ok(/^Realistic vertical smartphone video/.test(on), 'on: never the cinema look');
  assert.ok(on.includes(UNFOCUS_LAYER) && !/autofocus/i.test(on), on.slice(-600));
});
t('phoneLayer: every PHONE-look video carries the old-phone layer exactly once, switch on or off; cinema keeps none (2026-10-20)', () => {
  const spec = { look: 'phone', setting: 'a rooftop', outfit: { top_name: 'a satin shirt' }, shots: [{ start: 0, main_events: ['laughs'], camera: { move: 'fixed' } }] };
  for (const unfocus of [false, true]) {
    const p = compile(spec, { name: 'Kryfex', durationSec: 7, unfocus }).prompt;
    assert.strictEqual(p.split(UNFOCUS_LAYER).length - 1, 1, 'unfocus=' + unfocus + ': ' + p.slice(-400));
  }
  const cinema = compile({ ...spec, look: 'cinema' }, { name: 'Kryfex', durationSec: 7 }).prompt;
  assert.ok(!cinema.includes(UNFOCUS_LAYER), 'a cinema source stays cinema');
});
t('Classic: the AUTHENTIC lane IS the canonical old-phone layer (one sentence everywhere); HIGH-END untouched', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(/'AUTHENTIC': unfocusLib\.UNFOCUS_LAYER,/.test(SRC), 'AUTHENTIC lane');
  assert.ok(/'HIGH-END': 'Shot on a cinema camera:/.test(SRC), 'cinema lane');
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
