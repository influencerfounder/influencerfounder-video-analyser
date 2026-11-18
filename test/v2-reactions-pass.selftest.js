#!/usr/bin/env node
// 👀 REACTIONS PASS (2.105.0 / v2-1.16.0, VQL 2026-11-17-05): which shots are re-checked, and what the merge accepts.
const assert = require('assert');
const { pickReactionShots, mergeReactions, reactionFrameTimes, REACTIONS_SYSTEM } = require('../v2/reactions');
const { validateSpec } = require('../v2/spec');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const base = () => ({
  look: 'phone', setting: 'mall', overlay_text: '',
  outfit: { top_name: 'a top', top_front: 'blue', top_back: 'not shown', bottom: 'shorts', shoes: 'heels', accessories: '' },
  cast: [{ id: 'P1', label: 'the woman in the pink cardigan', look: 'pink', sex: 'woman', face: 'clear' }, { id: 'P2', label: 'the bald man', look: 'black shirt', sex: 'man', face: 'clear' }],
  people_move: true,
  shots: [
    { start: 0, cut_before: false, size: 'full body', camera: { move: 'fixed' }, main_visible: true, main_events: ['walks toward the camera'], others: [{ id: 'P2', events: ['walks past'] }] },
    { start: 3.6, cut_before: true, size: 'medium', camera: { move: 'fixed' }, main_visible: false, main_events: [], others: [{ id: 'P1', events: ['walks away, neutral expression'] }] },
    { start: 4.8, cut_before: true, size: 'full body', camera: { move: 'fixed' }, main_visible: true, main_events: ['walks on'], others: [] },
  ],
});
t('picks only cutaways with people when nothing is announced', () => { assert.deepStrictEqual(pickReactionShots(base()), [1]); });
t('an overlay that announces reactions adds the shots with MAIN that show people', () => { const s = base(); s.overlay_text = "People's reactions to this blue outfit"; assert.deepStrictEqual(pickReactionShots(s), [0, 1]); });
t('no cast = no pass (0 cost)', () => { const s = base(); s.cast = []; assert.deepStrictEqual(pickReactionShots(s), []); });
t('no cutaway and no announcement = no pass', () => { const s = base(); s.shots.splice(1, 1); assert.deepStrictEqual(pickReactionShots(s), []); });
t('frame times sit inside the shot', () => { const ts = reactionFrameTimes(3.6, 4.8); assert.strictEqual(ts.length, 4); assert.ok(ts.every((x) => x > 3.6 && x < 4.8)); });
t('merge: a seen look replaces the neutral line, cast ids only, nothing else touched', () => {
  const s = base();
  const ans = { shots: [{ start: 3.6, others: [{ id: 'P1', events: ['stops, turns round and stares into the camera, eyebrows raised'] }, { id: 'P9', events: ['stares into the camera'] }] }, { start: 0, others: [{ id: 'P2', events: ['stares at MAIN'] }] }] };
  const m = mergeReactions(s, ans, [1]);
  assert.deepStrictEqual(m.spec.shots[1].others, [{ id: 'P1', events: ['stops, turns round and stares into the camera, eyebrows raised'] }]);
  assert.deepStrictEqual(m.spec.shots[0].others, [{ id: 'P2', events: ['walks past'] }], 'shot 0 was not asked');
  assert.strictEqual(m.changed.length, 1);
  assert.deepStrictEqual(validateSpec(m.spec), []);
});
t('merge: MAIN named in a cutaway is refused, "neutral" is refused, no-look answer is refused', () => {
  const s = base();
  for (const ev of [['stares at MAIN'], ['looks ahead, neutral'], ['walks away']]) {
    const m = mergeReactions(s, { shots: [{ start: 3.6, others: [{ id: 'P1', events: ev }] }] }, [1]);
    assert.strictEqual(m.changed.length, 0, ev.join());
  }
});
t('merge: a cast person missing from a shot with MAIN may be added there', () => {
  const s = base(); s.overlay_text = 'reactions';
  const m = mergeReactions(s, { shots: [{ start: 4.8, others: [{ id: 'P2', events: ['stares at MAIN, mouth open'] }] }] }, [2]);
  assert.deepStrictEqual(m.spec.shots[2].others, [{ id: 'P2', events: ['stares at MAIN, mouth open'] }]);
});
t('the pass prompt keeps the guards (no MAIN in cutaways, ordinary glance, no invented stare)', () => {
  assert.ok(/WITHOUT MAIN never write "MAIN"/.test(REACTIONS_SYSTEM));
  assert.ok(/ordinary glance/.test(REACTIONS_SYSTEM) && /never an invented stare/.test(REACTIONS_SYSTEM));
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
