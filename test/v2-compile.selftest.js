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
t('identity refs (a tattooed influencer\'s own masters) are bound by name (2026-10-12)', () => {
  const r = compile(LOBBY, { ...base, model: 'wan', refs: [{ kind: 'first_frame' }, { kind: 'identity' }, { kind: 'identity' }] });
  assert.ok(/Image 2 shows Kryfex — the face, hair and every tattoo; Image 3 shows Kryfex — the face, hair and every tattoo/.test(r.prompt), r.prompt.slice(0, 900));
  assert.ok(!/body and every tattoo/.test(r.prompt), 'clothed scene: "body" points the model at the bare-torso masters (VQL 2026-10-30-02)');
});
t('identity label keeps "body" where skin shows (2026-10-30)', () => {
  const BARE = { ...LOBBY, outfit: { ...LOBBY.outfit, top_name: 'no top worn, shirtless', bare_skin: ['chest', 'belly'] } };
  const r = compile(BARE, { ...base, model: 'wan', refs: [{ kind: 'identity' }] });
  assert.ok(/Image 1 shows Kryfex — the face, hair, body and every tattoo/.test(r.prompt), r.prompt.slice(0, 600));
});
t('bareTop: a shirtless source is said as shirtless, never "fully dressed" (2026-10-12)', () => {
  const SHIRTLESS = { ...LOBBY, outfit: { top_name: 'no top worn, shirtless', top_front: 'not shown, bare chest', top_back: 'not shown, bare back', bottom: 'black athletic shorts', shoes: 'black sneakers', accessories: 'black duffel bag carried with shoulder strap', bare_skin: ['arms', 'shoulders', 'chest', 'belly', 'back', 'legs'] } };
  const head = compile(SHIRTLESS, { ...base, model: 'wan' }).prompt.split('\n\n')[0];
  assert.ok(/Kryfex is shirtless, wearing black athletic shorts, black sneakers, black duffel bag carried with shoulder strap — the same in every shot/.test(head), head);
  assert.ok(!/fully dressed/.test(head) && !/wears no top/.test(head), head);
  const SHORTS = { ...LOBBY, outfit: { ...LOBBY.outfit, bare_skin: ['arms', 'legs'] } };
  const h2 = compile(SHORTS, { ...base, model: 'wan' }).prompt.split('\n\n')[0];
  assert.ok(/the same outfit in every shot/.test(h2) && !/fully dressed/.test(h2), 'bare legs: same outfit, not "fully dressed": ' + h2);
});
t('bareTop: an OPEN shirt is never shirtless, even when its front says "bare chest" (2026-10-31, VQL 2026-10-26-01)', () => {
  const OPEN = { ...LOBBY, outfit: { top_name: "black ribbed knit short-sleeve polo shirt, worn open at the collar", top_front: 'plain black ribbed polo, unbuttoned, bare chest visible', top_back: 'not shown', bottom: 'beige pleated trousers', shoes: 'brown loafers', bare_skin: ['arms', 'chest'] } };
  const head = compile(OPEN, { ...base, model: 'wan' }).prompt.split('\n\n')[0];
  assert.ok(!/is shirtless/.test(head) && /Kryfex wears black ribbed knit short-sleeve polo shirt/.test(head), head);
  for (const name of ['open black shirt over a bare chest', 'unbuttoned denim jacket, bare torso underneath']) {
    const h = compile({ ...LOBBY, outfit: { ...OPEN.outfit, top_name: name } }, { ...base, model: 'wan' }).prompt.split('\n\n')[0];
    assert.ok(!/is shirtless/.test(h), name + ' → ' + h);
  }
  // still shirtless: no named top, or a name that is only the shirtless words
  const NONE = compile({ ...LOBBY, outfit: { ...OPEN.outfit, top_name: 'none', top_front: 'bare chest' } }, { ...base, model: 'wan' }).prompt.split('\n\n')[0];
  assert.ok(/Kryfex is shirtless/.test(NONE), NONE);
  const TOPLESS = compile({ ...LOBBY, outfit: { ...OPEN.outfit, top_name: 'shirtless, bare torso', top_front: 'not shown' } }, { ...base, model: 'wan' }).prompt.split('\n\n')[0];
  assert.ok(/Kryfex is shirtless/.test(TOPLESS), TOPLESS);
  // reviewer round 1: "no shirt" names no garment; the no-top list matches the tool's
  for (const name of ['no shirt, bare chest', 'shirtless (no shirt)', 'bare-chested, no shirt', 'barechested']) {
    const h = compile({ ...LOBBY, outfit: { ...OPEN.outfit, top_name: name } }, { ...base, model: 'wan' }).prompt.split('\n\n')[0];
    assert.ok(/Kryfex is shirtless/.test(h), name + ' → ' + h);
  }
  for (const name of ['unknown', 'nothing', 'cannot be determined.']) {
    const h = compile({ ...LOBBY, outfit: { ...OPEN.outfit, top_name: name, top_front: 'bare chest' } }, { ...base, model: 'wan' }).prompt.split('\n\n')[0];
    assert.ok(/Kryfex is shirtless/.test(h), name + ' → ' + h);
  }
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
t('single take: no cuts → "Generate single shot.", phases as "[a-bs]" lines with no Shot labels (oneHeaderPerTake)', () => {
  const spec = { outfit: { top_name: 'a grey hoodie' }, shots: [{ start: 0, camera: { move: 'follows' }, main_events: ['walks toward the camera'] }, { start: 7, camera: { move: 'fixed' }, main_events: ['hands something to the driver'] }] };
  const r = compile(spec, { name: 'Kryfex', cuts: [], camera: [], durationSec: 23, model: 'wan' });
  assert.ok(/Generate single shot\./.test(r.prompt));
  assert.ok(/^\[0-7s\] The camera follows\. Kryfex walks toward the camera\.$/m.test(r.prompt), r.prompt);
  assert.ok(/^\[7-23s\] The camera now holds still\. Kryfex hands something to the driver\.$/m.test(r.prompt), r.prompt);
  assert.ok(!/\bShot \d/.test(r.prompt) && !/Seamlessly/.test(r.prompt), 'no Shot label and no seam sentence in one take');
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
  const lines = r.prompt.split('\n').filter(l => /^\[/.test(l));
  assert.ok(/^\[0-1s\] .*K e0\./.test(lines[0]), lines[0]);
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

t('phase 3 bindings: opening frame, face, dressed front/back are named in order (Wan "Image N")', () => {
  const refs = [{ kind: 'first_frame' }, { kind: 'face' }, { kind: 'dressed_front' }, { kind: 'dressed_back' }];
  const r = compile(LOBBY, { ...base, model: 'wan', refs });
  assert.ok(/Image 1 is the opening frame — the video starts exactly as this image; Image 2 shows Kryfex's face; Image 3 shows Kryfex wearing the outfit, from the front; Image 4 shows Kryfex wearing the outfit, from the back\./.test(r.prompt), r.prompt.slice(0, 900));
});

// ── 2026-10-30: VQL case 2026-10-30-01 (plaza, rj_mvuhalai9rlh) — the spec as the writer returned it,
// rebuilt from the compiled prompt. One measured cut (the passer-by wipe at 2.1 s); the writer also
// marked a cut at 4.1 s, and framed one walk-in take as full body → medium → close-up.
const PLAZA = {
  look: 'phone', setting: 'a sunlit cobblestone plaza in front of a grand stone building with columns, daytime',
  outfit: { top_name: 'a black short-sleeve knit shirt with a camp collar', top_front_short: 'plain black knit, open collar', bottom: 'black wide-leg trousers', shoes: 'black leather shoes', accessories: 'wristwatch, dark sunglasses (carried then worn)' },
  props: ['dark sunglasses folded in MAIN\'s right hand'],
  shots: [
    { start: 0, size: 'full body', angle: 'eye level', camera: { move: 'fixed' }, garment_side: 'front', main_events: ['walks toward the camera from the building entrance', 'brings right hand to chin', 'lowers hand briefly', 'looks to screen-right', 'turns head forward again'] },
    { start: 1.5, size: 'full body', angle: 'eye level', camera: { move: 'fixed' }, garment_side: 'front', main_events: ['continues walking forward', 'holds sunglasses in one hand', 'glances down at the sunglasses'] },
    { start: 2.1, cut_before: true, size: 'full body', angle: 'eye level', camera: { move: 'fixed' }, garment_side: 'front', main_events: ['puts sunglasses on with both hands', 'keeps walking forward', 'smiles and looks toward screen-right'] },
    { start: 4.1, cut_before: true, size: 'medium', angle: 'eye level', camera: { move: 'fixed' }, garment_side: 'front', end_state: 'MAIN looking to screen-right, expression serious',
      main_events: ['stands in place smiling, looking toward screen-right', 'turns head slightly forward', 'continues smiling', 'smiles broadly toward screen-right', 'adjusts posture slightly', 'keeps smiling at the camera', 'continues smiling, looking just off camera', 'slightly tilts head', 'smiles and raises the right hand toward the sunglasses', 'takes the sunglasses off with the right hand', 'smiles again, lowering the hand', 'points finger toward camera', 'tilts head slightly to the side', 'continues smiling, mouth open as if laughing', 'turns head to look toward screen-right', 'narrows eyes slightly, expression becomes more serious'] },
    { start: 9, size: 'close-up', angle: 'eye level', camera: { move: 'fixed' }, garment_side: 'front', main_events: ['keeps looking toward screen-right', 'turns shoulder away from camera', 'moves out of frame'] },
  ],
};
const plaza = () => compile(PLAZA, { name: 'Kryfex', gender: 'male', cuts: [2.1], camera: [], durationSec: 10.1, model: 'wan' });
t('plaza: only the MEASURED cut opens a new Shot; the writer\'s extra cut at 4.1 s is dropped and logged', () => {
  const r = plaza();
  assert.deepStrictEqual((r.prompt.match(/^Shot \d+ \[[^\]]+\]:/gm) || []), ['Shot 1 [0-2.1s]:', 'Shot 2 [2.1-10.1s]:'], r.prompt);
  assert.strictEqual((r.prompt.match(/Hard cut\./g) || []).length, 1, r.prompt);
  assert.ok(/End of the shot:[^\n]*Hard cut\.\n|Hard cut\.\nShot 2/.test(r.prompt) || /Hard cut\.\nShot 2/.test(r.prompt), r.prompt);
  assert.ok(r.log.some(l => l.rule === 'measuredCuts' && l.dropped === 4.1));
  assert.ok(!/Seamlessly/.test(r.prompt));
  assert.deepStrictEqual(r.segments.map(s => s.cut_before), [false, false, true, false, false]);
});
t('plaza: inside the take the framing tightens, it is never a new size with a held camera (framingInTake)', () => {
  const r = plaza();
  assert.ok(/^\[4\.1-9s\] Kryfex has come closer: within the same take the framing is now a medium shot, the camera still does not move\./m.test(r.prompt), r.prompt);
  assert.ok(/^\[9-10\.1s\] Kryfex has come closer: within the same take the framing is now a close-up, the camera still does not move\./m.test(r.prompt), r.prompt);
  assert.strictEqual((r.prompt.match(/the camera does not move/g) || []).length, 2, 'once per take, at its start: ' + r.prompt);
  // an unchanged framing inside a take is not repeated
  assert.ok(/^\[1\.5-2\.1s\] Kryfex /m.test(r.prompt), r.prompt);
});
t('plaza: the sunglasses are placed in the hook, the hook keeps every movement (propsPlaced, hookFirst)', () => {
  const r = plaza();
  const hook = r.prompt.split('\n').find(l => l.startsWith('[0-1.5s]'));
  assert.ok(/At the start: dark sunglasses folded in Kryfex's right hand\./.test(hook), hook);
  assert.ok(/walks toward the camera from the building entrance, then brings right hand to chin, then lowers hand briefly, then looks to screen-right, then turns head forward again/.test(hook), hook);
  assert.strictEqual((r.prompt.match(/At the start:/g) || []).length, 1);
});
t('a prop written as an object prints its words, never [object Object] (propsPlaced, 2026-10-31)', () => {
  const r = compile({ ...PLAZA, props: [{ name: 'a black holdall', location_first_frame: 'on the chair beside MAIN' }, { foo: 1 }] }, { name: 'Kryfex', gender: 'male', cuts: [2.1], camera: [], durationSec: 10.1, model: 'wan' });
  assert.ok(!/object Object/.test(r.prompt), r.prompt);
  assert.ok(/At the start: a black holdall, on the chair beside Kryfex\./.test(r.prompt), r.prompt.split('\n').find(l => l.startsWith('[0-')));
});
t('plaza: the crowded phase sheds filler and micro-moves, keeps the object actions and the last action (fewerActions)', () => {
  const r = plaza();
  const l = r.prompt.split('\n').find(x => x.startsWith('[4.1-9s]'));
  const n = (l.match(/, then /g) || []).length + 1;
  assert.ok(n <= Math.ceil(4.9 * 1.5), `${n} actions: ${l}`);
  assert.ok(/takes the sunglasses off with the right hand/.test(l) && /raises the right hand toward the sunglasses/.test(l), l);
  assert.ok(/narrows eyes slightly, expression becomes more serious\./.test(l), 'the last action stays: ' + l);
  assert.ok(!/continues smiling|keeps smiling|adjusts posture slightly/.test(l), l);
  assert.ok(/puts sunglasses on with both hands/.test(r.prompt), 'the put-on is never trimmed');
  assert.ok(r.log.some(x => x.rule === 'fewerActions' && x.from === 16));
});
t('fewerActions never touches the hook, nor a phase that is already sparse', () => {
  const ev = ['a', 'continues a', 'continues b', 'slightly c', 'd', 'continues e', 'f'];
  const spec = { outfit: {}, shots: [{ start: 0, main_events: ev }, { start: 2, main_events: ['walks', 'continues walking'] }] };
  const r = compile(spec, { name: 'K', cuts: [], durationSec: 6, model: 'wan' });
  assert.ok(r.prompt.includes('K a, then continues a, then continues b, then slightly c, then d, then continues e, then f.'), r.prompt);
  assert.ok(r.prompt.includes('K walks, then continues walking.'), r.prompt);
});
t('measuredCuts: a writer cut up to 1.2 s off a measured cut is snapped, not lost', () => {
  const spec = { outfit: {}, shots: [{ start: 0, main_events: ['a'] }, { start: 3, cut_before: true, main_events: ['b'] }] };
  const r = compile(spec, { name: 'K', cuts: [3.9], durationSec: 7, model: 'wan' });
  assert.deepStrictEqual(r.segments.map(s => [s.start, s.cut_before]), [[0, false], [3.9, true]]);
  assert.ok(/^Shot 2 \[3\.9-7s\]: /m.test(r.prompt), r.prompt);
  // …but a PHASE (no writer cut) is never turned into a cut by the wider window
  const spec2 = { outfit: {}, shots: [{ start: 0, main_events: ['a'] }, { start: 3, main_events: ['b'] }] };
  const r2 = compile(spec2, { name: 'K', cuts: [3.9], durationSec: 7, model: 'wan' });
  assert.ok(r2.log.some(l => l.missing === 3.9), JSON.stringify(r2.log));
});
t('seedance: a take of phases keeps whole seconds on both the Shot header and the phase lines', () => {
  const r = compile(PLAZA, { name: 'Kryfex', cuts: [2.1], camera: [], durationSec: 10.1, model: 'seedance' });
  assert.ok(/^Shot 1 \[0-2s\]: /m.test(r.prompt) && !/\[2-3s\]/.test(r.prompt) && /^Shot 2 \[2-10s\]:$/m.test(r.prompt) && /^\[4-9s\] /m.test(r.prompt), r.prompt);
  // contiguous: every line starts where the one before ended (reviewer 2026-10-30: [0-3s] then [2-10s])
  const phases = [...r.prompt.matchAll(/^\[(\d+)-(\d+)s\]/gm)].map(m => [+m[1], +m[2]]);
  phases.forEach((x, i) => { assert.ok(x[1] > x[0], 'no empty phase ' + x); if (i) assert.strictEqual(x[0], phases[i - 1][1], 'contiguous ' + JSON.stringify(phases)); });
});

t('fewerActions stops AT the cap, one action at a time, earliest first (reviewer 2026-10-30)', () => {
  const ev = ['looks at camera', 'shrugs slightly', 'raises an eyebrow slightly', 'tilts head slightly', 'winks slightly', 'continues looking', 'gives a slight nod'];
  const spec = { outfit: {}, shots: [{ start: 0, main_events: ['h'] }, { start: 1, main_events: ev }] };
  const r = compile(spec, { name: 'K', cuts: [], durationSec: 3, model: 'wan' });
  const l = r.prompt.split('\n').find(x => x.startsWith('[1-3s]'));
  assert.strictEqual((l.match(/, then /g) || []).length + 1, 3, l);
  assert.ok(/winks slightly, then gives a slight nod/.test(l), 'the later reactions stay: ' + l);
});
t('an ongoing movement is never filler: "continues walking" stays (P10, reviewer 2026-10-30)', () => {
  const ev = ['continues walking toward the camera', 'continues smiling', 'keeps smiling', 'smiles', 'looks right', 'looks left', 'nods'];
  const spec = { outfit: {}, shots: [{ start: 0, main_events: ['h'] }, { start: 1.5, main_events: ev }] };
  const r = compile(spec, { name: 'K', cuts: [], durationSec: 3.5, model: 'wan' });
  assert.ok(/K continues walking toward the camera, then/.test(r.prompt), r.prompt);
  assert.ok(!/continues smiling/.test(r.prompt), r.prompt);
});
t('framingInTake: a moving camera says how; an unknown size says "moves", never tightens/widens', () => {
  const spec = { outfit: {}, shots: [{ start: 0, size: 'close-up', camera: { move: 'fixed' }, main_events: ['a'] }, { start: 2, size: 'medium', camera: { move: 'pulls back' }, main_events: ['b'] }, { start: 4, size: 'cowboy shot', camera: { move: 'fixed' }, main_events: ['c'] }] };
  const r = compile(spec, { name: 'K', cuts: [], durationSec: 6, model: 'wan' });
  assert.ok(/^\[2-4s\] Within the same take the framing widens to a medium shot, the camera pulls back\./m.test(r.prompt), r.prompt);
  assert.ok(/^\[4-6s\] Within the same take the framing is now a cowboy shot, the camera still does not move\./m.test(r.prompt), r.prompt);
});

// ── writer contract ──
t('writer system carries every WRITER_RULE and the persona pronouns', () => {
  const s = writerSystem({ personaGender: 'male' });
  assert.ok(/he\/him/.test(s) && /VIEWER'S SCREEN/.test(s) && /ONE garment/.test(s) && /Never describe MAIN's face/.test(s) && /cannot be determined/.test(s));
  assert.ok(/they\/them/.test(writerSystem({ personaGender: null })), 'unknown gender → they/them, never a default');
  assert.ok(Object.keys(WRITER_RULES).length >= 7);
  assert.ok(/"bare_skin":\[\]/.test(writerSystem({})) && /a tank top = \["arms","shoulders"\]/.test(writerSystem({})), 'bare_skin is asked for, with the tank-top example');
  // 🎯 2026-10-13: Dorzy was swapped onto the foreground man; MAIN was the tiny grandmother at the back.
  const ws = writerSystem({});
  // 2026-10-16: "obscured" added (behind glass, reflection, silhouette …) — such an opening gets no first frame by default.
  assert.ok(/"opening":\{"main_in_first_frame":"clear\|small\|obscured\|absent","main_where":""\}/.test(ws), 'the spec asks where MAIN is in the first frame');
  assert.ok(/Decide who MAIN is from the WHOLE video first: the person filling the opening is often a bystander\./.test(ws), 'MAIN is decided from the whole video, not the opening');
  assert.ok(WRITER_RULES.openingWhere, 'recorded in the rules list');
  // 2026-10-30 (VQL 2026-10-30-01): props placed at the start, later shots list only changes.
  assert.ok(/"bare_skin":\[\]\},"props":\[\],"cast"/.test(ws), 'the spec asks for props');
  assert.ok(/where it is in the VERY FIRST frame/.test(ws) && /never write "continues …", "keeps …" or "still …"/.test(ws), 'props + changes-only rules reach the writer');
  assert.ok(WRITER_RULES.changesOnly && WRITER_RULES.propsAtStart);
  const parsed = parseSpec(JSON.stringify({ outfit: {}, opening: { main_in_first_frame: 'small', main_where: 'seated at a table at the back' }, shots: [{ start: 0, main_events: [] }] }));
  assert.strictEqual(parsed.opening.main_where, 'seated at a table at the back', 'the field survives parsing');
});
t('parseSpec survives code fences; validateSpec catches a missing shot list', () => {
  assert.deepStrictEqual(parseSpec('```json\n{"a":1}\n```'), { a: 1 });
  assert.ok(validateSpec({ outfit: {} }).includes('shots missing'));
  assert.deepStrictEqual(validateSpec(LOBBY), []);
});

t('a camera direction with brackets in it never throws (it used to fail the whole paid run with a 500)', () => {
  const { cameraSentence } = require('../v2/compile');
  for (const d of ['left)', '(screen left', '[up', 'right*'])
    assert.doesNotThrow(() => cameraSentence({ move: 'pans', direction: d }, null, [], 1), d);
  assert.strictEqual(cameraSentence({ move: 'pans', direction: 'left' }, null, [], 1), 'the camera pans left');
});

// 📦 PRODUCT ONLY (2026-10-22): the product's own line per shot — and nothing changes for any other recreate.
const NOBODY = {
  look: 'cinema', setting: 'a dark studio', outfit: { top_name: 'a grey hoodie' },
  cast: [{ id: 'P1', label: 'the stagehand in black', look: 'short hair' }], people_move: true,
  shots: [
    { start: 0, size: 'wide', camera: { move: 'fixed' }, main_visible: false, main_events: [], product_events: ['rolls up the curved wall', 'tips over the top edge'], end_state: 'it is in the air' },
    { start: 4, cut_before: true, size: 'medium', camera: { move: 'fixed' }, main_visible: false, main_events: [], product_events: ['comes down onto the floor'], end_state: 'it stands still' },
  ],
};
t('productOnly OFF: product_events are ignored and the output is unchanged', () => {
  const plain = { ...NOBODY, shots: NOBODY.shots.map(({ product_events, ...x }) => x) };
  const a = compile(NOBODY, { name: '', cuts: [4], durationSec: 8 }).prompt, b2 = compile(plain, { name: '', cuts: [4], durationSec: 8 }).prompt;
  assert.strictEqual(a, b2);
  assert.ok(/is not in this shot/.test(a), 'a normal compile still says the main person is not in the shot');
  assert.strictEqual(compile(LOBBY, base).prompt, compile(LOBBY, { ...base, productOnly: false, productName: 'X' }).prompt, 'the person path must not change');
});
t('productOnly ON: each shot gets the product line, no outfit for a person who is not there, no "not in this shot"', () => {
  const out = compile(NOBODY, { name: '', cuts: [4], durationSec: 8, productOnly: true, productName: 'Stane-Desk-Oak' }).prompt;
  assert.ok(/Shot 1 \[[^\]]+\]:[^\n]*Stane-Desk-Oak rolls up the curved wall, then tips over the top edge\./.test(out), out);
  assert.ok(/Shot 2 \[[^\]]+\]:[^\n]*Stane-Desk-Oak comes down onto the floor\./.test(out), out);
  assert.ok(!/is not in this shot/.test(out), 'no "not in this shot" line');
  assert.ok(!/wears a grey hoodie/.test(out), 'no outfit line when nobody is in the video');
  assert.ok(/The people in the video keep moving naturally/.test(out) && !/people around/.test(out), 'the cast line names no main person');
});
t('productOnly ON with a visible person: the person keeps their line and outfit, the product gets its own', () => {
  const withPerson = { ...NOBODY, shots: [{ ...NOBODY.shots[0], main_visible: true, main_events: ['pushes it toward the wall'] }, NOBODY.shots[1]] };
  const out = compile(withPerson, { name: '', cuts: [4], durationSec: 8, productOnly: true, productName: 'Stane-Desk-Oak' }).prompt;
  assert.ok(/the main person pushes it toward the wall/i.test(out) && /wears a grey hoodie/.test(out), out);
  assert.ok(/Stane-Desk-Oak rolls up the curved wall/.test(out), out);
});

t('outfitEachTake: after a hard cut the take restates the bottom and shoes (VQL 2026-11-03-01)', () => {
  const r = plaza();
  const s2 = r.prompt.split(/^Shot 2 /m)[1] || '';
  assert.ok(/Kryfex wears black wide-leg trousers, black leather shoes\./.test(s2), 'Shot 2 must restate bottom + shoes: ' + s2);
  assert.ok(!/Kryfex wears a black short-sleeve knit shirt/.test(s2), 'the top is not repeated when the line already names its front');
  const s1 = r.prompt.split(/^Shot 2 /m)[0].split(/^Shot 1 /m)[1] || '';
  assert.ok(!/Kryfex wears/.test(s1), 'take 1 sits under the outfit sentence: no restate');
});
t('outfitEachTake: a take without a garment line names the top too; garment-set tops pointing at images are left out', () => {
  const { takeWear } = require('../v2/compile');
  assert.strictEqual(takeWear({ top_name: 'a leopard print top', bottom: 'a black mini skirt', shoes: 'knee-high black boots' }, false, false), 'a leopard print top, a black mini skirt, knee-high black boots');
  assert.strictEqual(takeWear({ top_name: 'the Hoodie from the garment images, exactly as photographed', bottom: 'jeans' }, false, false), 'jeans');
  assert.strictEqual(takeWear({ top_name: 'no top', bottom: 'swim shorts', shoes: 'none' }, false, true), 'swim shorts');
  assert.strictEqual(takeWear({ top_name: 'a tee', bottom: 'jeans, tattooed calves' }, true, false), 'jeans', 'identity words stripped (identityFromRefs)');
});
t('outfitEachTake: a shot without MAIN after the cut gets no outfit line', () => {
  const spec = { ...PLAZA, shots: [PLAZA.shots[0], { ...PLAZA.shots[2], main_visible: false }] };
  const r = compile(spec, { name: 'Kryfex', cuts: [2.1], camera: [], durationSec: 6, model: 'wan' });
  assert.ok(!/^Shot 2 .*Kryfex wears/m.test(r.prompt), r.prompt);
});

t('sheer fabric is not bare skin: the writer is told so (VQL 2026-11-03-02)', () => {
  assert.ok(/Skin seen through sheer, mesh, lace or fishnet fabric is NOT bare/.test(writerSystem({})));
});
t('garmentSide: a back shot names the top\'s back even when the source never showed it; no top = nothing (VQL 2026-11-03-02)', () => {
  const { garmentClause } = require('../v2/compile');
  assert.strictEqual(garmentClause('back', { top_name: 'a sports bra', top_back: 'not shown' }, 'Leilaa'), "the back of Leilaa's sports bra faces the camera");
  assert.strictEqual(garmentClause('back', { top_name: 'not shown' }, 'Leilaa'), '');
  assert.strictEqual(garmentClause('front', { top_name: 'a sports bra' }, 'Leilaa'), '', 'a front shot without front text stays silent');
  for (const tn of ['shirtless', 'no top', 'nothing', '-', 'topless', 'bare chest', 'no shirt', 'none'])
    assert.strictEqual(garmentClause('back', { top_name: tn, top_back: 'not shown' }, 'Kryfex'), '', 'a no-top name must not become a top: ' + tn);
  assert.strictEqual(garmentClause('back', { top_name: "Leilaa's own signature outfit, exactly as in the reference images" }, 'Leilaa'), '', 'own outfit points at images');
  assert.strictEqual(garmentClause('back', { top_name: 'the complete Dorzy-BlackSuit outfit from the outfit images, exactly as photographed — every garment, the shoes and the accessories' }, 'Dorzy'), '', 'complete outfit sentence');
});

const { normalizeOutfit: normalizeOutfitT } = require('../v2/spec');
// 🧥 RULE layeredOutfit (VQL 2026-11-05-01) — the red-carpet spec as the writer wrote it: the jacket only in top_front,
// "chest" in bare_skin, close-ups after hard cuts that came back shirtless.
const RED = () => ({
  look: 'phone', setting: 'outdoor red carpet event at a film festival, overcast early evening light',
  outfit: { top_name: 'an olive-green crew-neck T-shirt', top_front: 'plain olive-green crew-neck T-shirt, no visible graphics, worn under an open dark brown leather biker jacket', top_front_short: 'plain olive-green, no graphics', top_back: 'not shown', bottom: 'black slim-fit jeans', shoes: 'cannot be determined', accessories: 'a thin gold chain necklace', bare_skin: ['chest'] },
  shots: [
    { start: 0, size: 'medium', camera: { move: 'pans', direction: 'right' }, garment_side: 'front', main_events: ['walks forward along the red carpet'] },
    { start: 5.7, cut_before: true, size: 'close-up', camera: { move: 'fixed' }, garment_side: 'front', main_events: ['looks toward screen-left'] },
    { start: 6.7, cut_before: true, size: 'close-up', camera: { move: 'fixed' }, garment_side: 'side', main_events: ['turns the head further left'] },
    { start: 8.1, cut_before: true, size: 'full body', camera: { move: 'fixed' }, garment_side: 'back', main_events: ['walks up the stairs'] },
  ],
});
t('layeredOutfit: a jacket left in top_front becomes outer_layer; a covered chest leaves bare_skin; idempotent', () => {
  const { normalizeOutfit } = require('../v2/spec');
  const o = normalizeOutfit(RED().outfit);
  assert.strictEqual(o.outer_layer, 'an open dark brown leather biker jacket');
  assert.deepStrictEqual(o.bare_skin, [], 'a crew-neck tee under an open jacket is not a bare chest');
  assert.deepStrictEqual(normalizeOutfit(o), o, 'idempotent');
  assert.ok(/worn under an open dark brown leather biker jacket/.test(o.top_front), 'the layer stays in top_front for the tool');
});
t('layeredOutfit: an open shirt / deep V / no layer keeps the chest; a written outer_layer lands in top_front', () => {
  const { normalizeOutfit } = require('../v2/spec');
  assert.deepStrictEqual(normalizeOutfit({ top_name: 'a white linen shirt', top_front: 'unbuttoned to the sternum', bare_skin: ['chest'] }).bare_skin, ['chest'], 'not a closed top');
  assert.deepStrictEqual(normalizeOutfit({ top_name: 'a black V-neck T-shirt', top_front: 'plain black', bare_skin: ['chest'] }).bare_skin, ['chest'], 'V-neck');
  assert.deepStrictEqual(normalizeOutfit({ top_name: 'a white T-shirt', top_front: 'deep scoop neck, plain white', bare_skin: ['chest', 'arms'] }).bare_skin, ['chest', 'arms'], 'scoop');
  assert.deepStrictEqual(normalizeOutfit({ top_name: 'no top', top_front: 'bare chest', bare_skin: ['chest'], outer_layer: 'an open black blazer' }).bare_skin, ['chest'], 'shirtless under a blazer');
  const w = normalizeOutfit({ outer_layer: 'a closed navy bomber jacket', top_name: 'a white T-shirt', top_front: 'plain white', bare_skin: ['chest'] });
  assert.ok(/plain white, worn under a closed navy bomber jacket/.test(w.top_front), w.top_front);
  assert.deepStrictEqual(w.bare_skin, []);
  assert.strictEqual(normalizeOutfit({ top_name: 'a hoodie', top_front: 'grey', outer_layer: 'none' }).outer_layer, '');
  { const lo = { outer_layer: 'an open dark-brown leather biker jacket with wide lapels and zip pockets', top_name: 'an olive-green crew-neck T-shirt', top_front: 'plain olive-green, no visible graphics', bare_skin: [] };
    const first = compile({ outfit: lo, shots: [{ start: 0, size: 'medium', garment_side: 'front', main_events: ['walks'] }] }, { name: 'Kryfex', durationSec: 5 }).prompt.split('\n')[0];
    assert.ok(/\(front: plain olive-green, no visible graphics\)/.test(first), 'no tail of the layer on the tee: ' + first); }
  const rerun = normalizeOutfit({ outer_layer: 'an open dark-brown leather biker jacket with wide lapels and zip pockets', top_name: 'an olive-brown fitted T-shirt', top_front: 'plain olive-brown, no visible graphics, worn open under the leather jacket with wide lapels and zip pockets', bare_skin: ['chest'] });
  assert.deepStrictEqual(rerun.bare_skin, [], 'the red-carpet re-run spec: "worn open under the leather jacket" is about the jacket');
  assert.deepStrictEqual(normalizeOutfit({ top_name: 'a zip-up hoodie', top_front: 'unzipped halfway', bare_skin: ['chest'] }).bare_skin, ['chest'], 'open zip keeps the chest (R6)');
  assert.strictEqual(normalizeOutfit({ top_name: 'a black tee', top_front: 'logo half hidden under the jacket strap' }).outer_layer, '', 'a garment part is not a layer');
  assert.strictEqual(normalizeOutfit({ top_name: 'a black tee', top_front: 'plain, under a denim jacket strap' }).outer_layer, '', 'a/an + strap is not a layer either');
  assert.strictEqual(parseSpec(JSON.stringify(RED())).outfit.outer_layer, 'an open dark brown leather biker jacket', 'parseSpec normalizes every written spec');
});
t('layeredOutfit: every take after a cut names the jacket over the tee; a back shot names the jacket\'s back; no layer = no change', () => {
  const r = compile(RED(), { ...base, cuts: [5.7, 6.7, 8.1], camera: [], durationSec: 15 });
  const p = r.prompt;
  assert.ok(/Kryfex wears an open dark brown leather biker jacket over an olive-green crew-neck T-shirt \(front: plain olive-green crew-neck T-shirt, no visible graphics\)/.test(p), p.split('\n')[0]);
  for (const n of [2, 3]) {
    const seg = p.split(new RegExp(`^Shot ${n} `, 'm'))[1].split(/^Shot \d/m)[0];
    assert.ok(/Kryfex wears an open dark brown leather biker jacket over an olive-green crew-neck T-shirt that covers the chest, black slim-fit jeans\./.test(seg), `Shot ${n}: ` + seg);
  }
  const s4 = p.split(/^Shot 4 /m)[1];
  assert.ok(/the back of Kryfex's open dark brown leather biker jacket faces the camera/i.test(s4), s4);
  assert.ok(r.log.some(l => l.rule === 'layeredOutfit'));
  const plain = RED(); plain.outfit.top_front = 'plain olive-green crew-neck T-shirt'; plain.outfit.bare_skin = [];
  const q = compile(plain, { ...base, cuts: [5.7, 6.7, 8.1], camera: [], durationSec: 15 }).prompt;
  assert.ok(!/jacket|covers the chest/.test(q), 'no layer = 0 words');
});
t('layeredOutfit: a swapped-in garment set drops the source jacket', () => {
  for (const top_name of ['the Hoodie from the garment images, exactly as photographed', 'the complete Dorzy-BlackSuit outfit from the outfit images, exactly as photographed — every garment, the shoes and the accessories']) {
    const sp = RED(); sp.outfit = { ...normalizeOutfitT(sp.outfit), top_front: '', top_back: '', top_front_short: '', top_back_short: '', top_name };   // the tool's rlGarmentOutfit shape
    const out = compile(sp, { ...base, cuts: [5.7, 6.7, 8.1], camera: [], durationSec: 15 }).prompt;
    assert.ok(!/jacket|worn under|covers the chest/.test(out), out.split('\n')[0]);
  }
  const { takeWear } = require('../v2/compile');
  assert.strictEqual(takeWear({ outer_layer: 'an open leather jacket', top_name: 'the Hoodie from the garment images, exactly as photographed', bottom: 'jeans' }, false, false), 'jeans');
});

// RULE overCap (2026-11-10, VQL 2026-11-10-01) — shaped like the real 67 s one-take Maybach analysis: one long take,
// no measured cuts, phases with and without MAIN, the last one the ending.
const MAYBACH = {
  look: 'phone', setting: 'inside a parked luxury car in a bright showroom',
  outfit: { top_name: 'a long black coat over a black roll-neck', bottom: 'black trousers', shoes: 'black pumps' },
  shots: [
    { start: 0, size: 'full body', camera: { move: 'pushes in' }, main_events: ['climbs into the back seat', 'sits down'] , end_state: 'seated in the back seat' },
    { start: 2.6, size: 'medium shot', main_events: ['crosses the legs', 'raises the right hand to the chin'] },
    { start: 6.6, size: 'medium shot', main_events: ['leans back'] },
    { start: 9.6, size: 'medium close-up', main_events: ['presses the console buttons', 'presses the door buttons', 'looks down'] },
    { start: 16.6, size: 'close-up', main_events: ['sits back'] },
    { start: 18.6, size: 'wide', main_visible: false, main_events: [], background: 'empty opposite seats' },
    { start: 24.6, size: 'wide', main_visible: false, main_events: [] },
    { start: 26.6, size: 'medium shot', main_events: ['reclines', 'stretches the legs out onto the opposite seat'] },
    { start: 33.6, size: 'medium shot', main_events: ['sits up'] },
    { start: 36.6, size: 'medium close-up', main_events: ['picks up the folded tray table', 'unfolds the tray table', 'lowers it over the lap'] },
    { start: 45.6, size: 'wide', main_visible: false, main_events: [] },
    { start: 53.6, size: 'close-up', main_visible: false, main_events: [] },
    { start: 61.6, size: 'medium close-up', main_events: ['rests the hand on the tray table', 'looks toward the camera'], end_state: 'facing the camera, hand on the tray table' },
  ],
};
const LONG = { name: 'Dorzy', gender: 'female', cuts: [], camera: [{ from: 0, to: 2.6, zoom: 'in' }, { from: 2.6, to: 67 }], durationSec: 67.4 };
t('overCap: a 67 s one-take source becomes 30 s of Shots with hard cuts, never "single shot"', () => {
  const r = compile(MAYBACH, { ...LONG, model: 'wan' });
  assert.ok(/, 30 seconds,/.test(r.prompt), r.prompt.slice(0, 200));
  assert.ok(!/67 seconds|65 seconds/.test(r.prompt));
  assert.ok(!/Generate single shot/.test(r.prompt), 'single shot must go');
  const heads = r.prompt.match(/^Shot \d+ \[/gm) || [];
  assert.ok(heads.length >= 4 && heads.length <= 6, r.prompt);
  assert.strictEqual(r.segments[r.segments.length - 1].end, 30);
  assert.ok(r.segments.filter(s => s.cut_before).length >= 3, JSON.stringify(r.segments));
  assert.strictEqual(r.durationSec, 30); assert.strictEqual(r.sourceSecs, 67.4);
  assert.ok(r.log.some(l => l.rule === 'overCap'));
  // every [a-bs] time inside 0..30
  for (const m of r.prompt.matchAll(/\[(\d+(?:\.\d)?)-(\d+(?:\.\d)?)s\]/g)) assert.ok(+m[2] <= 30 && +m[1] < +m[2], m[0]);
});
t('overCap: the hook is kept as the source has it, the last phase (the ending) is always kept', () => {
  const r = compile(MAYBACH, { ...LONG, model: 'wan' });
  assert.deepStrictEqual([r.segments[0].srcStart, r.segments[0].start, r.segments[0].end], [0, 0, 2.6]);
  assert.strictEqual(r.segments[r.segments.length - 1].srcStart, 61.6);
  assert.ok(/Shot 1 \[0-2\.6s\]: Full body/.test(r.prompt), r.prompt);
  assert.ok(/looks toward the camera/.test(r.prompt) && /End of the shot: facing the camera/.test(r.prompt));
});
t('overCap: a part where Dorzy is visible beats an empty-car phase in the same part', () => {
  // The empty-car phase carries more listed actions (the writer sometimes lists the camera's own moves) — visibility still wins.
  const spec = { ...MAYBACH, shots: MAYBACH.shots.map(x => x.start === 18.6 ? { ...x, main_events: ['a', 'b', 'c', 'd', 'e'] } : x) };
  const r = compile(spec, { ...LONG, model: 'wan' });
  const srcs = r.segments.map(s => s.srcStart);
  assert.ok(srcs.includes(26.6) && !srcs.includes(18.6), JSON.stringify(srcs));   // reclining beats the empty seats at 18.6/24.6
  assert.ok(!srcs.includes(45.6) && !srcs.includes(53.6), JSON.stringify(srcs));
});
t('overCap: the measured camera is read at the SOURCE time of the kept phase', () => {
  // The camera turns left only while she reclines (source 26.6-33.6); that phase now plays earlier in the render.
  const cam = [{ from: 0, to: 2.6, zoom: 'in' }, { from: 2.6, to: 26.6 }, { from: 26.6, to: 33.6, pan: 'left' }, { from: 33.6, to: 67 }];
  const r = compile(MAYBACH, { ...LONG, camera: cam, model: 'wan' });
  assert.ok(/Shot 1 \[0-2\.6s\]: Full body, the camera pushes in/.test(r.prompt), r.prompt.split('\n').find(l => l.startsWith('Shot 1')));
  const s3 = r.prompt.split('\n').find(l => /^Shot \d+/.test(l) && /reclines/.test(l));
  assert.ok(/left/.test(s3) && !/fixed shot/.test(s3), s3);
});
t('overCap: Seedance gets whole seconds on 30 s too', () => {
  const r = compile(MAYBACH, { ...LONG, model: 'seedance' });
  assert.ok(/, 30 seconds,/.test(r.prompt) && !/Generate single shot/.test(r.prompt));
  const n = (r.prompt.match(/^Shot \d+ \[/gm) || []).length; assert.ok(n >= 4 && n <= 6, n);
});
t('overCap: a source within the cap compiles exactly as before (no rule, its own length)', () => {
  const short = { ...LONG, durationSec: 29.9 };
  const spec = { ...MAYBACH, shots: MAYBACH.shots.filter(x => x.start < 27) };
  const r = compile(spec, { ...short, model: 'wan' });
  assert.ok(!r.log.some(l => l.rule === 'overCap') && r.durationSec === undefined);
  assert.ok(/, 30 seconds,/.test(r.prompt) && /Generate single shot/.test(r.prompt));
  const lobby = compile(LOBBY, { ...base, model: 'wan' });
  assert.ok(!lobby.log.some(l => l.rule === 'overCap'));
});
t('overCap: maxSecs from the caller wins (a 15 s ceiling keeps fewer, shorter shots)', () => {
  const r = compile(MAYBACH, { ...LONG, model: 'wan', maxSecs: 15 });
  assert.ok(/, 15 seconds,/.test(r.prompt));
  assert.strictEqual(r.segments[r.segments.length - 1].end, 15);
  assert.ok(r.segments.length >= 2 && r.segments.length <= 3, r.segments.length);
});

t('overCap: no kept phase plays slower than in the source; the hook keeps its exact length', () => {
  for (const sp of [MAYBACH, { ...MAYBACH, shots: [{ ...MAYBACH.shots[0], start: 0 }, { start: 1.3, main_events: ['walks'] }, ...MAYBACH.shots.slice(2)] }]) {
    const r = compile(sp, { ...LONG, model: 'wan' });
    const L = r.log.find(l => l.rule === 'overCap');
    L.kept.forEach(([a, b, d], i) => { if (i < L.kept.length - 1) assert.ok(d <= b - a + 0.051, JSON.stringify(L.kept)); });
    assert.strictEqual(L.kept[0][2], Math.round((L.kept[0][1] - L.kept[0][0]) * 10) / 10);
  }
});
t('overCap: a 1.3 s hook stays 1.3 s (the 09-30 stretch), a 12 s hook is cut at 40% of the render, not squeezed into 6', () => {
  const sp = { ...MAYBACH, shots: [{ ...MAYBACH.shots[0] }, { ...MAYBACH.shots[1], start: 1.3 }, ...MAYBACH.shots.slice(2)] };
  assert.ok(/^Shot 1 \[0-1\.3s\]/m.test(compile(sp, { ...LONG, model: 'wan' }).prompt));
  const lh = { ...MAYBACH, shots: [{ ...MAYBACH.shots[0] }, ...MAYBACH.shots.slice(4)] };   // hook runs 0-16.6
  const r = compile(lh, { ...LONG, model: 'wan' });
  assert.ok(/^Shot 1 \[0-12s\]/m.test(r.prompt), r.prompt.split('\n').find(l => l.startsWith('Shot 1')));
});
t('overCap: uneven phases — a short phase is never padded, spare time goes to more phases', () => {
  const sp = { ...MAYBACH, shots: [{ ...MAYBACH.shots[0], start: 0 }, { start: 3, main_events: ['sits'] }, { start: 7, main_events: ['waves'] }, { start: 9, main_events: ['laughs', 'points'] }, { start: 11, main_events: ['talks', 'nods', 'leans back'] }] };
  const r = compile(sp, { ...LONG, model: 'wan' });
  const L = r.log.find(l => l.rule === 'overCap');
  L.kept.forEach(([a, b, d], i) => { if (i < L.kept.length - 1) assert.ok(d <= b - a + 0.051, JSON.stringify(L.kept)); });
  assert.strictEqual(r.segments[r.segments.length - 1].end, 30);
});
t('overCap: two back-to-back phases stay ONE take, cut short at 30 s — no invented cut', () => {
  const sp = { ...MAYBACH, shots: [{ ...MAYBACH.shots[0] }, { start: 2.6, main_events: ['talks to the camera', 'laughs', 'waves', 'leans in', 'points', 'nods'] }] };
  const r = compile(sp, { ...LONG, model: 'wan' });
  assert.ok(!/^Shot \d/m.test(r.prompt) && /, 30 seconds,/.test(r.prompt), r.prompt);
  assert.strictEqual(r.segments[r.segments.length - 1].end, 30);
  assert.ok(/talks to the camera, then laughs/.test(r.prompt) && !/nods/.test(r.prompt), 'cut short keeps the first actions only');
});
t('overCap: kept phases that follow each other in the source are one take; a cut only where source time is skipped', () => {
  const r = compile(MAYBACH, { ...LONG, model: 'wan' });
  const seg = r.segments;
  seg.forEach((s, i) => { if (i === 0) return; const p = seg[i - 1]; const shortened = (p.srcEnd - p.srcStart) - (p.end - p.start) > 0.15;
    assert.strictEqual(s.cut_before, shortened || Math.abs(s.srcStart - p.srcEnd) > 0.05, JSON.stringify(seg)); });
  // a 30.6 s one-take source is not chopped into back-to-back Shots
  const one = { ...MAYBACH, shots: [{ start: 0, size: 'medium shot', main_events: ['walks in'] }, { start: 10, main_events: ['sits'] }, { start: 20, main_events: ['waves'] }] };
  const o = compile(one, { ...LONG, durationSec: 30.6, model: 'wan' });
  assert.ok(!/Hard cut/.test(o.prompt) && !/^Shot \d/m.test(o.prompt), o.prompt);
});
t('overCap: the ending is not stretched while a kept phase still has source left', () => {
  const sp = { ...MAYBACH, shots: [{ start: 0, size: 'full body', main_events: ['opens the door'] }, { start: 2, main_events: ['sits', 'talks'] }, { start: 50, main_events: ['waves goodbye'], end_state: 'waving' }] };
  const r = compile(sp, { ...LONG, durationSec: 52, model: 'wan' });
  const L = r.log.find(l => l.rule === 'overCap');
  const end = L.kept[L.kept.length - 1];
  assert.ok(end[2] <= end[1] - end[0] + 0.051, JSON.stringify(L.kept));
});
t('overCap: a phase cut short keeps only the actions that fit, and drops its end state', () => {
  const sp = { ...MAYBACH, shots: [{ ...MAYBACH.shots[0] }, { start: 2.6, main_events: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], end_state: 'later moment' }, { start: 20.6, main_events: ['b1'] }, { start: 40, main_events: ['c1'] }, { start: 60, main_events: ['d1'], end_state: 'the end' }] };
  const r = compile(sp, { ...LONG, model: 'wan' });
  const line = r.prompt.split('\n').find(l => /a1/.test(l));
  assert.ok(line && !/a6/.test(line) && !/later moment/.test(line), line);
});
t('overCap: a person or object only in dropped phases is not named in the header', () => {
  const sp = { ...MAYBACH, props: ['a gold lighter in the left hand'], cast: [{ id: 'P1', label: 'the chauffeur in the grey suit' }],
    shots: MAYBACH.shots.map(x => x.start === 53.6 ? { ...x, others: [{ id: 'P1', events: ['opens the door'] }], main_events: [] } : x) };
  const r = compile(sp, { ...LONG, model: 'wan' });
  assert.ok(!/chauffeur/.test(r.prompt) && !/gold lighter/.test(r.prompt), r.prompt.slice(0, 600));
  const short = compile({ ...sp, shots: sp.shots.filter(x => x.start < 27) }, { ...LONG, durationSec: 29 , model: 'wan' });
  assert.ok(/gold lighter/.test(short.prompt));   // within the cap nothing is filtered
});

t('overCap: excess time comes off a phase a cut already follows, so no new cut appears', () => {
  const sp = { look: 'phone', outfit: { top_name: 'a coat' }, shots: [
    { start: 0, size: 'medium shot', main_events: ['opens the door'] }, { start: 2, main_events: ['a'] }, { start: 9, main_events: ['b'] },
    { start: 16, main_visible: false, main_events: [] }, { start: 20, main_events: ['d'] }, { start: 27, main_events: ['e'] }, { start: 34, main_events: ['f'] }] };
  const r = compile(sp, { name: 'Dorzy', cuts: [], durationSec: 35.5, model: 'wan' });
  const cuts = r.segments.filter(s => s.cut_before);
  assert.strictEqual(cuts.length, 1, JSON.stringify(r.segments));
  assert.strictEqual(cuts[0].srcStart, 20);
});

console.log(`\nv2-compile: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
