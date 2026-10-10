#!/usr/bin/env node
// ⏱🔁 Recreate Lab analysis (/api/clone-v2): a run budget and a double-run guard (Mike, 2026-10-10:
// "fix all 6"; /toolscan 2026-10-09). The tool gives up after 290 s, but the writer could take
// 240 s + a 240 s fallback + a repair + the outfit pick on the owner's Anthropic key, and an identical
// request (the edge re-sending, or a second click) ran the whole paid analysis again.
const fs = require('fs'), path = require('path'), assert = require('assert');
const axiosPath = require.resolve('axios');
const calls = [];
let reply = () => ({ status: 200, data: { content: [{ type: 'text', text: '{}' }] } });
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (u, body, opts) => { calls.push({ model: body.model, timeout: opts.timeout }); return reply(body); }, get: async () => ({}) } };
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'v2/cloneV2.js');
const v2 = require(SRC);
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

(async () => {
  await t('a writer call gets only what is left of the budget', async () => {
    calls.length = 0;
    await v2.callWriter({ system: 's', content: [], key: 'k', deadline: Date.now() + 60000 });
    assert.ok(calls[0].timeout <= 60000 && calls[0].timeout > 50000, 'timeout ' + calls[0].timeout);
  });
  await t('no paid call starts once the budget is spent', async () => {
    calls.length = 0;
    await assert.rejects(v2.callWriter({ system: 's', content: [], key: 'k', deadline: Date.now() + 5000 }), (e) => e.code === 'out_of_time');
    assert.strictEqual(calls.length, 0, 'a call was made with ' + (calls[0] && calls[0].timeout) + ' ms left');
  });
  await t('the fallback model is not tried after the budget ran out', async () => {
    // The first call is slow (a stalled gateway eats 95 s of a 100 s budget) and then fails.
    calls.length = 0;
    const realNow = Date.now; let clock = realNow(); Date.now = () => clock;
    reply = () => { clock += 95000; return { status: 529, data: {} }; };
    try {
      await assert.rejects(v2.callWriter({ system: 's', content: [], key: 'k', deadline: clock + 100000 }), (e) => e.code === 'out_of_time');
      assert.strictEqual(calls.length, 1, 'fallback called after time ran out');
    } finally { Date.now = realNow; reply = () => ({ status: 200, data: { content: [{ type: 'text', text: '{}' }] } }); }
  });
  await t('the budget leaves the tool room to store the result (tool waits ≥ budget + 15 s)', () => {
    const tool = path.join(__dirname, '..', '..', 'InfluencerFounder-tool', 'src', 'index.js');
    if (!fs.existsSync(tool)) { console.log('      (tool repo not beside this one — skipped)'); return; }
    const s = fs.readFileSync(tool, 'utf8');
    const i = s.indexOf("app.post('/api/studio/recreate-v2/analyse'");
    const m = /timeout:\s*(\d+)/.exec(s.slice(i, i + 3000));
    assert.ok(m, 'tool timeout not found');
    assert.ok(Number(m[1]) >= v2.V2_BUDGET_MS + 15000, `tool waits ${m[1]} ms, budget ${v2.V2_BUDGET_MS}`);
  });
  const rec = (handler, req) => new Promise((resolve) => {
    const r = { _s: 200, status(c) { r._s = c; return r; }, json(b) { resolve({ status: r._s, body: b }); return r; } };
    Promise.resolve().then(() => handler(req, r));
  });
  const resp = () => { const r = { status(c) { r.s = c; return r; }, json(b) { r.b = b; return r; } }; return r; };
  await t('two identical requests at once run the analysis ONCE and both get the answer', async () => {
    let runs = 0, release;
    const gate = new Promise(r => { release = r; });
    const h = v2.joinIdentical(async (req, res) => { runs++; await gate; res.json({ success: true, n: runs }); }, rec);
    const body = { locationId: 'L', videoUrl: 'https://x/v', name: 'Kryfex', personaGender: 'male' };
    const a = resp(), b = resp();
    const pa = h({ body }, a), pb = h({ body: { ...body } }, b);
    await new Promise(r => setImmediate(r)); release(); await Promise.all([pa, pb]);
    assert.strictEqual(runs, 1); assert.strictEqual(a.b.n, 1); assert.strictEqual(b.b.n, 1);
  });
  await t('a retry within 3 minutes is served from the cache; after that it runs again', async () => {
    let runs = 0, clock = 0;
    const h = v2.joinIdentical(async (req, res) => { runs++; res.json({ success: true }); }, rec, { now: () => clock });
    const body = { locationId: 'L', videoUrl: 'https://x/v' };
    await h({ body }, resp()); clock = 170000; await h({ body }, resp());
    assert.strictEqual(runs, 1, 'second call within 3 min ran again');
    clock = 400000; await h({ body }, resp());
    assert.strictEqual(runs, 2);
  });
  await t('an error is never cached; a different influencer or video is a different run', async () => {
    let runs = 0;
    const h = v2.joinIdentical(async (req, res) => { runs++; res.status(504).json({ success: false }); }, rec);
    const body = { locationId: 'L', videoUrl: 'https://x/v', name: 'A' };
    await h({ body }, resp()); await h({ body }, resp());
    assert.strictEqual(runs, 2, 'a failed run was served again');
    assert.notStrictEqual(v2.v2JoinKey(body), v2.v2JoinKey({ ...body, name: 'B' }));
    assert.notStrictEqual(v2.v2JoinKey(body), v2.v2JoinKey({ ...body, videoUrl: 'https://x/w' }));
  });
  await t('the route is mounted through the join and the analyser passes its recorder', () => {
    const src = fs.readFileSync(SRC, 'utf8'), idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/app\.post\('\/api\/clone-v2', joinIdentical\(cloneV2Handler, deps\.runRecorded\)\)/.test(src));
    assert.ok(/cleanOldTempVideos, PYTHON, runRecorded,/.test(idx));
    for (const re of [/callWriter\(\{ system, content, key, deadline \}\)/, /callWriter\(\{ system, key, deadline, content:/, /pickOutfit\(\{ spec, ff: ffmpegBin, video, tmp, key, duration, deadline \}\)/, /maxTokens: 600, deadline \}\)/])
      assert.ok(re.test(src), 'a paid call skips the deadline: ' + re);
  });
  console.log(`\nv2-budget: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
