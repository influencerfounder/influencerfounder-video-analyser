#!/usr/bin/env node
// 🫦 SPEECH IS NOT CHOREOGRAPHY — a recreate is generated with audio:false, so a mouth written
// as talking comes back opening and closing on silence. MEASURED 2026-09-19 on a red-carpet reel
// (@chaadhewitt, Wan 3.0, 12s): "mouth moving and expression animated" → a silent mouthing clip.
//
// The rule is read out of index.js AT RUN TIME (house pattern: hook-window / own-subject): if an
// anchor drifts, extraction throws instead of testing a stale snapshot.
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

// The literal itself, evaluated from the live source — never retyped here, or this file would
// happily pass against a constant that had been reworded into uselessness.
const decl = grab('const SPEECH_MOTION_RULE =', '\n', 'SPEECH_MOTION_RULE declaration');
const RULE = new Function('return ' + decl.replace(/^const SPEECH_MOTION_RULE =\s*/, '').replace(/;\s*$/, ''))();
// The assembled system prompt, so "declared but never sent" cannot pass.
const sysSend = grab('    const sysSend = [', "].filter(Boolean).join('\\n\\n');", 'sysSend array');

t('the rule exists and is a non-trivial instruction', () => {
  assert.ok(typeof RULE === 'string' && RULE.length > 300, 'SPEECH_MOTION_RULE is gone or has been gutted');
});

t('it is actually SENT — declared but unused is the failure this catches', () => {
  assert.ok(/SPEECH_MOTION_RULE/.test(sysSend), 'the rule never reaches the system prompt');
});

t('it is suppressed on a background swap, like every other appended rule', () => {
  assert.ok(/!isBgSwap \? SPEECH_MOTION_RULE/.test(sysSend),
    'bgswap keeps the user\'s own footage and person — the rule must not apply there');
});

t('it is an IF-rule, not an unconditional order to never mention a mouth', () => {
  assert.ok(/\bIF the frames show\b/.test(RULE), 'the conditional trigger wording is gone — this is what makes it cost nothing on a silent video');
});

t('HELD expressions stay legal — 12 of 100 shipped prompts depend on it', () => {
  // Banning the mouth outright would have cost a gasp, a grin, a pout and "lips parting into a
  // smile" their content. Those render correctly in silence; only continuous talking does not.
  for (const word of ['grin', 'gasp', 'pout', 'smile']) {
    assert.ok(new RegExp('\\b' + word, 'i').test(RULE), 'the held-expression carve-out lost "' + word + '"');
  }
  assert.ok(/HELD expression is NOT speech/i.test(RULE), 'the explicit held-vs-talking distinction is gone');
});

t('the six measured defect forms are each named', () => {
  // Calibrated on the 100-prompt corpus, 2026-09-19. Each of these appeared in a shipped prompt.
  for (const form of ['mouth moving', 'lips moving', 'mid-word', 'mid-sentence', 'delivers a line', 'speaks directly into the camera']) {
    assert.ok(RULE.includes(form), 'the rule no longer names the measured form: ' + form);
  }
});

t('quoted dialogue is banned — Wan renders a quoted line as mouth shape', () => {
  assert.ok(/quotation marks/i.test(RULE), 'the quoted-dialogue ban is gone; 4 of 100 shipped prompts carried one');
});

t('it says WHAT TO WRITE INSTEAD — a ban with no replacement renders a frozen face', () => {
  // The builder is under a hard rule never to write the subject as motionless. Removing the
  // mouth without naming a substitute is how that rule gets broken from the other side.
  assert.ok(/eye line/i.test(RULE) && /head turns/i.test(RULE), 'the redirect to eye line / head turns is gone');
});

t('it never tells the model the clip HAS a voice', () => {
  assert.ok(/no dialogue and no voice/i.test(RULE), 'the reason clause is gone — the rule reads as arbitrary without it');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
