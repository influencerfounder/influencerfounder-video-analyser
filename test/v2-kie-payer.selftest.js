#!/usr/bin/env node
// 💳 Recreate NEW analyses are paid by the student's own Kie key (Mike, 2026-10-11: "build it and open the
// tool for everyone"). With kieKey the writer goes to Kie's Claude gateway with that key and never touches
// the owner's Anthropic key; without it the owner path is unchanged. Kie's quirks: an error inside a 200,
// a refused `thinking` field, a rejected key / empty balance. axios is a recorder; nothing is paid.
const path = require('path'), assert = require('assert');
const axiosPath = require.resolve('axios');
const calls = []; let replies = [];
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (url, body, opts) => { calls.push({ url, body, headers: opts.headers }); const r = replies.shift(); return typeof r === 'function' ? r(body) : r; }, get: async () => ({}) } };
const v2 = require(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'v2/cloneV2.js'));
const OK = { status: 200, data: { content: [{ type: 'text', text: '{"ok":1}' }], usage: { input_tokens: 5 } } };
let pass = 0, fail = 0;
const t = async (n, fn) => { try { calls.length = 0; await fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
(async () => {
  await t('a student key goes to Kie with Bearer auth — never the owner\'s Anthropic key', async () => {
    replies = [OK];
    const w = await v2.callWriter({ system: 's', content: [], key: 'sk-ant-OWNER', kieKey: 'kie-STUDENT' });
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].url, 'https://api.kie.ai/claude/v1/messages');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer kie-STUDENT');
    assert.ok(!JSON.stringify(calls[0].headers).includes('sk-ant-OWNER'), 'the owner key travelled with a student call');
    assert.strictEqual(w.payer, 'kie');
  });
  await t('no student key = the owner path, unchanged', async () => {
    replies = [OK];
    const w = await v2.callWriter({ system: 's', content: [], key: 'sk-ant-OWNER' });
    assert.strictEqual(calls[0].url, 'https://api.anthropic.com/v1/messages'); assert.strictEqual(w.payer, 'owner');
  });
  await t('Kie\'s 200-with-an-error-body is a failure, not an empty analysis', async () => {
    replies = [{ status: 200, data: { code: 500, msg: 'Internal error' } }, { status: 200, data: { code: 500, msg: 'Internal error' } }];
    await assert.rejects(v2.callWriter({ system: 's', content: [], kieKey: 'k' }), /busy/);
    assert.ok(calls.every(c => c.url.includes('kie.ai')), 'fell back onto the owner key');
  });
  await t('a refused key or an empty balance says so, and is not retried on another model', async () => {
    replies = [{ status: 401, data: { msg: 'invalid key' } }];
    await assert.rejects(v2.callWriter({ system: 's', content: [], kieKey: 'k' }), (e) => e.code === 'kie_key'); assert.strictEqual(calls.length, 1);
    calls.length = 0; replies = [{ status: 200, data: { code: 402, msg: 'Credits insufficient' } }];
    await assert.rejects(v2.callWriter({ system: 's', content: [], kieKey: 'k' }), (e) => e.code === 'kie_balance'); assert.strictEqual(calls.length, 1);
  });
  await t('a relay that refuses `thinking` gets one retry without it', async () => {
    replies = [{ status: 400, data: { error: { message: 'Unknown field: thinking' } } }, (body) => (body.thinking ? { status: 400, data: {} } : OK)];
    const w = await v2.callWriter({ system: 's', content: [], kieKey: 'k' });
    assert.strictEqual(calls.length, 2); assert.ok(!('thinking' in calls[1].body)); assert.strictEqual(w.text, '{"ok":1}');
  });
  await t('the analysis route takes the key from the request and only falls back to the owner key without one', () => {
    const src = require('fs').readFileSync(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'v2/cloneV2.js'), 'utf8');
    assert.ok(/const key = kieKey \? '' : process\.env\.ANTHROPIC_API_KEY;/.test(src));
    for (const re of [/callWriter\(\{ system, content, key, kieKey, deadline \}\)/, /callWriter\(\{ system, key, kieKey, deadline, content:/, /pickOutfit\(\{ spec, ff: ffmpegBin, video, tmp, key, kieKey, duration, deadline \}\)/, /OUTFIT_PICK_SYSTEM, content, key, kieKey,/])
      assert.ok(re.test(src), 'a paid call does not pass the student key: ' + re);
  });
  console.log(`\nv2-kie-payer: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
