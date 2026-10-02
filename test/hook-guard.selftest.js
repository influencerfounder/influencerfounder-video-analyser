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
  await t('leg movement counts as movement ("a knee bounces and the leg shifts")', () => assert.ok(g.hookMoves('[INFLUENCER] sits; a knee bounces and the right leg shifts, the foot taps').length >= 2));
  await t('the revision asks for EVERY movement, legs included', () => assert.ok(/EVERY movement \[INFLUENCER\] actually makes across those frames — head, eyes, hands, arms, shoulders, torso, legs, knees and feet/.test(g.reviseHookInstruction('x'))));
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
  const run = async ({ promptStyle = 'hookfirst', opening = true, prompt = POSED, reply, throws, kie = 'k', leftMs = 200000, top = '', motion = null }) => {
    const calls = [];
    const axios = { post: async (url, body) => { calls.push({ url, body }); if (throws) throw Object.assign(new Error('boom'), { code: 'ECONNABORTED' }); return { data: { content: [{ type: 'text', text: reply }] } }; } };
    const hookContent = [{ type: 'text', text: 'HOOK WINDOW' }, { type: 'image', source: {} }, { type: 'text', text: 'FULL CLIP — evenly sampled frames' }];
    const fn = new Function('promptStyle', 'isBgSwap', 'influencerInOpening', 'basePrompt', 'hookContent', 'hookGuardLib', 'axios', 'kieApiKey', 'ANTHROPIC_API_KEY', 'CLONE_BUDGET_MS', 'startedAt', 'HOOK_REVISE_MIN_MS', 'console', 'topGarment', 'hookMotion',
      `return (async () => {\n${block}\nreturn { basePrompt, hookGuard };\n})();`);
    const out = await fn(promptStyle, false, opening, prompt, hookContent, g, axios, kie, 'a', leftMs, Date.now(), 45000, { log() {} }, top, motion);
    return { ...out, calls };
  };
  const good = goodHook + tail;
  const noCrowd = (x) => x.replace(/ Throughout the whole clip, the people around \[INFLUENCER\] keep moving naturally — talking, glancing around, shifting in their seats; nobody is frozen\./, '');
  await t('posed + OPENING: SHOWN → one revision call, accepted', async () => { const r = await run({ reply: good }); assert.strictEqual(r.calls.length, 1); assert.ok(r.hookGuard.posed && r.hookGuard.revised); assert.strictEqual(noCrowd(r.basePrompt), good); });
  await t('the revision call carries the hook frames but NOT the "FULL CLIP" label, and the prompt', async () => { const r = await run({ reply: good }); const c = r.calls[0].body.messages[0].content; assert.strictEqual(c.length, 3); assert.ok(c[1].type === 'image' && /PROMPT:\n/.test(c[2].text) && !c.some(x => /FULL CLIP/.test(x.text || ''))); });
  await t('Kie key → Kie gateway with thinking disabled; no Kie key → Anthropic direct', async () => { const a = await run({ reply: good }); assert.ok(/api\.kie\.ai/.test(a.calls[0].url) && a.calls[0].body.thinking.type === 'disabled'); const b = await run({ reply: good, kie: '' }); assert.ok(/api\.anthropic\.com/.test(b.calls[0].url)); });
  await t('OPENING: ABSENT → no revision (a bodyguard opening has no influencer movement)', async () => { const r = await run({ opening: false, reply: good }); assert.strictEqual(r.calls.length, 0); assert.strictEqual(noCrowd(r.basePrompt), POSED); });
  await t('OPENING unknown → no revision', async () => { const r = await run({ opening: null, reply: good }); assert.strictEqual(r.calls.length, 0); });
  await t('a moving hook → no call at all (trigger-based: costs nothing)', async () => { const r = await run({ prompt: MOVING, reply: good }); assert.strictEqual(r.calls.length, 0); assert.ok(!r.hookGuard.posed); });
  await t('a bad revision is rejected and the original prompt kept', async () => { const r = await run({ reply: 'Sure! Here it is.' }); assert.ok(r.hookGuard.rejected && noCrowd(r.basePrompt) === POSED); });
  await t('a failing call keeps the original prompt (never fails the analysis)', async () => { const r = await run({ throws: true }); assert.ok(r.hookGuard.error && noCrowd(r.basePrompt) === POSED); });
  await t('no budget left → skipped, no call', async () => { const r = await run({ leftMs: 30000, reply: good }); assert.strictEqual(r.calls.length, 0); assert.strictEqual(r.hookGuard.skipped, 'no_budget'); });
  await t('the tempo scrub runs on the final prompt, after a revision too', async () => { const r = await run({ reply: good.replace('turns the head right', 'slowly turns the head right') }); assert.ok(r.hookGuard.revised && !/slowly turns/.test(r.basePrompt) && r.hookGuard.tempoRemoved.includes('slowly')); });
  await t('every other style: no guard, prompt untouched even with "slowly" in it', async () => { const p = MOVING.replace('turns', 'slowly turns'); const r = await run({ promptStyle: 'realism', prompt: p }); assert.strictEqual(r.hookGuard, null); assert.strictEqual(r.basePrompt, p); });
  // ── garment on chest close-ups (v2.56.0) ──────────────────────────────────────────────────
  const CL = 'Overall line, white Real Madrid jersey. [INFLUENCER] wears this same outfit.\n\n[0-3s] [INFLUENCER] in the white jersey turns.\n\n[3-5s] Camera settles into a tight close-up on face and upper chest; eyes cut right.\n\n[5-7s] Fingertips graze the neck tattoo, white jersey collar in frame.\n\n[7-9s] The woman behind uncrosses her arms over her chest.\n\n[9-10s] Eyes settle, no new action.';
  const gc = g.ensureGarmentOnChest(CL, 'a white Real Madrid jersey');
  await t('a chest close-up that names no clothing gets the top', () => assert.ok(gc.text.includes('[3-5s] [INFLUENCER] still wears the white Real Madrid jersey. Camera settles')));
  await t('a chest/neck line that already names clothing is left alone', () => assert.ok(gc.text.includes('[5-7s] Fingertips graze')));
  await t('another person\'s chest is not the influencer\'s', () => assert.ok(gc.text.includes('[7-9s] The woman behind')));
  await t('only one line changed, nothing else touched', () => { assert.strictEqual(gc.added, 1); assert.strictEqual(gc.text.replace('[INFLUENCER] still wears the white Real Madrid jersey. ', ''), CL); });
  await t('a TOP that disagrees with the outfit sentence is NOT inserted (the boxing "white adidas jersey black blazer")', () => {
    const P = 'Kryfex sits ringside wearing a black blazer over a black t-shirt.\n\n[0-3s] Kryfex turns.\n\n[3-5s] Close-up on face and upper chest.';
    const r = g.ensureGarmentOnChest(P, 'white adidas jersey black blazer', 'Kryfex');
    assert.strictEqual(r.added, 0); assert.strictEqual(r.text, P); assert.ok(r.disagreed);
    assert.strictEqual(g.ensureGarmentOnChest(P, 'black blazer', 'Kryfex').added, 1);
  });
  await t('TOP: NONE or no TOP → nothing added (a bare-chested source stays bare)', () => { assert.strictEqual(g.ensureGarmentOnChest(CL, 'NONE').text, CL); assert.strictEqual(g.ensureGarmentOnChest(CL, '').text, CL); });
  await t('the wiring adds the top after the scrub', async () => { const r = await run({ prompt: MOVING.replace('[INFLUENCER] sits in a stadium stand.', '[INFLUENCER] sits in a stadium stand in a white jersey.').replace('[3-5s] Gaze lifts back to the lens, in the same white jersey', '[3-5s] Close-up on face and upper chest'), top: 'white jersey' }); assert.ok(/\[3-5s\] \[INFLUENCER\] still wears the white jersey\. Close-up/.test(r.basePrompt) && r.hookGuard.garmentAdded === 1); });
  await t('the writer is asked for the TOP line (hookfirst only) and it is parsed out of the prompt', () => { assert.ok(/\(promptStyle === 'hookfirst' && !isBgSwap\) \? 'Also output, on its own line directly after the OPENING line, exactly "TOP: "/.test(SRC)); assert.ok(/const m = basePrompt\.match\(\/\^TOP:/.test(SRC)); });
  // ── measured hook motion (v2.59.0) ─────────────────────────────────────────────────────────
  const FIFA = { head: 0.436, middle: 0.528, bottom: 1.657, seconds: 1.5 }, WALK = { head: 1.782, middle: 3.012, bottom: 3.39, seconds: 1.5 };
  await t('the FIFA knee bounce (bottom 3.8x the head) produces a note naming legs/knees', () => { const n = g.motionNote(FIFA); assert.ok(/BOTTOM quarter of the frame moves 3\.8x more than the head/.test(n) && /legs, knees or lap/.test(n)); });
  await t('a walk moves every band — no note (it is described anyway)', () => assert.strictEqual(g.motionNote(WALK), ''));
  await t('no measurement → no note, nothing missed', () => { assert.strictEqual(g.motionNote(null), ''); assert.strictEqual(g.missesMeasured('anything', null), false); });
  await t('"the phone resting in the lap" does NOT count as naming the leg movement', () => assert.ok(g.missesMeasured('both hands hold the phone resting in the lap', FIFA)));
  await t('"his right knee bounces quickly" does', () => assert.ok(!g.missesMeasured('his right knee bounces quickly, lifting the phone', FIFA)));
  await t('a MOVING hook that misses the measured legs still gets the revision, with the measurement in it', async () => {
    const r = await run({ prompt: MOVING, motion: FIFA, reply: MOVING.replace('[0-3s] [INFLUENCER] turns', '[0-3s] [INFLUENCER]\'s right knee bounces quickly; [INFLUENCER] turns') });
    assert.strictEqual(r.calls.length, 1); assert.ok(/MEASURED MOTION/.test(r.calls[0].body.messages[0].content.slice(-1)[0].text)); assert.ok(r.hookGuard.revised && /knee bounces/.test(r.basePrompt));
  });
  await t('a revision that still misses the measured legs is rejected', async () => { const r = await run({ prompt: MOVING, motion: FIFA, reply: MOVING }); assert.ok(r.hookGuard.rejected && noCrowd(r.basePrompt) === MOVING); });
  await t('no leg motion measured → a moving hook costs no call', async () => { const r = await run({ prompt: MOVING, motion: WALK, reply: MOVING }); assert.strictEqual(r.calls.length, 0); });
  await t('the analyser runs hookmotion.py for hookfirst and puts the note in the hook window', () => { const S = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8'); assert.ok(/execFile\(PYTHON, \[path\.join\(__dirname, 'hookmotion\.py'\), videoPath, String\(secs\)\]/.test(S) && /hookGuardLib\.motionNote\(hookMotion\)/.test(S)); });
  // ── the crowd keeps moving (v2.60.0) ───────────────────────────────────────────────────────
  { const P = '[INFLUENCER] sits courtside in a black tee. [INFLUENCER] wears this same outfit, fully dressed, in every shot.\n\nBehind, a woman sits with arms crossed.\n\n[0-3s] x.';
    const c = g.ensureCrowdMoves(P);
    await t('people around + no crowd sentence → it is put right after the outfit sentence', () => assert.ok(c.added === 1 && c.text.includes('in every shot. Throughout the whole clip, the people around [INFLUENCER] keep moving naturally — talking, glancing around, shifting in their seats; nobody is frozen.\n\nBehind')));
    await t('already there → untouched', () => assert.strictEqual(g.ensureCrowdMoves(c.text).text, c.text));
    await t('nobody else in the video → untouched', () => { const Q = '[INFLUENCER] walks alone on a beach. [INFLUENCER] wears this same outfit, fully dressed, in every shot.'; assert.strictEqual(g.ensureCrowdMoves(Q).text, Q); });
    await t('the writer is asked for the sentence and for an ONGOING action per person', () => { const S = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8'); assert.ok(/nobody is frozen\."'/.test(S) && /give EACH one an ongoing action of their own that keeps going through the hook/.test(S) && /const crowd = hookGuardLib\.ensureCrowdMoves\(basePrompt\);/.test(S)); });
    await t('the wiring adds it (hookfirst)', async () => { const r = await run({ prompt: P }); assert.ok(r.hookGuard.crowdAdded === 1 && /nobody is frozen/.test(r.basePrompt)); }); }
  // ── stillness scrub (v2.61.0) ───────────────────────────────────────────────────────────────
  { const P = 'Overall.\n\nMedium shot, lens centred on Kryfex, facing the camera; the knees continuously shift, while both arms rest low and the shoulders stay square — behind Kryfex, a woman shifts in her seat, and a man sits perfectly still with arms folded. The camera holds perfectly still.\n\n0–3s: eyes hold a direct, unblinking stare, Kryfex remains perfectly still.\n\n3–5s: later line, his shoulders stay square.';
    const r = g.scrubHookStillness(P);
    await t('"the shoulders stay square" and ", unblinking" are deleted from the hook', () => assert.ok(!/stay square — behind/.test(r.text) && /hold a direct stare/.test(r.text)));
    await t('"remains perfectly still" becomes "keeps moving naturally" (the sentence keeps a verb)', () => assert.ok(/Kryfex keeps moving naturally\./.test(r.text)));
    await t('another person\'s "sits perfectly still" loses the stillness too (it fights "nobody is frozen")', () => assert.ok(/a man sits with arms folded/.test(r.text)));
    await t('the CAMERA may hold still', () => assert.ok(/The camera holds perfectly still\./.test(r.text)));
    await t('lines after the hook are untouched', () => assert.ok(/3–5s: later line, his shoulders stay square\./.test(r.text)));
    await t('an unbracketed "3–5s:" line ends the hook', () => assert.ok(g.hookSegment(P).endsWith('Kryfex remains perfectly still.\n\n')));
    await t('the wiring runs it on hookfirst', () => { const S = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8'); assert.ok(/const still = hookGuardLib\.scrubHookStillness\(basePrompt\);\n\s+basePrompt = still\.text;/.test(S)); }); }
  await t('hookGuard travels in the response', () => assert.ok(/influencerInOpening,\n\s+hookGuard: hookGuard \|\| undefined,/.test(SRC)));

  console.log(`\n${fail ? 'x FAIL' : 'OK'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
