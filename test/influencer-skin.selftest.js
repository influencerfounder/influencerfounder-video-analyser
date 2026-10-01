#!/usr/bin/env node
// 🎨 The "say whether the skin is bare or marked" rule is for OTHER people only (v2.52.0, 2026-10-01).
// Mike: "exclude all our AI influencers with tattoos from this clause". Measured: a prompt called
// Kryfex's forearms "bare unmarked". Checks BOTH writer prompts (1:1 recreate + improve) carry the
// scoping sentence right after the skin rule, so the two can never be read apart.
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const RULE = 'say plainly whether that skin is bare or marked';
const SCOPE = 'This skin statement is for the OTHER people ONLY: never write whether [INFLUENCER]’s own skin is bare, unmarked, clean or tattooed';
const at = []; let i = -1; while ((i = SRC.indexOf(RULE, i + 1)) !== -1) at.push(i);
t('the skin rule exists in both writer prompts', () => assert.strictEqual(at.length, 2));
at.forEach((pos, k) => t(`writer prompt ${k + 1}: the scoping sentence follows the skin rule directly`, () => {
  const after = SRC.slice(pos, pos + 400);
  assert.ok(after.includes(SCOPE), 'scope sentence missing right after the rule');
}));
t('it names every body area the leak could hit', () => assert.ok(/not their arms, forearms, hands, neck, chest or legs/.test(SRC)));
t('it gives the reason (references are the only authority on the influencer\'s skin)', () => assert.ok(/\[INFLUENCER\]’s skin and tattoos come from the reference images alone/.test(SRC)));
console.log(`\n${fail ? 'x FAIL' : 'OK'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
