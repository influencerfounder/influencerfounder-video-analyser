#!/usr/bin/env node
// 🪝 HOOK GUARD (v2.54.0, 2026-10-01) — the pose check + one revision + the person-tempo scrub.
//
// Two halves: hookGuard.js is required directly (pure functions), and the wiring block is SLICED
// out of index.js and EXECUTED with a stubbed axios — a grep of the source would pass with the
// gate switched off (a-string-in-the-source-is-not-a-test).
const fs = require('fs'), path = require('path'), assert = require('assert');
const g = require('../hookGuard');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

// Real hook-first output shapes (2026-10-01 FIFA retest, [INFLUENCER] restored).
const POSED = '[INFLUENCER] sits in a stadium stand wearing a white jersey. [INFLUENCER] wears this same outfit, fully dressed, in every shot.\n\nMedium shot, eye-level, camera centred directly on [INFLUENCER] who faces the lens straight-on, seated in the stand with a black smartphone resting in both hands across the lap; in the first frame the eyes are already tracking forward with a set, focused expression — behind sits a middle-aged woman with light hair, arms crossed. The camera executes a continuous, gradual push-in.\n\n[0-3s] Medium-to-medium-close, both hands hold the phone in the lap, eyes forward, camera pushing in.\n\n[3-5s] Eyes close fully in a blink, then the gaze lifts back to forward, in the same white jersey.\n\n[5-7s] [INFLUENCER] raises one hand to the face, no new action.';
const MOVING = '[INFLUENCER] sits in a stadium stand. [INFLUENCER] wears this same outfit, fully dressed, in every shot.\n\n[0-3s] [INFLUENCER] turns the head to the right, the eyes drop to the phone and a thumb scrolls the screen; the woman behind crosses her arms.\n\n[3-5s] Gaze lifts back to the lens, in the same white jersey, no new action.';

(async () => {
  // ── hookSegment ─────────────────────────────────────────────────────────────────────────────
  await t('hook ends at the first timed line starting after 0 s', () => assert.ok(g.hookSegment(POSED).endsWith('camera pushing in.\n\n') && !g.hookSegment(POSED).includes('[3-5s]')));
  await t('"Shot 1 [0-1.2s]" … "Shot 2 [1.2-3s]": the hook stops at Shot 2', () => assert.strictEqual(g.hookSegment('Overall. Shot 1 [0-1.2s] A. Shot 2 [1.2-3s] Hard cut transition, B.'), 'Overall. Shot 1 [0-1.2s] A. '));
  await t('a writer that skips the [0-…] line and opens with "[3s-5s]": the hook is everything before it', () => assert.strictEqual(g.hookSegment('Opening shot, he turns. [3s-5s] Later.'), 'Opening shot, he turns. '));
  await t('en dash and spaced times are timed lines too', () => assert.strictEqual(g.hookSegment('Hook. [0–2 s] a. [2 – 4s] b.'), 'Hook. [0–2 s] a. '));
  await t('no timed line at all → the first 700 characters', () => assert.strictEqual(g.hookSegment('x'.repeat(900)).length, 700));

  // ── pose detection ──────────────────────────────────────────────────────────────────────────
  await t('the FIFA plain hook ("faces the lens … phone resting … eyes tracking") is a POSE', () => assert.ok(g.isPosed(g.hookSegment(POSED))));
  await t('a hook that turns the head, drops the eyes and scrolls is NOT a pose', () => assert.ok(!g.isPosed(g.hookSegment(MOVING))));
  await t('another person crossing their arms is not the influencer moving', () => assert.deepStrictEqual(g.hookMoves('the woman behind crosses her arms, the man beside her glances away'), []));
  await t('a camera move is not the influencer moving ("the camera pushes in", "the lens tilts")', () => assert.deepStrictEqual(g.hookMoves('The camera pushes in and then pans left. The lens tilts up.'), []));
  await t('…but a camera TAIL does not hide the influencer\'s own move before it', () => assert.ok(g.hookMoves('[INFLUENCER] gestures with both hands, wrists rolling as the camera pushes in').length >= 2));
  await t('another person as the OBJECT does not hide the move ("gestures toward the other men")', () => assert.ok(g.hookMoves('his right hand lifts to gesture toward the other men, head turning across the circle of men').length >= 2));
  await t('the persona NAME counts as the influencer (stored prompts carry the name, not the placeholder)', () => assert.ok(g.hookMoves('Kryfex turns and glances at the phone', 'Kryfex').length >= 2));
  await t('a plural lead is the other people ("Both shift their weight and glance toward the pitch")', () => assert.deepStrictEqual(g.hookMoves('Both shift their weight and glance toward the pitch throughout the clip. The two spectators nod.'), []));
  await t('one hand move alone is still a pose', () => assert.ok(g.isPosed('[0-3s] [INFLUENCER] lifts the phone. ')));
  await t('walking is whole-body movement — never a pose', () => assert.ok(!g.isPosed('[INFLUENCER] walks forward mid-stride through the lobby. ')));
  await t('"looks focused" is an expression, "looks up" is a move', () => { assert.deepStrictEqual(g.hookMoves('[INFLUENCER] looks focused'), []); assert.ok(g.hookMoves('[INFLUENCER] looks up').length === 1); });

  // ── person-tempo scrub ──────────────────────────────────────────────────────────────────────
  const sc = g.scrubPersonTempo('The camera executes a slow push-in. [INFLUENCER] slowly turns the head, a slow smile spreading. Her gaze lingers on the phone for a beat. Never in slow motion.');
  await t('person tempo words are removed', () => assert.deepStrictEqual(sc.removed, ['slowly', 'slow', 'lingers', 'for a beat']));
  await t('"lingers" becomes "stays" — the sentence keeps a verb', () => assert.ok(sc.text.includes('Her gaze stays on the phone.')));
  await t('the sentence reads cleanly after the deletion', () => assert.ok(sc.text.includes('[INFLUENCER] turns the head, a smile spreading.')));
  await t('a slow LENS stays ("a slow push-in")', () => assert.ok(sc.text.startsWith('The camera executes a slow push-in.')));
  await t('a negated sentence stays ("Never in slow motion.")', () => assert.ok(sc.text.endsWith('Never in slow motion.')));
  await t('the FIFA "…bust framing; eyes shift slowly right": the camera noun in the first clause does not shield the second', () => {
    const r = g.scrubPersonTempo('tightening to a bust framing; [INFLUENCER]\'s eyes shift slowly right then settle forward.');
    assert.deepStrictEqual(r.removed, ['slowly']); assert.ok(r.text.includes("eyes shift right then settle"));
  });
  await t('a slow LENS on a PERSON sentence stays ("the camera makes a slow push-in on his face")', () => assert.deepStrictEqual(g.scrubPersonTempo('The camera makes a slow push-in on his face.').removed, []));
  await t('a negated PERSON sentence stays ("he never moves in slow motion")', () => assert.deepStrictEqual(g.scrubPersonTempo('He never moves in slow motion.').removed, []));
  await t('a prompt with no tempo word comes back byte-identical', () => assert.strictEqual(g.scrubPersonTempo(MOVING).text, MOVING));

  // ── acceptRevision ──────────────────────────────────────────────────────────────────────────
  const tail = POSED.slice(g.hookSegment(POSED).length);
  const goodHook = POSED.slice(0, g.hookSegment(POSED).length).replace('both hands hold the phone in the lap, eyes forward', '[INFLUENCER] turns the head right, glances down at the phone and the thumb scrolls');
  await t('a revision with a moving hook and the same tail is accepted', () => assert.ok(g.acceptRevision(POSED, goodHook + tail)));
  await t('a revision that changed the tail is rejected', () => assert.ok(!g.acceptRevision(POSED, goodHook + tail.replace('Eyes close fully', 'He stands up and leaves'))));
  await t('a revision whose hook still does not move is rejected', () => assert.ok(!g.acceptRevision(POSED, POSED)));
  await t('an empty or truncated revision is rejected (Kie can answer 200 with no text)', () => { assert.ok(!g.acceptRevision(POSED, '')); assert.ok(!g.acceptRevision(POSED, goodHook)); });

  // ── the wiring in index.js, executed ────────────────────────────────────────────────────────
  const i = SRC.indexOf('    let hookGuard = null;');
  const j = SRC.indexOf('    const clonePrompt = (promptStyle', i);
  await t('guard block found before clonePrompt', () => assert.ok(i > 0 && j > i));
  const block = SRC.slice(i, j);
  const run = async ({ promptStyle = 'hookfirst', opening = true, prompt = POSED, reply, throws, kie = 'k', leftMs = 200000 }) => {
    const calls = [];
    const axios = { post: async (url, body) => { calls.push({ url, body }); if (throws) throw Object.assign(new Error('boom'), { code: 'ECONNABORTED' }); return { data: { content: [{ type: 'text', text: reply }] } }; } };
    const hookContent = [{ type: 'text', text: 'HOOK WINDOW' }, { type: 'image', source: {} }, { type: 'text', text: 'FULL CLIP — evenly sampled frames' }];
    const fn = new Function('promptStyle', 'isBgSwap', 'influencerInOpening', 'basePrompt', 'hookContent', 'hookGuardLib', 'axios', 'kieApiKey', 'ANTHROPIC_API_KEY', 'CLONE_BUDGET_MS', 'startedAt', 'HOOK_REVISE_MIN_MS', 'console',
      `return (async () => {\n${block}\nreturn { basePrompt, hookGuard };\n})();`);
    const out = await fn(promptStyle, false, opening, prompt, hookContent, g, axios, kie, 'a', leftMs, Date.now(), 45000, { log() {} });
    return { ...out, calls };
  };
  const good = goodHook + tail;
  await t('posed + OPENING: SHOWN → one revision call, accepted', async () => { const r = await run({ reply: good }); assert.strictEqual(r.calls.length, 1); assert.ok(r.hookGuard.posed && r.hookGuard.revised); assert.strictEqual(r.basePrompt, good); });
  await t('the revision call carries the hook frames but NOT the "FULL CLIP" label, and the prompt', async () => { const r = await run({ reply: good }); const c = r.calls[0].body.messages[0].content; assert.strictEqual(c.length, 3); assert.ok(c[1].type === 'image' && /PROMPT:\n/.test(c[2].text) && !c.some(x => /FULL CLIP/.test(x.text || ''))); });
  await t('Kie key → Kie gateway with thinking disabled; no Kie key → Anthropic direct', async () => { const a = await run({ reply: good }); assert.ok(/api\.kie\.ai/.test(a.calls[0].url) && a.calls[0].body.thinking.type === 'disabled'); const b = await run({ reply: good, kie: '' }); assert.ok(/api\.anthropic\.com/.test(b.calls[0].url)); });
  await t('OPENING: ABSENT → no revision (a bodyguard opening has no influencer movement)', async () => { const r = await run({ opening: false, reply: good }); assert.strictEqual(r.calls.length, 0); assert.strictEqual(r.basePrompt, POSED); });
  await t('OPENING unknown → no revision', async () => { const r = await run({ opening: null, reply: good }); assert.strictEqual(r.calls.length, 0); });
  await t('a moving hook → no call at all (trigger-based: costs nothing)', async () => { const r = await run({ prompt: MOVING, reply: good }); assert.strictEqual(r.calls.length, 0); assert.ok(!r.hookGuard.posed); });
  await t('a bad revision is rejected and the original prompt kept', async () => { const r = await run({ reply: 'Sure! Here it is.' }); assert.ok(r.hookGuard.rejected && r.basePrompt === POSED); });
  await t('a failing call keeps the original prompt (never fails the analysis)', async () => { const r = await run({ throws: true }); assert.ok(r.hookGuard.error && r.basePrompt === POSED); });
  await t('no budget left → skipped, no call', async () => { const r = await run({ leftMs: 30000, reply: good }); assert.strictEqual(r.calls.length, 0); assert.strictEqual(r.hookGuard.skipped, 'no_budget'); });
  await t('the tempo scrub runs on the final prompt, after a revision too', async () => { const r = await run({ reply: good.replace('turns the head right', 'slowly turns the head right') }); assert.ok(r.hookGuard.revised && !/slowly turns/.test(r.basePrompt) && r.hookGuard.tempoRemoved.includes('slowly')); });
  await t('every other style: no guard, prompt untouched even with "slowly" in it', async () => { const p = MOVING.replace('turns', 'slowly turns'); const r = await run({ promptStyle: 'realism', prompt: p }); assert.strictEqual(r.hookGuard, null); assert.strictEqual(r.basePrompt, p); });
  await t('hookGuard travels in the response', () => assert.ok(/influencerInOpening,\n\s+hookGuard: hookGuard \|\| undefined,/.test(SRC)));

  console.log(`\n${fail ? 'x FAIL' : 'OK'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
