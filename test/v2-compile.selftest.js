#!/usr/bin/env node
// 🧪 RECREATE v2 compiler — one check per RULE in v2/compile.js (the rule gate's "(c) a selftest").
// The spec below is shaped like a real lobby analysis (5 measured cuts, back print + plain front).
const assert = require('assert');
const { compile, RULES, measuredCameraFor } = require('../v2/compile');
const { writerSystem, parseSpec, validateSpec, WRITER_RULES } = require('../v2/spec');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

const LOBBY = {
  look: 'phone', setting: 'a grand hotel lobby with golden marble columns, warm evening light',
  outfit: { top_name: 'a black crew-neck T-shirt', top_front: 'plain black with a small gold crown logo at the chest and "MI VIDA LOCA" at the collar', top_back: 'large white "INK ADDICT" lettering above crossed tattoo machines', bottom: 'black slim joggers', shoes: 'white chunky sneakers', accessories: 'aviator sunglasses, a thick gold chain, a gold watch' },
  cast: [{ id: 'P1', label: 'the woman in the white crop top', look: 'long blonde hair, dark flared jeans' }, { id: 'P2', label: 'the woman in the white halter top', look: 'long dark-brown hair' }],
  people_move: true,
  shots: [
    { start: 0, size: 'full body', angle: 'from behind', camera: { move: 'tracks forward' }, garment_side: 'back', main_events: ['walks away from the camera', 'slowly turns the head to screen-left'], others: [{ id: 'P1', events: ['walks beside him'] }] },
    { start: 1.25, cut_before: true, size: 'medium close-up', camera: { move: 'fixed' }, garment_side: 'front', main_events: ['runs one hand back through the hair'] },
    { start: 2.9, cut_before: true, size: 'medium close-up', camera: { move: 'pans', direction: 'right' }, garment_side: 'front', main_events: ['presses both hands on top of the head'] },
    { start: 5.1, cut_before: true, main_visible: false, size: 'close-up', camera: { move: 'fixed' }, main_events: [], others: [{ id: 'P2', events: ['turns from profile to the camera', 'smiles'] }] },
    { start: 7.0, cut_before: true, size: 'wide', camera: { move: 'fixed' }, garment_side: 'front', main_events: ['walks toward the camera'] },
    { start: 7.7, cut_before: true, size: 'medium close-up', camera: { move: 'fixed' }, garment_side: 'front', main_events: ['adjusts the sunglasses with two fingers'] },
  ],
};
const CUTS = [1.21, 2.92, 5.08, 7.04, 7.67];
const CAM = [{ from: 0, to: 1, pan: 'left' }, { from: 1.21, to: 2.92 }, { from: 2.92, to: 4.92, pan: 'left' }, { from: 5.08, to: 9.04 }];
const base = { name: 'Kryfex', gender: 'male', cuts: CUTS, camera: CAM, durationSec: 9.2 };

t('every rule has a reason (the gate\'s paperwork)', () => Object.values(RULES).forEach(r => assert.ok(r.length > 40)));

t('measuredCuts: shots start exactly at the measured cuts, the first at 0', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  assert.deepStrictEqual(r.segments.map(s => s.start), [0, ...CUTS]);
  assert.ok(/Shot 2 \[1\.2-2\.9s\]/.test(r.prompt), r.prompt);
});
t('measuredCuts: a writer start 0.04 s off is snapped and logged', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  assert.ok(r.log.some(l => l.rule === 'measuredCuts' && l.snapped));
});
t('hard cut ends every segment that a cut follows, never the last', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  const lines = r.prompt.split('\n').filter(l => /^Shot \d/.test(l));
  assert.strictEqual(lines.length, 6);
  lines.slice(0, 5).forEach(l => assert.ok(/Hard cut\.$/.test(l), l));
  assert.ok(!/Hard cut/.test(lines[5]));
  assert.ok(!/Generate single shot/.test(r.prompt));
});
t('garmentSide: back shots restate the BACK, front shots the FRONT', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  const lines = r.prompt.split('\n').filter(l => /^Shot \d/.test(l));
  assert.ok(/the back of Kryfex's black crew-neck T-shirt faces the camera: large white "INK ADDICT"/i.test(lines[0]), lines[0]);
  assert.ok(/the front of Kryfex's black crew-neck T-shirt faces the camera: plain black with a small gold crown/i.test(lines[1]), lines[1]);
  assert.ok(!/INK ADDICT/.test(lines[1]), 'the back print must not be named in a front-facing shot');
});
t('garmentSide: a shot without MAIN carries no garment line', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  const l4 = r.prompt.split('\n').find(l => l.startsWith('Shot 4'));
  assert.ok(/Kryfex is not in this shot/.test(l4) && !/faces the camera:/.test(l4), l4);
});
t('outfitOnce: one outfit sentence with front AND back, "same outfit … every shot"', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  const head = r.prompt.split('\n\n')[0];
  assert.ok(/Kryfex wears a black crew-neck T-shirt \(front: .*; back: .*INK ADDICT.*\), black slim joggers/.test(head), head);
  assert.ok(/the same outfit, fully dressed, in every shot/.test(head));
});
t('measuredCamera: the writer\'s "pans right" is flipped to the measured LEFT and logged', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  const l3 = r.prompt.split('\n').find(l => l.startsWith('Shot 3'));
  assert.ok(/the camera pans left/.test(l3) && !/pans right/.test(l3), l3);
  assert.ok(r.log.some(l => l.rule === 'measuredCamera' && l.shot === 3 && l.measured === 'left'));
});
t('measuredCamera: a writer "tracks forward" with a measured pan left is replaced only on a LEFT/RIGHT conflict', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  const l1 = r.prompt.split('\n').find(l => l.startsWith('Shot 1'));
  assert.ok(/the camera tracks forward/.test(l1), l1);
});
t('measuredCamera: writer says fixed, measurement shows a clear pan → the pan is written', () => {
  const spec = { outfit: {}, shots: [{ start: 0, camera: { move: 'fixed' }, main_events: ['walks'] }] };
  const r = compile(spec, { name: 'Kryfex', camera: [{ from: 0, to: 7, pan: 'left' }], durationSec: 7, model: 'wan' });
  assert.ok(/the camera pans left/i.test(r.prompt), r.prompt);
});
t('fixedShot: a holding camera is written as "fixed shot"', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  assert.ok(/Shot 2 \[[^\]]+\]: Medium close-up, fixed shot, the camera does not move\./.test(r.prompt), r.prompt.split('\n').find(l => l.startsWith('Shot 2')));
});
t('noTempoWords: "slowly" never reaches the prompt', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  assert.ok(!/slowly|gently|unhurried/i.test(r.prompt));
  assert.ok(/turns the head to screen-left/.test(r.prompt));
});
t('stableLabels: other people are named once in the cast and reused by label', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  assert.ok(/Also in the video: the woman in the white crop top \(long blonde hair, dark flared jeans\)/.test(r.prompt));
  assert.ok(/The woman in the white halter top turns from profile to the camera, then smiles\./.test(r.prompt), r.prompt);
  assert.ok(/nobody is frozen/.test(r.prompt));
});
t('wanAudio: Wan gets no-dialogue/no-music, Seedance does not', () => {
  assert.ok(/No dialogue\. No background music\.$/.test(compile(LOBBY, { ...base, model: 'wan' }).prompt));
  assert.ok(!/No dialogue/.test(compile(LOBBY, { ...base, model: 'seedance' }).prompt));
});
t('seedance: whole seconds and @Image bindings; Wan: "Image N"', () => {
  const refs = [{ kind: 'face' }, { kind: 'outfit_front' }, { kind: 'outfit_back' }];
  const s = compile(LOBBY, { ...base, model: 'seedance', refs }).prompt;
  const w = compile(LOBBY, { ...base, model: 'wan', refs }).prompt;
  assert.ok(/Shot 2 \[1-3s\]/.test(s), s);
  assert.ok(/@Image 1 shows Kryfex's face; @Image 2 shows the outfit from the front; @Image 3 shows the outfit from the back\./.test(s));
  assert.ok(/(^|[^@])Image 1 shows Kryfex's face/.test(w) && !/@Image/.test(w));
});
t('single take: no cuts → "Generate single shot." and phases continue seamlessly', () => {
  const spec = { outfit: { top_name: 'a grey hoodie' }, shots: [{ start: 0, camera: { move: 'follows' }, main_events: ['walks toward the camera'] }, { start: 7, camera: { move: 'fixed' }, main_events: ['hands something to the driver'] }] };
  const r = compile(spec, { name: 'Kryfex', cuts: [], camera: [], durationSec: 23, model: 'wan' });
  assert.ok(/Generate single shot\./.test(r.prompt));
  assert.ok(/Shot 2 \[7-23s\]: Seamlessly continue from the last frame\./.test(r.prompt), r.prompt);
  assert.ok(!/Hard cut/.test(r.prompt));
});
t('a measured cut the writer skipped is reported, not invented', () => {
  const spec = { outfit: {}, shots: [{ start: 0, main_events: ['a'] }] };
  const r = compile(spec, { name: 'K', cuts: [3], durationSec: 6, model: 'wan' });
  assert.ok(r.log.some(l => l.missing === 3));
});
t('measuredCameraFor picks the label covering most of the window', () => {
  const m = measuredCameraFor([{ from: 0, to: 1, pan: 'right' }, { from: 1, to: 4, pan: 'left' }], 0, 4);
  assert.strictEqual(m.pan, 'left'); assert.ok(m.share >= 0.7);
});

t('identityFromRefs: tattoos/hair/skin in the outfit fields are stripped, clothing kept', () => {
  const spec = { outfit: { top_name: 'a black tee', accessories: 'black sunglasses, gold watch, visible sleeve tattoos on both arms and neck tattoos, small hoop earring' }, shots: [{ start: 0, main_events: ['walks'] }] };
  const r = compile(spec, { name: 'Kryfex', durationSec: 5, model: 'wan' });
  assert.ok(!/tattoo/i.test(r.prompt) && /black sunglasses, gold watch, small hoop earring/.test(r.prompt), r.prompt);
});
t('mainLabel: the writer placeholder MAIN never reaches the prompt', () => {
  const spec = { outfit: {}, cast: [{ id: 'P1', label: 'the woman in white' }], shots: [{ start: 0, main_events: ['walks'], others: [{ id: 'P1', events: ['walks beside MAIN'] }], end_state: "MAIN's hands on his head" }] };
  const r = compile(spec, { name: 'Kryfex', durationSec: 5, model: 'wan' });
  assert.ok(!/\bMAIN\b/.test(r.prompt) && /walks beside Kryfex/.test(r.prompt) && /End of the shot: Kryfex's hands on his head\./.test(r.prompt), r.prompt);
});
t('garmentSide uses the SHORT side text per shot, the full text once', () => {
  const spec = { outfit: { top_name: 'a black tee', top_front: 'solid black crew-neck T-shirt with a small gold crown logo on the left chest and MI VIDA LOCA at the collar', top_front_short: 'plain black, small gold crown on the chest' }, shots: [{ start: 0, garment_side: 'front', main_events: ['walks'] }] };
  const r = compile(spec, { name: 'Kryfex', durationSec: 5, model: 'wan' });
  assert.ok(/faces the camera: plain black, small gold crown on the chest\./.test(r.prompt));
  assert.strictEqual((r.prompt.match(/MI VIDA LOCA/g) || []).length, 1);
});
t('camera: free text in the move field is cut to the controlled words', () => {
  const spec = { outfit: {}, shots: [{ start: 0, camera: { move: 'pans left background columns drift right as camera pans', direction: 'left' }, main_events: ['walks'] }] };
  const r = compile(spec, { name: 'K', durationSec: 5, model: 'wan' });
  assert.ok(!/columns drift/.test(r.prompt), r.prompt);
});

t('phaseLength: 1 s phases in one take are merged; the hook stays its own phase; events are kept in order', () => {
  const spec = { outfit: {}, shots: [0, 1, 2, 4, 6, 7].map((st, i) => ({ start: st, cut_before: false, camera: { move: 'fixed' }, main_events: ['e' + i] })) };
  const r = compile(spec, { name: 'K', cuts: [], durationSec: 9, model: 'wan' });
  const lines = r.prompt.split('\n').filter(l => /^Shot/.test(l));
  assert.ok(/^Shot 1 \[0-1s\]: .*K e0\./.test(lines[0]), lines[0]);
  assert.ok(lines.every((l, k) => k === 0 || (() => { const m = /\[([\d.]+)-([\d.]+)s\]/.exec(l); return m[2] - m[1] >= 1.5; })()), lines.join('\n'));
  const all = r.prompt.replace(/[^e\d]/g, ' ');
  assert.ok(/e0[\s\S]*e1[\s\S]*e2[\s\S]*e3[\s\S]*e4[\s\S]*e5/.test(r.prompt), 'order kept');
  assert.ok(r.log.some(l => l.rule === 'phaseLength'));
});
t('phaseLength never builds a phase longer than 5 s', () => {
  const spec = { outfit: {}, shots: [0, 1, 4.5, 5.5, 6.5, 7.5, 8.5].map((st, i) => ({ start: st, main_events: ['e' + i] })) };
  const r = compile(spec, { name: 'K', cuts: [], durationSec: 12, model: 'wan' });
  r.segments.forEach(s => assert.ok(s.end - s.start <= 5.0001, JSON.stringify(r.segments)));
});
t('phaseLength never merges across a measured cut', () => {
  const r = compile(LOBBY, { ...base, model: 'wan' });
  assert.deepStrictEqual(r.segments.map(s => s.start), [0, ...CUTS]);
});

// ── writer contract ──
t('writer system carries every WRITER_RULE and the persona pronouns', () => {
  const s = writerSystem({ personaGender: 'male' });
  assert.ok(/he\/him/.test(s) && /VIEWER'S SCREEN/.test(s) && /ONE garment/.test(s) && /Never describe MAIN's face/.test(s) && /cannot be determined/.test(s));
  assert.ok(/they\/them/.test(writerSystem({ personaGender: null })), 'unknown gender → they/them, never a default');
  assert.ok(Object.keys(WRITER_RULES).length >= 7);
  assert.ok(/"bare_skin":\[\]/.test(writerSystem({})) && /a tank top = \["arms","shoulders"\]/.test(writerSystem({})), 'bare_skin is asked for, with the tank-top example');
});
t('parseSpec survives code fences; validateSpec catches a missing shot list', () => {
  assert.deepStrictEqual(parseSpec('```json\n{"a":1}\n```'), { a: 1 });
  assert.ok(validateSpec({ outfit: {} }).includes('shots missing'));
  assert.deepStrictEqual(validateSpec(LOBBY), []);
});

console.log(`\nv2-compile: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
