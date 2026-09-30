#!/usr/bin/env node
// 👟 CAR → SHOES (2026-09-30). Three analyses of one green-Urus source wrote three different wrong
// shoe sequences. Read out of index.js at run time (house pattern: speech-motion / hard-cut).
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const i = SRC.indexOf('const CAR_SHOES_RULE ='); if (i < 0) throw new Error('CAR_SHOES_RULE missing');
const RULE = new Function('return ' + SRC.slice(i, SRC.indexOf('\n', i)).replace(/^const CAR_SHOES_RULE =\s*/, '').replace(/;\s*$/, ''))();
const j = SRC.indexOf('    const sysSend = ['); const sysSend = SRC.slice(j, SRC.indexOf("].filter(Boolean)", j));
t('SENT, and not on a background swap', () => assert.ok(/!isBgSwap \? CAR_SHOES_RULE/.test(sysSend)));
t('an IF-rule the vision model triggers — nothing for videos without this moment', () => assert.ok(/^👟 IF the frames show someone getting out of a vehicle/.test(RULE)));
t('asks for where the shoes land and how the feet meet them, in the source order, one sentence', () => {
  for (const w of ['where they land', 'go straight into them', 'ONE sentence', 'in the order the source shows it']) assert.ok(RULE.includes(w), 'lost: ' + w);
});
t('bans each of the three measured wrong inventions', () => {
  for (const w of ['barefoot pause', 'while standing', 'second pair']) assert.ok(RULE.includes(w), 'lost: ' + w);
});
console.log(fail ? `FAIL ${fail} failed, ${pass} passed` : `OK ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
