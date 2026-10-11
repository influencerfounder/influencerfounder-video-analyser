#!/usr/bin/env node
// ✂️ On a student's Kie key the shot list is written in SHORT parts (Mike, 2026-10-11: "So this would work and
// fix it? If yes build it"). Kie's Claude gateway fails any answer that takes > ~80–110 s to write (measured);
// a whole spec is such an answer. Header first, then one call per ~8 s window (edges snapped to measured cuts)
// in parallel, merged in time order. axios is a recorder; nothing is paid.
const path = require('path'), assert = require('assert');
const axiosPath = require.resolve('axios');
const calls = []; let answer;
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (url, body, opts) => { calls.push({ url, body, headers: opts.headers }); return answer(body); }, get: async () => ({}) } };
const v2 = require(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'v2/cloneV2.js'));
const ok = (text) => ({ status: 200, data: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } });
const IMG = Array.from({ length: 42 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AA' } }));
const HEADER = { look: 'phone', setting: 'hotel driveway', outfit: { top_name: 'a dress', bare_skin: ['arms'] }, cast: [{ id: 'P1', label: 'the bellhop' }], hook: 'h' };
let pass = 0, fail = 0;
const t = async (n, fn) => { try { calls.length = 0; await fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
(async () => {
  await t('windows are ~8 s and snap to the nearest measured cut', () => {
    assert.ok(typeof v2.kieWindows === 'function', 'no split');
    assert.deepStrictEqual(v2.kieWindows(23, [2.5, 7.9, 15.2]), [{ from: 0, to: 7.9 }, { from: 7.9, to: 15.2 }, { from: 15.2, to: 23 }]);
    assert.deepStrictEqual(v2.kieWindows(6, [2]), [{ from: 0, to: 6 }], 'a short video is one window');
  });
  await t('header first, then the shot windows; every call short, every call sees all the images', async () => {
    answer = (body) => {
      const txt = body.messages[0].content.slice(-1)[0].text;
      if (/PART 1/.test(txt)) return ok(JSON.stringify(HEADER));
      const m = /from ([\d.]+) s to ([\d.]+) s/.exec(txt);
      const a = Number(m[1]);
      // a window answer that also (wrongly) repeats a shot from the previous window: it must be dropped
      return ok(JSON.stringify({ shots: [{ start: a, main_events: ['walks'] }, { start: a + 3, main_events: ['turns'] }, ...(a > 0 ? [{ start: a - 1, main_events: ['dup'] }] : [])] }));
    };
    const r = await v2.writeSpecViaKie({ system: 'S', content: IMG, kieKey: 'kie-STUDENT', deadline: Date.now() + 200000, duration: 23, cuts: [2.5, 7.9, 15.2] });
    assert.strictEqual(calls.length, 4, 'header + 3 windows');
    for (const c of calls) {
      assert.strictEqual(c.url, 'https://api.kie.ai/claude/v1/messages'); assert.strictEqual(c.headers.Authorization, 'Bearer kie-STUDENT');
      assert.ok(c.body.max_tokens <= 3000, 'a part asks for ' + c.body.max_tokens + ' tokens');
      assert.strictEqual(c.body.messages[0].content.filter((x) => x.type === 'image').length, 42, 'a part lost images');
    }
    for (const c of calls.slice(1)) assert.ok(c.body.messages[0].content.slice(-1)[0].text.includes('"label":"the bellhop"'), 'a window did not get the fixed header');
    assert.deepStrictEqual(r.spec.shots.map((s) => s.start), [0, 3, 7.9, 10.9, 15.2, 18.2], 'merged in order, out-of-window repeats dropped');
    assert.strictEqual(r.spec.outfit.top_name, 'a dress'); assert.strictEqual(r.w.payer, 'kie'); assert.strictEqual(r.w.parts, 4);
    assert.strictEqual(r.w.usage.output_tokens, 20, 'usage is summed over the parts');
  });
  await t('a part without shots fails the analysis with the plain message, never half a spec', async () => {
    answer = (body) => (/PART 1/.test(body.messages[0].content.slice(-1)[0].text) ? ok(JSON.stringify(HEADER)) : ok('sorry'));
    await assert.rejects(v2.writeSpecViaKie({ system: 'S', content: IMG, kieKey: 'k', deadline: Date.now() + 200000, duration: 12, cuts: [] }), /could not be structured/);
  });
  await t('the handler uses the parts on Kie and the single call for the owner', () => {
    const src = require('fs').readFileSync(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'v2/cloneV2.js'), 'utf8');
    assert.ok(/if \(kieKey\) \{\s*\/\/[^\n]*\n\s*\(\{ spec, w \} = await writeSpecViaKie\(\{ system, content, kieKey, deadline, duration, cuts \}\)\)/.test(src));
  });
  console.log(`\nv2-kie-parts: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
