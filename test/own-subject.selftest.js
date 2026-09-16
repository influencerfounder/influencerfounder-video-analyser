#!/usr/bin/env node
// 🐕 OWN-SUBJECT RULE — the appearance ban, one level out (2026-09-16).
//
// Rule (b) already forbids describing the SOURCE person, because the user swaps in their own and
// "references beat prompt text on anything they depict". The same is true of their own dog or car
// the moment they have a saved reference: MEASURED 2026-09-15, a recreate prompt said "a golden
// retriever" twice while a Cane Corso reference was attached, and the breed had to be deleted by
// hand. This pins the trigger (the caller's saved element TYPES), the scope (pet + vehicle only),
// and the cache key — a cached prompt built WITHOUT the rule is the wrong answer.
// The rule text is read out of index.js at run time, so an anchor drift fails loudly.
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const grab = (start, end, label) => {
  const i = SRC.indexOf(start); if (i === -1) throw new Error('anchor drifted, start not found: ' + label);
  const j = SRC.indexOf(end, i); if (j === -1) throw new Error('anchor drifted, end not found: ' + label);
  return SRC.slice(i, j);
};

// Compile the real declarations + the real rule builder, with req.body as the only free variable.
const kinds = grab('const OWN_SUBJECT_KINDS = {', '    const elementTypes', 'OWN_SUBJECT_KINDS');
const read  = grab('    const elementTypes = Array.isArray(req.body.elementTypes)', '      : [];', 'elementTypes read') + '      : [];';
const rule  = grab('    const OWN_SUBJECT_RULE = elementTypes.length ? (', '\n    const sysSend', 'OWN_SUBJECT_RULE');
const build = new Function('req', `${kinds}\n${read}\n${rule}\nreturn { elementTypes, OWN_SUBJECT_RULE };`);
const run = (elementTypes) => build({ body: elementTypes === undefined ? {} : { elementTypes } });

t('no elementTypes → the rule is EMPTY (nothing changes for anyone without a saved reference)', () => {
  assert.strictEqual(run().OWN_SUBJECT_RULE, '');
  assert.strictEqual(run([]).OWN_SUBJECT_RULE, '');
  assert.deepStrictEqual(run().elementTypes, []);
});
t('pet → the rule names the animal, bans breed/colour/markings, and gives the measured example', () => {
  const { OWN_SUBJECT_RULE: r } = run(['pet']);
  assert(/OWN REFERENCE PHOTO FOR: animal/.test(r), r.slice(0, 120));
  assert(/never its breed, model, colour, markings or size/.test(r));
  assert(/write "the dog", not "a wet, sandy golden retriever"/.test(r), 'carries the real measured example');
  assert(/\[INFLUENCER\]/.test(r), 'ties itself to the rule that already works');
});
t('vehicle alone → the vehicle wording, and NO pet wording leaks in', () => {
  const { OWN_SUBJECT_RULE: r } = run(['vehicle']);
  assert(/FOR: vehicle\./.test(r), r.slice(0, 120));
  assert(!/animal/.test(r), 'a user with only a vehicle is told nothing about animals');
  assert(/the car \/ the bike/.test(r));
});
t('both → both labels, joined, plural grammar', () => {
  const { OWN_SUBJECT_RULE: r } = run(['pet', 'vehicle']);
  assert(/FOR: animal and vehicle\./.test(r), r.slice(0, 140));
  assert(/applies to these exactly/.test(r), 'plural form when there are two');
  assert(/the dog \/ the cat, the car \/ the bike/.test(r));
});
t('singular grammar when there is one kind', () => {
  assert(/applies to this exactly/.test(run(['pet']).OWN_SUBJECT_RULE));
});
t('unknown / unsupported types are dropped — person and outfit are deliberately OUT of scope', () => {
  // 'person' collides with the multi-person rule; 'outfit' is already covered by the wardrobe clause.
  assert.deepStrictEqual(run(['person', 'outfit', 'spaceship']).elementTypes, []);
  assert.strictEqual(run(['person', 'outfit']).OWN_SUBJECT_RULE, '');
  assert.deepStrictEqual(run(['pet', 'person']).elementTypes, ['pet']);
});
t('duplicates collapse, and a non-array is ignored rather than throwing', () => {
  assert.deepStrictEqual(run(['pet', 'pet', 'vehicle']).elementTypes, ['pet', 'vehicle']);
  assert.deepStrictEqual(run('pet').elementTypes, []);
  assert.deepStrictEqual(run(null).elementTypes, []);
});
t('the rule frees words — it forbids description, it never asks for more text', () => {
  const r = run(['pet', 'vehicle']).OWN_SUBJECT_RULE;
  assert(/frees words rather than spending them/.test(r));
  assert(!/\badd\b|\bappend\b|\balso write\b/i.test(r), 'no instruction that would lengthen the output prompt');
});

// ── the cache key MUST carry it, or the 3-min join serves a prompt built without the rule ──
const joinKey = grab('function cloneJoinKey(b) {', '\nfunction runRecorded', 'cloneJoinKey');
const keyOf = new Function('b', joinKey.replace('function cloneJoinKey(b) {', '').replace(/\}\s*$/, '') + '');
t('cloneJoinKey separates two otherwise-identical requests by elementTypes', () => {
  assert(/elementTypes/.test(joinKey), 'cloneJoinKey does not mention elementTypes at all');
  const base = { locationId: 'L', videoUrl: 'V' };
  assert.notStrictEqual(keyOf({ ...base }), keyOf({ ...base, elementTypes: ['pet'] }));
  assert.notStrictEqual(keyOf({ ...base, elementTypes: ['pet'] }), keyOf({ ...base, elementTypes: ['pet', 'vehicle'] }));
});
t('…and order does not create a false miss', () => {
  const base = { locationId: 'L', videoUrl: 'V' };
  assert.strictEqual(keyOf({ ...base, elementTypes: ['pet', 'vehicle'] }), keyOf({ ...base, elementTypes: ['vehicle', 'pet'] }));
});
t('the rule is wired into sysSend and suppressed on bgswap, like PRONOUN_RULE', () => {
  assert(/\(OWN_SUBJECT_RULE && !isBgSwap\) \? OWN_SUBJECT_RULE : ''/.test(SRC), 'not joined into sysSend with the bgswap guard');
});
t('the response echoes what the prompt was built under', () => {
  assert(/elementTypes: \(OWN_SUBJECT_RULE && !isBgSwap\) \? elementTypes : \[\]/.test(SRC));
});

console.log(fail ? `FAIL ${fail} failed, ${pass} passed` : `OK ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
