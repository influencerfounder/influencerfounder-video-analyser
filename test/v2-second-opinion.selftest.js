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
    assert.ok(/const secondP = \(!kieKey && typeof geminiShotLog === 'function'\) \? geminiShotLog\(video\)/.test(src));
    assert.ok(src.indexOf('const secondP =') < src.indexOf('// 4. WRITE the spec'), 'Gemini must start before the writer');
    assert.ok(/sourceVideoUrl, secondOpinion, writer:/.test(src));
    const idx = require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/runRecorded, geminiShotLog,/.test(idx), 'the analyser passes its Gemini logger in');
  });
  console.log(`\nv2-second-opinion: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
