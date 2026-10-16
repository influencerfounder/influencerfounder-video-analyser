#!/usr/bin/env node
// 🔎 Owner-only second opinion (Mike, 2026-10-11: "can do this as default owner only"): Gemini watches the video,
// a Claude JUDGE adds only visible, missing moments of MAIN — max 4, never a rewrite, never a removal. axios is a
// recorder; nothing is paid.
const path = require('path'), assert = require('assert');
const axiosPath = require.resolve('axios');
const calls = []; let answer;
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (url, body, opts) => { calls.push({ url, body, headers: opts.headers }); return answer(body); }, get: async () => ({}) } };
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'v2/cloneV2.js');
const v2 = require(SRC);
const cla = (obj) => ({ status: 200, data: { content: [{ type: 'text', text: JSON.stringify(obj) }], usage: {}, stop_reason: 'end_turn' } });
const SPEC = { outfit: {}, shots: [{ start: 0, main_events: ['walks toward the camera', 'covers the mouth'] }, { start: 3, main_events: ['shakes hands'] }] };
const LOG = { timeline: [{ start: 0, end: 1.5, who: 'MAIN', action: 'walks, covers mouth, waves' }, { start: 0.5, end: 1, who: 'P1', action: 'opens door' }] };
const sheets = [{ buf: Buffer.from('s'), times: [0, 0.25] }]; const hookFrames = [{ t: 0, b: Buffer.from('h') }];
const run = (ans) => { answer = () => cla(ans); calls.length = 0; return v2.secondOpinionMerge({ spec: SPEC, log: LOG, sheets, hookFrames, key: 'sk-OWNER', deadline: Date.now() + 200000 }); };
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
(async () => {
  await t('a missing, visible moment is inserted in order; the judge runs on the owner key (Anthropic) with the frames', async () => {
    assert.ok(typeof v2.secondOpinionMerge === 'function', 'no second opinion');
    const r = await run({ shots: [{ start: 0, main_events: ['walks toward the camera', 'covers the mouth', 'waves the right hand'] }], added: [{ start: 0, event: 'waves the right hand' }] });
    assert.deepStrictEqual(r.spec.shots[0].main_events, ['walks toward the camera', 'covers the mouth', 'waves the right hand']);
    assert.deepStrictEqual(r.added, [{ start: 0, event: 'waves the right hand' }]);
    assert.strictEqual(calls[0].url, 'https://api.anthropic.com/v1/messages'); assert.ok(calls[0].body.messages[0].content.some((c) => c.type === 'image'));
    assert.ok(!JSON.stringify(calls[0].body).includes('opens door'), 'only MAIN\'s rows go to the judge');
  });
  await t('a judge answer that drops or rewrites an original action is refused', async () => {
    const r = await run({ shots: [{ start: 0, main_events: ['walks', 'waves'] }] });
    assert.strictEqual(r.spec, null); assert.deepStrictEqual(r.added, []);
  });
  await t('the judge cannot reorder or double the original actions (the hook\'s timing)', async () => {
    assert.strictEqual((await run({ shots: [{ start: 0, main_events: ['covers the mouth', 'walks toward the camera', 'waves'] }] })).spec, null, 'reordered');
    assert.strictEqual((await run({ shots: [{ start: 0, main_events: ['walks toward the camera', 'walks toward the camera', 'covers the mouth', 'waves'] }] })).spec, null, 'original doubled');
    assert.strictEqual((await run({ shots: [{ start: 0, main_events: ['walks toward the camera', 'covers the mouth', 'waves', 'waves'] }] })).spec, null, 'addition doubled');
    assert.strictEqual((await run({ shots: [{ start: 0, main_events: ['walks toward the camera', 'Covers the mouth!', 'covers the mouth'] }] })).spec, null, 'an original re-added in other casing');
  });
  await t('an addition about another person is refused', async () => {
    assert.strictEqual((await run({ shots: [{ start: 0, main_events: ['walks toward the camera', 'covers the mouth', 'P1 opens the door behind MAIN'] }] })).spec, null);
    assert.strictEqual((await run({ shots: [{ start: 0, main_events: ['walks toward the camera', 'covers the mouth', 'nods at p1'] }] })).spec, null, 'lower-case p1');
  });
  await t('never more than 4 additions per video', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((x) => 'extra ' + x);
    const r = await run({ shots: [{ start: 0, main_events: ['walks toward the camera', 'covers the mouth', ...many] }] });
    assert.strictEqual(r.spec, null, 'five additions in one shot must be refused whole');
    const ok4 = await run({ shots: [{ start: 0, main_events: ['walks toward the camera', 'covers the mouth', 'x1', 'x2'] }, { start: 3, main_events: ['shakes hands', 'x3', 'x4'] }] });
    assert.strictEqual(ok4.added.length, 4);
  });
  await t('nothing missing, a failed judge or too little time = the spec as written', async () => {
    assert.strictEqual((await run({ shots: [], added: [] })).spec, null);
    answer = () => ({ status: 500, data: { error: { message: 'down' } } });
    assert.strictEqual((await v2.secondOpinionMerge({ spec: SPEC, log: LOG, sheets, hookFrames, key: 'k', deadline: Date.now() + 200000 })).spec, null);
    calls.length = 0;
    const late = await v2.secondOpinionMerge({ spec: SPEC, log: LOG, sheets, hookFrames, key: 'k', deadline: Date.now() + 10000 });
    assert.strictEqual(late.spec, null); assert.strictEqual(calls.length, 0);
  });
  await t('wired: owner path only (no student key), Gemini started in parallel with the writer, result returned', () => {
    const src = require('fs').readFileSync(SRC, 'utf8');
    assert.ok(/const secondP = \(!kieKey && !userInputs\(req\.body \|\| \{\}\)\.mainHint && typeof geminiShotLog === 'function'\) \? geminiShotLog\(video, \{ timeoutMs: 240000 \}\)/.test(src));
    // A (2026-10-14): Gemini starts the moment the video is on disk — before every measurement and the frames.
    assert.ok(src.indexOf('const secondP =') < src.indexOf('// 2. MEASURE.'), 'Gemini must start right after the download');
    // B: the analysis never waits for Gemini — no timer race, a not-yet answer goes to the background.
    assert.ok(!/Gemini took too long/.test(src), 'the analysis must not wait for Gemini');
    assert.ok(/if \(soLate\) \{\s*const late = startLateSecondOpinion\(\{ lid: req\.body\.locationId,/.test(src), 'a late answer finishes in the background, bound to the lid');
    assert.ok(/app\.get\('\/api\/clone-v2\/second-opinion\/:id'/.test(src) && /rec\.lid && String\(req\.query\.lid \|\| ''\) !== rec\.lid/.test(src), 'lookup route, lid-bound');
    assert.ok(/sourceVideoUrl, secondOpinion, writer:/.test(src));
    const idx = require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/runRecorded, geminiShotLog,/.test(idx), 'the analyser passes its Gemini logger in');
  });
  // ⏳ LATE (2026-10-14): judged in the background, fetched by the tool as patches.
  const deferred = () => { let r; const p = new Promise((x) => { r = x; }); return { p, r }; };
  await t('late: pending until Gemini answers, then done with patches + recompiled prompts, lid-bound record', async () => {
    const store = new Map(); const d = deferred();
    const merged = { ...SPEC, shots: [{ start: 0, main_events: ['walks toward the camera', 'covers the mouth', 'waves'] }, SPEC.shots[1]] };
    const L = v2.startLateSecondOpinion({ lid: 'LID1', secondP: d.p, spec: SPEC, sheets, hookFrames, key: 'k', store,
      recompile: (s) => ({ wan: { prompt: 'W' + s.shots[0].main_events.length } }), merge: async () => ({ spec: merged, added: [{ start: 0, event: 'waves' }] }) });
    assert.ok(/^[0-9a-f]{32}$/.test(L.id));
    assert.strictEqual(v2.lateSecondOpinionView(store.get(L.id)).status, 'pending');
    assert.strictEqual(store.get(L.id).lid, 'LID1');
    d.r({ ok: true, log: LOG, model: 'gemini-x', secs: 101 }); await L.done;
    const v = v2.lateSecondOpinionView(store.get(L.id));
    assert.strictEqual(v.status, 'done'); assert.deepStrictEqual(v.added, [{ start: 0, event: 'waves' }]);
    assert.deepStrictEqual(v.patches, [{ start: 0, before: ['walks toward the camera', 'covers the mouth'], after: ['walks toward the camera', 'covers the mouth', 'waves'] }], 'only the changed shot');
    assert.strictEqual(v.prompts.wan.prompt, 'W3'); assert.strictEqual(v.geminiSecs, 101); assert.strictEqual(v.error, null);
  });
  await t('late: a Gemini failure or timeout ends as done with the reason, never stuck pending', async () => {
    const store = new Map();
    const L = v2.startLateSecondOpinion({ lid: 'L', secondP: Promise.resolve({ ok: false, error: 'timeout of 240000ms exceeded' }), spec: SPEC, store, merge: async () => { throw new Error('must not judge'); } });
    await L.done; const v = v2.lateSecondOpinionView(store.get(L.id));
    assert.strictEqual(v.status, 'done'); assert.ok(/240000/.test(v.error)); assert.deepStrictEqual(v.patches, []);
    const L2 = v2.startLateSecondOpinion({ lid: 'L', secondP: Promise.resolve({ ok: true, log: LOG }), spec: SPEC, store, merge: async () => { throw new Error('boom'); } });
    await L2.done; assert.strictEqual(store.get(L2.id).status, 'done'); assert.ok(/boom/.test(store.get(L2.id).error));
  });
  await t('late: a judge answer that fails validation applies nothing', async () => {
    const store = new Map();
    const L = v2.startLateSecondOpinion({ lid: 'L', secondP: Promise.resolve({ ok: true, log: LOG }), spec: SPEC, store, merge: async () => ({ spec: { shots: 'broken' }, added: [{ start: 0, event: 'x' }] }) });
    await L.done; const v = v2.lateSecondOpinionView(store.get(L.id));
    assert.deepStrictEqual(v.added, []); assert.deepStrictEqual(v.patches, []); assert.strictEqual(v.prompts, null);
  });
  await t('late: records older than 30 min are dropped when a new one starts', async () => {
    const store = new Map([['old', { at: Date.now() - 31 * 60000, status: 'done' }]]);
    v2.startLateSecondOpinion({ lid: 'L', secondP: new Promise(() => {}), spec: SPEC, store });
    assert.ok(!store.has('old')); assert.strictEqual(store.size, 1);
  });

  console.log(`\nv2-second-opinion: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
