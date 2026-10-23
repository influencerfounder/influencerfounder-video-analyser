#!/usr/bin/env node
// 🎭 Background people get ONE small change (Mike, 2026-10-23, VQL case 2026-10-23-01): v2/castChange.js picks it,
// compile.js writes it after the person's label. Guards: clear faces only, no children, max 4, never against the label,
// facial hair only on men, never on a product-only run, never a change the writer made up.
const assert = require('assert');
const { pickCastChanges, optionsFor, MAX_CHANGED } = require('../v2/castChange');
const { compile } = require('../v2/compile');
const { writerSystem } = require('../v2/spec');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

const base = (cast) => ({ look: 'phone', setting: 'a bar at night', outfit: { top_name: 'a black T-shirt' }, cast,
  shots: [{ start: 0, size: 'medium', camera: { move: 'fixed' }, main_events: ['raises a glass'], others: cast.map((p) => ({ id: p.id, events: ['talks'] })) }] });

t('writer is asked for sex, face, facial_hair and glasses per cast member', () => {
  const w = writerSystem({});
  for (const k of ['"sex"', '"face"', '"facial_hair"', '"glasses"']) assert.ok(w.includes(k), k);
});

t('a clear-faced man gets face:true and one option; the writer\'s own change is dropped', () => {
  const s = pickCastChanges(base([{ id: 'P1', label: 'the older man in a blue apron', look: 'blue apron', sex: 'man', face: 'clear', facial_hair: 'none', glasses: false, change: { text: 'looks like MAIN' } }]), seq(0));
  const c = s.cast[0].change;
  assert.strictEqual(c.face, true);
  assert.notStrictEqual(c.text, 'looks like MAIN');
  assert.ok(c.text.length > 0);
});

t('small, hidden and child faces stay exactly as they are', () => {
  const s = pickCastChanges(base([
    { id: 'P1', label: 'a man far back', sex: 'man', face: 'small' },
    { id: 'P2', label: 'a man facing away', sex: 'man', face: 'hidden' },
    { id: 'P3', label: 'a boy in a red cap', sex: 'child', face: 'clear' },
  ]));
  assert.ok(s.cast.every((p) => !p.change));
});

t(`at most ${MAX_CHANGED} people change, the first (most visible) ones`, () => {
  const cast = Array.from({ length: 7 }, (_, i) => ({ id: 'P' + (i + 1), label: 'person ' + (i + 1), sex: 'woman', face: 'clear', glasses: false }));
  const s = pickCastChanges(base(cast));
  assert.strictEqual(s.cast.filter((p) => p.change).length, MAX_CHANGED);
  assert.ok(s.cast.slice(0, MAX_CHANGED).every((p) => p.change));
});

t('never against the label: a bearded label gets no beard change, a cap hides the hair, glasses already named', () => {
  const o1 = optionsFor({ label: 'the man with a full beard', sex: 'man', facial_hair: 'beard', glasses: false }, () => 0);
  assert.ok(!o1.some((o) => o.kind === 'facial'));
  const o2 = optionsFor({ label: 'the man in a black cap', sex: 'man', facial_hair: 'none', glasses: false }, () => 0);
  assert.ok(!o2.some((o) => o.kind === 'parting' || o.kind === 'shade'));
  const o3 = optionsFor({ label: 'the woman', look: 'round sunglasses on her head', sex: 'woman', glasses: false }, () => 0);
  assert.ok(!o3.some((o) => o.kind === 'glasses'));
});

t('facial hair only for men', () => {
  const o = optionsFor({ label: 'the woman in white', sex: 'woman', facial_hair: 'none', glasses: true }, () => 0);
  assert.ok(!o.some((x) => x.kind === 'facial'));
  const m = optionsFor({ label: 'the man in white', sex: 'man', facial_hair: 'none', glasses: true }, () => 0);
  assert.ok(m.some((x) => x.kind === 'facial' && x.text === 'light stubble'));
});

t('glasses only as a last resort (an object, not a face or hair change)', () => {
  const o = optionsFor({ label: 'the woman in white', sex: 'woman', glasses: false }, () => 0);
  assert.ok(!o.some((x) => x.kind === 'glasses'), 'hair options exist → no glasses');
  const o2 = optionsFor({ label: 'the woman in a headscarf', sex: 'woman', glasses: false }, () => 0);
  assert.deepStrictEqual(o2.map((x) => x.kind), ['glasses']);
});

t('no options left → face only, no text', () => {
  const s = pickCastChanges(base([{ id: 'P1', label: 'the woman in a headscarf and sunglasses', sex: 'woman', face: 'clear', glasses: true }]));
  assert.deepStrictEqual(s.cast[0].change, { face: true, kind: 'face', text: '' });
});

t('the random source decides the option (varies per video)', () => {
  const p = [{ id: 'P1', label: 'the man by the car', sex: 'man', face: 'clear', facial_hair: 'none', glasses: false }];
  const kinds = new Set([0, 0.3, 0.6, 0.9].map((r) => pickCastChanges(base(p), () => r).cast[0].change.kind));
  assert.ok(kinds.size >= 3, [...kinds].join(','));
});

t('compile writes the change after the label once; the label stays the id in shots', () => {
  const s = pickCastChanges(base([{ id: 'P1', label: 'the man by the car', look: 'grey suit', sex: 'man', face: 'clear', facial_hair: 'none', glasses: false }]), () => 0);
  const out = compile(s, { name: 'Kryfex', model: 'wan', durationSec: 4 });
  assert.ok(out.prompt.includes('the man by the car (grey suit; with the hair parted on the other side)'), out.prompt);
  assert.ok(/The man by the car talks\./.test(out.prompt));
  assert.ok(out.log.some((l) => l.rule === 'castChange'));
});

t('a spec with no change compiles byte-identical to before', () => {
  const plain = base([{ id: 'P1', label: 'the man by the car', look: 'grey suit' }]);
  const out = compile(plain, { name: 'Kryfex', model: 'wan', durationSec: 4 });
  assert.ok(out.prompt.includes('Also in the video: the man by the car (grey suit).'), out.prompt);
});

t('product-only runs never write a change (the people stay as the source shows them)', () => {
  const s = pickCastChanges(base([{ id: 'P1', label: 'the man by the car', look: 'grey suit', sex: 'man', face: 'clear', facial_hair: 'none', glasses: false }]), () => 0);
  const out = compile(s, { name: 'Kryfex', model: 'wan', durationSec: 4, productOnly: true, productName: 'the bag' });
  assert.ok(!/parted on the other side/.test(out.prompt));
});

t('cloneV2 picks the changes ONCE, before the first compile and before the late second opinion copies the spec', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'v2', 'cloneV2.js'), 'utf8');
  const pick = src.indexOf('spec = pickCastChanges(spec);');
  assert.ok(pick > 0, 'pickCastChanges call missing');
  assert.strictEqual(src.split('pickCastChanges(').length - 1, 1, 'one call only');
  assert.ok(pick < src.indexOf("const wan = compile(spec, { ...copts, model: 'wan' });"));
  assert.ok(pick < src.indexOf('const late = startLateSecondOpinion({'));
});

console.log(`\ncast-change: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
