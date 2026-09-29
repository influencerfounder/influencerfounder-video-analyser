#!/usr/bin/env node
// ✂️ EVERY CUT IS A HARD CUT (Mike, 2026-09-29: "When a recreate video uses cuts it creates a
// fade instead of a hard cut. I prefer a hard cut"). MEASURED on 22 Wan recreates: the one
// cross-dissolve came from a prompt that said "cuts to black, then opens on a second location";
// "A hard cut brings a third setup" rendered clean single-frame cuts.
//
// Read out of index.js AT RUN TIME (house pattern: speech-motion / own-subject).
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const grab = (start, end, label) => {
  const i = SRC.indexOf(start);
  if (i === -1) throw new Error('anchor drifted, start not found: ' + label);
  const j = SRC.indexOf(end, i);
  if (j === -1) throw new Error('anchor drifted, end not found: ' + label);
  return SRC.slice(i, j + end.length);
};
const decl = grab('const HARD_CUT_RULE =', 'write no cut at all.";', 'HARD_CUT_RULE declaration');
const build = (isWan) => new Function('isWan', 'return ' + decl.replace(/^const HARD_CUT_RULE =\s*/, '').replace(/;\s*$/, ''))(isWan);
const WAN = build(true), SEED = build(false);
const sysSend = grab('    const sysSend = [', "].filter(Boolean).join('\\n\\n');", 'sysSend array');

t('it is SENT, and suppressed on a background swap', () => {
  assert.ok(/!isBgSwap \? HARD_CUT_RULE/.test(sysSend), 'the rule never reaches the system prompt, or fires on bgswap');
});
t('it is an IF-rule: a single-take source gets no cut invented', () => {
  assert.ok(/\bIF the source changes\b/.test(WAN) && /\bIF the source is one continuous take, write no cut at all/.test(WAN));
});
t('Wan gets its official transition words, the ones the tool keys on', () => {
  assert.ok(WAN.includes('"Hard cut transition,"'), 'Wan wording lost "Hard cut transition,"');
  assert.ok(!SEED.includes('Hard cut transition'), 'Seedance should not get the Wan phrase');
  assert.ok(SEED.includes('"Hard cut to"'), 'Seedance wording lost "Hard cut to"');
});
t('both wordings contain the literal "hard cut" the tool\'s multi-shot detector matches', () => {
  const RE = /\b(?:hard|smash|jump|match)[\s-]+cut|\bcuts?\s+(?:to|again|back)\b|\bcuts?\s+away\b/i;
  for (const phrase of ['Hard cut transition, close on her eyes.', 'Hard cut to a wide shot.']) assert.ok(RE.test(phrase));
});
t('the soft-transition forms that produced the dissolve are each named', () => {
  for (const form of ['fade', 'dissolve', 'fades to black', 'transitions to', 'gives way to', 'then opens on'])
    assert.ok(WAN.includes(form) && SEED.includes(form), 'no longer names: ' + form);
});
t('a black flash between shots is mirrored as hard cuts, not banned (the @exog_edit source has one)', () => {
  assert.ok(WAN.includes('"Hard cut transition, a black frame for a split second. Hard cut transition,'), 'Wan black-frame form missing');
  assert.ok(SEED.includes('"Hard cut to a black frame for a split second. Hard cut to'), 'Seedance black-frame form missing');
  assert.ok(!/Never[^.]*cuts to black/.test(WAN), 'a genuine cut to black must stay writable');
});
t('it forbids inventing cuts — 1:1 with the source', () => {
  assert.ok(/MIRRORED 1:1 FROM THE SOURCE/.test(WAN) && /Never invent a cut the source does not have/.test(WAN));
});
console.log(fail ? `FAIL ${fail} failed, ${pass} passed` : `OK ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
