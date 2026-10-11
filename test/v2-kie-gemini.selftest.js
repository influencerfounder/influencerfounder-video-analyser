#!/usr/bin/env node
// 🔀 Student writer (Mike, 2026-10-11): Gemini on Kie writes the spec, a SHORT Claude pass on Kie rewrites the
// hook stretch, and Gemini's hook stays if that pass fails. axios is a recorder; nothing is paid.
const path = require('path'), assert = require('assert');
const axiosPath = require.resolve('axios');
const calls = []; let answer;
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (url, body, opts) => { calls.push({ url, body, headers: opts.headers }); return answer(url, body); }, get: async () => ({}) } };
const v2 = require(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'v2/cloneV2.js'));
const gem = (text) => ({ status: 200, data: { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 46000, completion_tokens: 900 }, credits_consumed: 2.3 } });
const cla = (text) => ({ status: 200, data: { content: [{ type: 'text', text }], usage: { input_tokens: 9000, output_tokens: 400 }, stop_reason: 'end_turn' } });
const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } };
const SPEC = { outfit: { top_name: 'a dress' }, cast: [{ id: 'P1', label: 'the valet' }], shots: [{ start: 0, main_events: ['walks'] }, { start: 3.5, main_events: ['shakes hands'] }, { start: 8, main_events: ['gets in'] }] };
const sheets = Array.from({ length: 12 }, (_, k) => ({ buf: Buffer.from('s'), times: Array.from({ length: 8 }, (_, j) => (k * 8 + j) * 0.25) }));
const hookFrames = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.15, b: Buffer.from('h') }));
let pass = 0, fail = 0;
const t = async (n, fn) => { try { calls.length = 0; await fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
(async () => {
  await t('Gemini on Kie: OpenAI format, the student key, images as data URIs, thinking low', async () => {
    assert.ok(typeof v2.callGeminiKie === 'function', 'no Gemini writer');
    answer = () => gem('{"ok":1}');
    const w = await v2.callGeminiKie({ system: 'S', content: [{ type: 'text', text: 'facts' }, IMG], kieKey: 'kie-STUDENT', deadline: Date.now() + 200000 });
    assert.strictEqual(calls[0].url, 'https://api.kie.ai/gemini-3-8-flash-openai/v1/chat/completions');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer kie-STUDENT');
    assert.strictEqual(calls[0].body.messages[0].role, 'system');
    assert.deepStrictEqual(calls[0].body.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
    assert.strictEqual(calls[0].body.reasoning_effort, 'low'); assert.strictEqual(w.text, '{"ok":1}'); assert.strictEqual(w.payer, 'kie');
  });
  await t('Kie\'s 200-with-error and a low balance surface as such', async () => {
    answer = () => ({ status: 200, data: { code: 402, msg: 'Credits insufficient' } });
    await assert.rejects(v2.callGeminiKie({ system: 'S', content: [], kieKey: 'k', deadline: Date.now() + 200000 }), (e) => e.code === 'kie_balance');
    answer = () => ({ status: 200, data: { code: 500, msg: 'Internal error' } });
    await assert.rejects(v2.callGeminiKie({ system: 'S', content: [], kieKey: 'k', deadline: Date.now() + 200000 }), /busy/);
  });
  await t('the hook pass is ONE short Claude call (<= 20 images) and replaces only the stretch up to Gemini\'s next shot', async () => {
    answer = (url) => cla(JSON.stringify({ shots: [{ start: 0, main_events: ['walks', 'covers mouth', 'lowers hand', 'covers again', 'waves'] }, { start: 1.5, main_events: ['keeps walking'] }] }));
    const h = await v2.refineHookViaKieClaude({ system: 'S', facts: 'F', sheets, hookFrames, spec: SPEC, kieKey: 'kie-STUDENT', deadline: Date.now() + 200000, hookSecs: 1.5, duration: 23 });
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].url, 'https://api.kie.ai/claude/v1/messages');
    const imgs = calls[0].body.messages[0].content.filter((c) => c.type === 'image').length;
    assert.ok(imgs <= 20, imgs + ' images'); assert.ok(calls[0].body.max_tokens <= 3000);
    assert.deepStrictEqual(h.spec.shots.map((x) => x.start), [0, 1.5, 3.5, 8], 'hook stretch replaced, the rest kept');
    assert.strictEqual(h.spec.shots[0].main_events.length, 5);
    assert.strictEqual(h.spec.outfit.top_name, 'a dress');
  });
  await t('a failed or unusable hook pass returns null — the caller keeps Gemini\'s hook', async () => {
    answer = () => ({ status: 500, data: { type: 'error', error: { message: 'Server exception' } } });
    const a = await v2.refineHookViaKieClaude({ system: 'S', facts: 'F', sheets, hookFrames, spec: SPEC, kieKey: 'k', deadline: Date.now() + 200000, hookSecs: 1.5, duration: 23 });
    assert.strictEqual(a.spec, null);
    answer = () => cla('sorry');
    const b = await v2.refineHookViaKieClaude({ system: 'S', facts: 'F', sheets, hookFrames, spec: SPEC, kieKey: 'k', deadline: Date.now() + 200000, hookSecs: 1.5, duration: 23 });
    assert.strictEqual(b.spec, null);
    calls.length = 0;
    const c = await v2.refineHookViaKieClaude({ system: 'S', facts: 'F', sheets, hookFrames, spec: SPEC, kieKey: 'k', deadline: Date.now() + 20000, hookSecs: 1.5, duration: 23 });
    assert.strictEqual(c.spec, null); assert.strictEqual(calls.length, 0, 'no pass started with too little time left');
  });
  await t('the handler: Gemini spec + hook pass on Kie, the owner\'s single Claude call unchanged; outfit pick on Gemini for students', () => {
    const src = require('fs').readFileSync(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'v2/cloneV2.js'), 'utf8');
    assert.ok(/if \(kieKey\) \{[\s\S]{0,400}w = await callGeminiKie\(\{ system, content, kieKey, deadline \}\);/.test(src));
    assert.ok(/refineHookViaKieClaude\(\{ system, facts, sheets: sh, hookFrames: hook, spec, kieKey, deadline, hookSecs, duration \}\)/.test(src));
    assert.ok(/w = await callWriter\(\{ system, content, key, kieKey, deadline \}\); mark\('writer'\);/.test(src), 'owner path changed');
    assert.ok(/const w = kieKey \? await callGeminiKie\(\{ system: OUTFIT_PICK_SYSTEM, content, kieKey, maxTokens: 3000, deadline \}\)/.test(src));
  });
  console.log(`\nv2-kie-gemini: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
