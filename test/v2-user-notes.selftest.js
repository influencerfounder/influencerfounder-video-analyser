// 👤💬 The posting account + the user's own notes reach the v2 writer (2026-10-16, @thomasshelbysosia: the
// older man filling the opening was made MAIN; the account is about the lookalike behind him).
'use strict';
const assert = require('assert');
const { userFacts, userInputs, v2JoinKey } = require('../v2/cloneV2');

// Nothing given → nothing added (every existing remake is unchanged).
assert.deepStrictEqual(userFacts({}), []);
assert.deepStrictEqual(userFacts({ sourceAuthor: '', mainHint: '  ', userChanges: '' }), []);

// The handle: cleaned, @ dropped, a hint (never an order).
const a = userFacts({ sourceAuthor: '@thomasshelbysosia' });
assert.strictEqual(a.length, 1);
assert.ok(a[0].startsWith('POSTED BY: @thomasshelbysosia.'));
assert.ok(/only as a hint/.test(a[0]));
assert.strictEqual(userInputs({ sourceAuthor: 'bad"name<script>' }).author, 'badnamescript');

// The hint overrides; the changes are written into the spec; both are cleaned and capped.
const f = userFacts({ mainHint: 'the man in the "flat cap" and black coat\n on the right', userChanges: 'make the car {red}' });
assert.strictEqual(f.length, 2);
assert.ok(f[0].startsWith('WHO MAIN IS'), f[0]);
assert.ok(f[0].includes('the man in the flat cap and black coat on the right.'), f[0]);
assert.ok(f[1].includes('make the car red.'), f[1]);
assert.ok(!/["{}\n]/.test(f.join(' ').replace(/\n/g, '')));
assert.ok(userInputs({ userChanges: 'x'.repeat(2000) }).changes.length === 600);

// The join key changes with every input: a corrected re-run never joins or reuses the wrong run.
const base = { locationId: 'L', videoUrl: 'https://v', name: 'Kryfex' };
const k0 = v2JoinKey(base);
assert.notStrictEqual(k0, v2JoinKey({ ...base, mainHint: 'the man in the cap' }));
assert.notStrictEqual(k0, v2JoinKey({ ...base, userChanges: 'red car' }));
assert.notStrictEqual(k0, v2JoinKey({ ...base, sourceAuthor: 'x' }));
assert.strictEqual(k0, v2JoinKey({ ...base }));
console.log('v2-user-notes selftest: OK');
// The second opinion (Gemini picks its own MAIN) is skipped once the user has named MAIN.
const src = require('fs').readFileSync(require('path').join(__dirname, '../v2/cloneV2.js'), 'utf8');
assert.ok(/const secondP = \(!kieKey && !userInputs\(req\.body \|\| \{\}\)\.mainHint && /.test(src), 'the second opinion must not run under a who-is-MAIN hint');
