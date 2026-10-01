#!/usr/bin/env node
// 🧥 LAYERED_OUTFIT_RULE (v2.51.0, 2026-10-01) — the inner layer under an open jacket/shirt is written
// as what covers the chest and stomach. Reads the REAL rule out of index.js (never a frozen copy).
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const i = SRC.indexOf('const LAYERED_OUTFIT_RULE = '); if (i < 0) throw new Error('LAYERED_OUTFIT_RULE missing');
const RULE = new Function('return ' + SRC.slice(i, SRC.indexOf('\n', i)).replace(/^const LAYERED_OUTFIT_RULE =\s*/, '').replace(/;\s*$/, ''))();
const sysSend = SRC.slice(SRC.indexOf('    const sysSend = ['), SRC.indexOf("].filter(Boolean).join('\\n\\n');", SRC.indexOf('    const sysSend = [')));
t('it is an IF-rule (triggered by layers, not always-on content)', () => assert.ok(/^🧥 IF \[INFLUENCER\] wears more than one layer on the upper body/.test(RULE)));
t('the inner layer is written as covering the chest and stomach', () => assert.ok(/write the inner layer as what covers the chest and stomach/.test(RULE)));
t('…and named again wherever the outer layer hangs open', () => assert.ok(/name that inner layer again in every shot or line where the outer layer hangs open/.test(RULE)));
t('a single layer adds nothing', () => assert.ok(/If \[INFLUENCER\] wears a single layer, add nothing about this\./.test(RULE)));
t('POSITIVE wording — it never names bare skin or shirtlessness (naming draws it)', () => assert.ok(!/bare|shirtless|naked|skin/i.test(RULE)));
t('SENT on every recreate style, not on a background swap', () => assert.ok(/!isBgSwap \? LAYERED_OUTFIT_RULE : ''/.test(sysSend)));
t('writer-only: it lives in the SYSTEM prompt, never appended to the video prompt', () => assert.ok(!/clonePrompt[^\n]*LAYERED_OUTFIT_RULE/.test(SRC)));
console.log(`\n${fail ? 'x FAIL' : 'OK'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
