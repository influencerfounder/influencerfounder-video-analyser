#!/usr/bin/env node
// 👀 REACTIONS (2.104.0 / v2-1.15.0, Video Quality Lab case 2026-11-17-05). The v2 writer never asked where other people
// LOOK, so a "People's reactions to this blue outfit" source came back with every bystander just walking past. Rule 10b
// asks for the look as an action; the compiler must carry it through: MAIN → the influencer's name where MAIN is in the
// shot, and a reaction cutaway (no MAIN) keeps its look into the camera without naming the influencer.
const assert = require('assert');
const { compile } = require('../v2/compile');
const { writerSystem, WRITER_RULES } = require('../v2/spec');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

const MALL = {
  look: 'phone', setting: 'an upscale shopping mall corridor, bright overhead light',
  outfit: { top_name: 'a pale-blue crochet halter top', top_front: 'pale-blue crochet lace halter', top_back: 'not shown', bottom: 'pale-blue lace mini shorts', shoes: 'light-blue heels', accessories: '' },
  cast: [{ id: 'P1', label: 'the older woman in the pink cardigan', look: 'pink cardigan, yellow floral skirt', sex: 'woman', face: 'clear' },
         { id: 'P2', label: 'the bald man in the black shirt', look: 'black shirt, jeans', sex: 'man', face: 'clear' }],
  people_move: true,
  shots: [
    { start: 0, size: 'full body', camera: { move: 'fixed' }, garment_side: 'side', main_events: ['stands in profile holding a phone'], others: [{ id: 'P1', events: ['turns round and stares at MAIN, mouth open'] }] },
    { start: 3, cut_before: true, main_visible: false, size: 'medium', camera: { move: 'fixed' }, main_events: [], others: [{ id: 'P2', events: ['stares straight into the camera, eyebrows raised', 'walks toward the camera'] }] },
  ],
};

t('writer prompt asks where people look (rule 10b) and keeps the no-invented-crowd guard', () => {
  const w = writerSystem({ personaGender: 'female' });
  assert.ok(/10b\. WHERE THEY LOOK/.test(w));
  assert.ok(/never name MAIN there/.test(w), 'reaction cutaways must not name MAIN');
  assert.ok(/lead that person's events with it/.test(w) && /keep the order the video shows/.test(w), 'a framed reaction leads, time order kept');
  assert.ok(/an ordinary glance is "glances at MAIN"/.test(w), 'no dramatising a glance');
  assert.ok(/never write a crowd staring, filming or gathering that the frames do not show/.test(w), 'guard of VQL 2026-09-02-02');
  assert.ok(WRITER_RULES.reactions && /2026-11-17-05/.test(WRITER_RULES.reactions));
});
t('compile: a look at MAIN in a shot with MAIN names the influencer', () => {
  const r = compile(MALL, { name: 'Leilaa', gender: 'female', cuts: [3], camera: [], durationSec: 5, model: 'wan' });
  assert.ok(/the older woman in the pink cardigan turns round and stares at Leilaa, mouth open/i.test(r.prompt), r.prompt);
  assert.ok(!/\bMAIN\b/.test(r.prompt));
});
t('compile: a reaction cutaway keeps the stare into the camera, first, and does not name her in it', () => {
  const r = compile(MALL, { name: 'Leilaa', gender: 'female', cuts: [3], camera: [], durationSec: 5, model: 'wan' });
  const l2 = r.prompt.split('\n').find(l => l.startsWith('Shot 2'));
  assert.ok(/the bald man in the black shirt stares straight into the camera, eyebrows raised, then walks toward the camera/i.test(l2), l2);
  assert.ok(!/stares? at Leilaa/.test(l2), l2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
