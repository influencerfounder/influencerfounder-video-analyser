#!/usr/bin/env node
// 💪 CHEST: OPEN|COVERED + FOREARMS: BARE|COVERED (2.97.0) — decides which upper-body identity references
// the tool sends on a clothed scene (Video Quality Lab case 2026-10-26-01: an open polo with short sleeves
// came back with invented chest ink and rose forearm sleeves). The parse block is sliced out of index.js
// at run time and executed, like legs-line.selftest.js, so the real parser is tested.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const i = SRC.indexOf("    let lane = 'AUTHENTIC';"), j = SRC.indexOf('    // 🧠 WHY-IT-WENT-VIRAL REPORT', i);
if (i < 0 || j < 0) { console.log('anchor drifted'); process.exit(1); }
const parseSrc = SRC.slice(i, j);
function run(basePrompt, { isBgSwap = false, promptStyle = 'realism' } = {}) {
  const ctx = { basePrompt, isBgSwap, promptStyle, console: { warn() {} } };
  vm.createContext(ctx);
  vm.runInContext(parseSrc + '\n;globalThis.__out = { legsBare, chestOpen, forearmsBare, basePrompt };', ctx);
  return ctx.__out;
}
const BODY = 'Kryfex sits at a café table in a black short-sleeved polo, open at the chest.';
t('both lines read and stripped, body clean', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\nCHEST: OPEN\nFOREARMS: BARE\n\n${BODY}`);
  assert.strictEqual(r.chestOpen, true); assert.strictEqual(r.forearmsBare, true); assert.strictEqual(r.legsBare, false);
  assert.strictEqual(r.basePrompt, BODY);
});
t('COVERED answers read as false', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\nCHEST: COVERED\nFOREARMS: COVERED\n\n${BODY}`);
  assert.strictEqual(r.chestOpen, false); assert.strictEqual(r.forearmsBare, false); assert.strictEqual(r.basePrompt, BODY);
});
t('missing lines → null (unknown), body untouched', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: BARE\n\n${BODY}`);
  assert.strictEqual(r.chestOpen, null); assert.strictEqual(r.forearmsBare, null); assert.strictEqual(r.basePrompt, BODY);
});
t('order swapped and lowercase still read', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\nforearms: bare\nchest: covered\n\n${BODY}`);
  assert.strictEqual(r.chestOpen, false); assert.strictEqual(r.forearmsBare, true); assert.strictEqual(r.basePrompt, BODY);
});
t('a decorated line is still read and stripped', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\n**CHEST: OPEN** (unbuttoned)\nFOREARMS: BARE (short sleeves)\n\n${BODY}`);
  assert.strictEqual(r.chestOpen, true); assert.strictEqual(r.forearmsBare, true); assert.strictEqual(r.basePrompt, BODY);
});
t('a sentence in the prompt that mentions the chest is not read as the line', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\n\nKryfex leans in. CHEST: open is written on a sign.`);
  assert.strictEqual(r.chestOpen, null);
});
t('the rule is sent to the writer, not on a background swap', () => {
  assert.ok(/!isBgSwap \? SKIN_LINES_RULE : ''/.test(SRC));
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
