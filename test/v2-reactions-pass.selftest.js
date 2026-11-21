#!/usr/bin/env node
// 👀 REACTIONS PASS (2.105.0 / v2-1.16.0, VQL 2026-11-17-05): which shots are re-checked, and what the merge accepts.
const assert = require('assert');
const { repairEvent, pickReactionShots, mergeReactions, reactionFrameTimes, REACTIONS_SYSTEM } = require('../v2/reactions');
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
t('merge REPAIRS: a look at MAIN in a cutaway becomes into the camera, "neutral" is dropped, no-look is refused and recorded', () => {
  const s = base();
  let m = mergeReactions(s, { shots: [{ start: 3.6, others: [{ id: 'P1', events: ['stops, turns round and stares back at MAIN, eyebrows raised'] }] }] }, [1]);
  assert.deepStrictEqual(m.spec.shots[1].others[0].events, ['stops, turns round and stares back into the camera, eyebrows raised']);
  m = mergeReactions(s, { shots: [{ start: 3.6, others: [{ id: 'P1', events: ['glances back over the shoulder into the camera, neutral expression'] }] }] }, [1]);
  assert.deepStrictEqual(m.spec.shots[1].others[0].events, ['glances back over the shoulder into the camera']);
  m = mergeReactions(s, { shots: [{ start: 3.6, others: [{ id: 'P1', events: ['walks away'] }, { id: 'P9', events: ['stares'] }] }] }, [1]);
  assert.strictEqual(m.changed.length, 0);
  assert.deepStrictEqual(m.refused.map((r) => r.why), ['no look', 'not in the cast']);
});
t('repairEvent leaves a shot WITH MAIN alone and never touches "the main corridor"', () => {
  assert.strictEqual(repairEvent('stares at MAIN, mouth open', false), 'stares at MAIN, mouth open');
  assert.strictEqual(repairEvent('looks down the main corridor', true), 'looks down the main corridor');
});
t('merge: a cast person missing from a shot with MAIN may be added there', () => {
  const s = base(); s.overlay_text = 'reactions';
  const m = mergeReactions(s, { shots: [{ start: 4.8, others: [{ id: 'P2', events: ['stares at MAIN, mouth open'] }] }] }, [2]);
  assert.deepStrictEqual(m.spec.shots[2].others, [{ id: 'P2', events: ['stares at MAIN, mouth open'] }]);
});
t('the pass prompt keeps the guards (no MAIN in cutaways, ordinary glance, no invented stare)', () => {
  assert.ok(/WITHOUT MAIN the camera stands where MAIN is/.test(REACTIONS_SYSTEM) && /never "MAIN"/.test(REACTIONS_SYSTEM));
  assert.ok(/ordinary glance/.test(REACTIONS_SYSTEM) && /never an invented stare/.test(REACTIONS_SYSTEM));
});
t('reaction direction never goes into opening_changes (reviewer 2026-11-18)', () => {
  const { userFacts } = require('../v2/cloneV2');
  const f = userFacts({ userChanges: 'the bystanders stare at her amazed' }).join(' ');
  assert.ok(/Never put other people's looks or reactions into opening_changes/.test(f));
});
t('the pass keeps 60 s back and will not start under 130 s', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../v2/reactions.js'), 'utf8');
  assert.ok(/deadline - Date\.now\(\) < 130000/.test(src) && /deadline: deadline \? deadline - 60000/.test(src));
});
t('merge reads the 2.105.3 "people" answer with facing; a no-look person is refused with the facing kept', () => {
  const s = base();
  const m = mergeReactions(s, { shots: [{ start: 3.6, people: [
    { id: 'P1', facing: ['away', 'away', 'lens', 'lens'], face: 'eyebrows raised', events: ['stops, turns round and stares back into the camera, eyebrows raised', 'walks on'] },
    { id: 'P2', facing: ['down', 'down', 'down', 'down'], face: '', events: ['walks past on the phone'] }] }] }, [1]);
  assert.deepStrictEqual(m.spec.shots[1].others.find((o) => o.id === 'P1').events, ['stops, turns round and stares back into the camera, eyebrows raised', 'walks on']);
  assert.ok(/no look \(facing down,down,down,down\)/.test(m.refused[0].why), JSON.stringify(m.refused));
});
t('the pass asks for every person per frame and does not show the first analyst\'s events', () => {
  assert.ok(/for EVERY cast person you can see in a shot \(never skip one\)/.test(REACTIONS_SYSTEM));
  const src = require('fs').readFileSync(require('path').join(__dirname, '../v2/reactions.js'), 'utf8');
  assert.ok(!/Current events of others/.test(src));
});
// 2.105.4 (/toolscan 2026-11-21, TOOL-CLEANUP I62): the answer stored on live job rj_mwpakqps6v7q (a car park filmed
// from above, nobody reacting). The word gate alone rewrote every one of these people: "looking down" and "not looking
// at the camera" are look WORDS, not looks. The model's own facing says so.
const carPark = () => {
  const s = base();
  s.cast = ['P1', 'P2', 'P5'].map((id) => ({ id, label: 'the man ' + id, look: 'dark jacket', sex: 'man', face: 'clear' }));
  s.shots = [6, 9, 12, 22].map((start) => ({ start, cut_before: true, size: 'wide', camera: { move: 'fixed' }, main_visible: false, main_events: [], others: [{ id: 'P5', events: ['walks to the car'] }] }));
  return s;
};
const carParkAnswer = { shots: [
  { start: 6, people: [{ id: 'P5', facing: ['down', 'down', 'down', 'down'], face: '', events: ['stands by the car door, looking down', 'opens the car door, attention on the car', 'remains focused on the door, not looking up'] }] },
  { start: 9, people: [{ id: 'P5', facing: ['down', 'down', 'down', 'down'], face: '', events: ['stands near the car with the door open, looking down', 'walks a few steps, still looking down', 'continues attending to the car, not looking at the camera'] }] },
  { start: 12, people: [{ id: 'P5', facing: ['away', 'away', 'away', 'away'], face: '', events: ['walks toward the gate area, back to camera', 'continues walking away from the camera'] }, { id: 'P2', facing: ['down', 'down', 'down', 'down'], face: '', events: ['stands by the open car door, looking down', 'remains by the car, attention down'] }] },
  { start: 22, people: [{ id: 'P1', facing: ['down', 'down', 'down', 'down'], face: '', events: ['opens the car door, looking down at the handle', 'holds the door open, attention on the car'] }, { id: 'P2', facing: ['side', 'side', 'side', 'side'], face: '', events: ['stands near the car, looking to the side', 'watches the scene from a distance'] }] },
] };
t('LIVE ANSWER: nobody faces the lens or MAIN = nothing is rewritten, the writer\'s spec stays', () => {
  const s = carPark();
  const m = mergeReactions(s, carParkAnswer, [0, 1, 2, 3]);
  assert.strictEqual(m.changed.length, 0, JSON.stringify(m.changed));
  assert.deepStrictEqual(m.spec.shots, s.shots);
  assert.strictEqual(m.refused.length, 6);
  assert.ok(m.refused.every((r) => /^no look \(facing /.test(r.why)), JSON.stringify(m.refused.map((r) => r.why)));
});
t('a look the model SAW (lens, any case; MAIN in a shot with MAIN) is still rewritten', () => {
  const s = carPark();
  let m = mergeReactions(s, { shots: [{ start: 6, people: [{ id: 'P5', facing: ['down', 'Lens', 'lens', 'down'], face: 'staring', events: ['looks up from the car door and stares into the camera'] }] }] }, [0]);
  assert.deepStrictEqual(m.changed.map((c) => c.id), ['P5']);
  for (const f of ['lens', 'MAIN', 'toward the lens', 'camera']) assert.strictEqual(mergeReactions(carPark(), { shots: [{ start: 6, people: [{ id: 'P5', facing: [f], face: '', events: ['stares into the camera'] }] }] }, [0]).changed.length, 1, f);
  for (const f of ['camera left', 'main entrance', 'side', 'not visible']) assert.strictEqual(mergeReactions(carPark(), { shots: [{ start: 6, people: [{ id: 'P5', facing: [f], face: '', events: ['stares into the camera'] }] }] }, [0]).changed.length, 0, f);
  const b = base(); b.overlay_text = 'reactions';
  m = mergeReactions(b, { shots: [{ start: 0, people: [{ id: 'P2', facing: ['side', 'MAIN', 'MAIN', 'away'], face: 'mouth open', events: ['stares at MAIN while walking past, mouth open'] }] }] }, [0]);
  assert.deepStrictEqual(m.spec.shots[0].others, [{ id: 'P2', events: ['stares at MAIN while walking past, mouth open'] }]);
});
t('a negated look never reaches the spec: the clause is cut, an event that was only that is dropped', () => {
  assert.strictEqual(repairEvent('remains focused on the door, not looking up', true), 'remains focused on the door');
  assert.strictEqual(repairEvent('continues attending to the car, not looking at the camera', true), 'continues attending to the car');
  assert.strictEqual(repairEvent('walks past without glancing at MAIN', false), 'walks past');
  assert.strictEqual(repairEvent('does not look at the camera', true), '');
  assert.strictEqual(repairEvent("doesn't look up, keeps typing on the phone", true), 'keeps typing on the phone');
  assert.strictEqual(repairEvent('never looks at MAIN', false), '');
  // a "not" that is not about a look stays, and so does every sentence without a negated look, character for character
  for (const e of ['stares into the camera, not smiling', 'watches MAIN, never taking her eyes off', 'looks up, not at the phone', 'looks straight into the camera without blinking', 'stares (mouth open) while walking past', 'walks past without watches on his wrist'])
    assert.strictEqual(repairEvent(e, false), e);
});
t('reviewer 2026-11-21: a double negative is a stare and stays; a real look joined to a negation survives; no fragments', () => {
  // 1. double negatives = holding the look
  for (const e of ['walks past without looking away from MAIN', 'keeps walking, never looking away from MAIN', 'never looks away from the camera', 'does not look away from the camera', "doesn't look away", 'could not look away from MAIN', 'can not look away from MAIN', 'cannot look away from MAIN', 'stares into the camera, not looking away'])
    assert.strictEqual(repairEvent(e, false), e);
  assert.strictEqual(repairEvent('not looking anywhere but at MAIN', false), 'looking at MAIN');
  // 2. the negated clause goes, the look joined by and / but / while stays
  assert.strictEqual(repairEvent('walks past, not looking at her phone but staring into the camera', true), 'walks past, staring into the camera');
  assert.strictEqual(repairEvent('stops, not watching the road and turns round to stare into the camera', true), 'stops and turns round to stare into the camera');
  assert.strictEqual(repairEvent('does not look at the phone and stares into the camera', true), 'stares into the camera');
  assert.strictEqual(repairEvent('not looking ahead but back at MAIN', false), 'looking back at MAIN');
  assert.strictEqual(repairEvent('does not look ahead but straight at MAIN', false), 'looks straight at MAIN');
  assert.strictEqual(repairEvent('is not staring but smiling at MAIN', false), 'smiling at MAIN');
  assert.strictEqual(repairEvent('glances at MAIN but does not stare', false), 'glances at MAIN');
  // reviewer round 2: the look verb is borrowed only before a preposition; a contrast word goes with the dropped half
  assert.strictEqual(repairEvent('not staring at MAIN but instead smiling', false), 'smiling');
  assert.strictEqual(repairEvent('not looking at the camera but instead typing on her phone', true), 'typing on her phone');
  assert.strictEqual(repairEvent('does not stare but only smiles at MAIN', false), 'smiles at MAIN');
  assert.strictEqual(repairEvent('does not look at MAIN but rather keeps walking', false), 'keeps walking');
  // 3. no fragment is left behind
  assert.strictEqual(repairEvent('could not look up', false), '');
  assert.strictEqual(repairEvent('keeps typing and still does not look up', false), 'keeps typing');
  assert.strictEqual(repairEvent('walks on; not looking back', false), 'walks on');
  assert.strictEqual(repairEvent('the man is not looking at the camera', true), '');
  assert.strictEqual(repairEvent('he does not look up', false), '');
  assert.strictEqual(repairEvent('walks past — not looking up', false), 'walks past');
  assert.strictEqual(repairEvent('walks past not looking up', false), 'walks past');
  // nits: curly apostrophe, "tries not to", "avoids", brackets, "without a glance"
  assert.strictEqual(repairEvent('doesn’t look up, keeps typing', false), 'keeps typing');
  assert.strictEqual(repairEvent('tries not to look at MAIN', false), '');
  assert.strictEqual(repairEvent('avoids looking at the camera, walks on', true), 'walks on');
  assert.strictEqual(repairEvent('walks past (not looking at MAIN)', false), 'walks past');
  assert.strictEqual(repairEvent('walks past without a glance at MAIN', false), 'walks past');
  // the merge the reviewer ran: every kept event is a whole phrase
  const s = carPark(); s.shots[0].main_visible = true;
  const m = mergeReactions(s, { shots: [{ start: 6, people: [{ id: 'P5', facing: ['MAIN', 'MAIN', 'down', 'down'], face: 'eyebrows raised', events: ['stares at MAIN, eyebrows raised', 'could not look away from MAIN', 'keeps typing and still does not look up', 'walks on; not looking back'] }] }] }, [0]);
  assert.deepStrictEqual(m.changed[0].events, ['stares at MAIN, eyebrows raised', 'could not look away from MAIN', 'keeps typing', 'walks on']);
  // and the turn-round of the open case, written the awkward way, is still taken over
  const c = carPark();
  const m2 = mergeReactions(c, { shots: [{ start: 6, people: [{ id: 'P5', facing: ['away', 'away', 'lens', 'lens'], face: 'staring', events: ['stops, not watching the road and turns round to stare into the camera'] }] }] }, [0]);
  assert.deepStrictEqual(m2.changed[0].events, ['stops and turns round to stare into the camera']);
});
t('a negated look inside an accepted answer is cut, an event that was only that is dropped', () => {
  const s = carPark();
  const m = mergeReactions(s, { shots: [{ start: 6, people: [{ id: 'P5', facing: ['lens', 'lens', 'down', 'down'], face: 'deadpan', events: ['stares into the camera while walking past', 'keeps walking, not looking at the phone', 'does not look back'] }] }] }, [0]);
  assert.deepStrictEqual(m.changed[0].events, ['stares into the camera while walking past', 'keeps walking']);
});
t('an answer WITHOUT facing falls back to the words, and a negated look alone is not a look', () => {
  const s = carPark();
  let m = mergeReactions(s, { shots: [{ start: 6, others: [{ id: 'P5', events: ['walks past, not looking at the camera'] }] }] }, [0]);
  assert.strictEqual(m.changed.length, 0);
  assert.strictEqual(m.refused[0].why, 'no look');
  m = mergeReactions(s, { shots: [{ start: 6, others: [{ id: 'P5', facing: [], events: ['glances into the camera while walking past'] }] }] }, [0]);
  assert.strictEqual(m.changed.length, 1, 'an empty facing list is "not given", the words decide');
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
