#!/usr/bin/env node
// 🔐 The analyser answers only the tool (/toolscan 2026-10-19). Runs the REAL middleware on a real Express app
// in both rollout modes, plus the guard's own decision table.
const express = require('express'), http = require('http');
const A = require('../analyserAuth');
let p = 0, f = 0; const ok = (c, m) => { c ? p++ : (f++, console.log('  x ' + m)); };
const env = { ANALYSER_SECRET: 's3cret-value' };
const R = (method, path, key) => ({ method, path, get: (h) => (h === A.HEADER ? key : undefined) });
// decision table
ok(A.check(R('POST', '/api/bg-cutout'), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === false, 'require: POST without key refused');
ok(A.check(R('POST', '/api/bg-cutout', 'wrong'), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === false, 'require: wrong key refused');
ok(A.check(R('POST', '/api/bg-cutout', 's3cret-value'), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === true, 'require: right key served');
ok(A.check(R('POST', '/API/BG-CUTOUT'), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === false, 'require: upper-cased path still refused');
ok(A.check(R('GET', '/api/bg-cutout/bgc_1'), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === false, 'require: status GETs are not open');
ok(A.check(R('GET', '/api/clone-v2/second-opinion/x'), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === false, 'require: second-opinion GET is not open');
for (const path of ['/', '/health', '/api/temp-video/abc123', '/API/Temp-Video/abc', '/api/faceswap/download/j1'])
  ok(A.check(R('GET', path), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === true, 'require: open link stays open: ' + path);
ok(A.check(R('POST', '/api/temp-video'), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === false, 'require: POST /api/temp-video (upload) is not open');
ok(A.check(R('GET', '/api/temp-video/a/b'), { ...env, ANALYSER_SECRET_MODE: 'require' }).allow === false, 'require: no path tricks past the open list');
ok(A.check(R('POST', '/api/clone'), { ANALYSER_SECRET_MODE: 'require' }).allow === false, 'require with NO secret configured refuses (fail closed)');
ok(A.check(R('POST', '/api/clone', ''), { ANALYSER_SECRET_MODE: 'require', ANALYSER_SECRET: '' }).allow === false, 'require: empty key never matches an empty secret');
ok(A.check(R('POST', '/api/clone'), env).allow === true && A.check(R('POST', '/api/clone'), env).reason === 'missing_key_logged', 'log mode: served but logged');
ok(A.check(R('POST', '/api/clone'), {}).allow === true, 'nothing configured: served (stage 0, today\'s behaviour)');
// real Express
(async () => {
  const run = async (mode) => {
    const old = { ...process.env };
    process.env.ANALYSER_SECRET = 's3cret-value'; if (mode) process.env.ANALYSER_SECRET_MODE = mode; else delete process.env.ANALYSER_SECRET_MODE;
    const logs = []; const app = express(); app.use(A.middleware((m) => logs.push(m))); app.use(express.json());
    app.post('/api/bg-cutout', (req, res) => res.json({ ok: true })); app.get('/api/temp-video/:t', (req, res) => res.send('file'));
    const srv = http.createServer(app).listen(0); const port = srv.address().port;
    const hit = (method, path, key) => new Promise((resolve) => { const r = http.request({ port, method, path, headers: { 'content-type': 'application/json', ...(key ? { [A.HEADER]: key } : {}) } }, (x) => { x.resume(); x.on('end', () => resolve(x.statusCode)); }); r.end(method === 'POST' ? '{}' : undefined); });
    const out = { noKey: await hit('POST', '/api/bg-cutout'), key: await hit('POST', '/api/bg-cutout', 's3cret-value'), file: await hit('GET', '/api/temp-video/tok') , logs };
    srv.close(); process.env = old; return out;
  };
  const req_ = await run('require');
  ok(req_.noKey === 401 && req_.key === 200 && req_.file === 200, `Express require: no key ${req_.noKey}, key ${req_.key}, file ${req_.file}`);
  const log_ = await run('');
  ok(log_.noKey === 200 && log_.logs.length === 1 && log_.key === 200, `Express log: no key ${log_.noKey} (logged ${log_.logs.length}), key ${log_.key}`);
  // wired into the real server before the body parser
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const a = src.indexOf("app.use(require('./analyserAuth').middleware());"), b = src.indexOf("app.use(express.json(");
  ok(a > 0 && a < b && !/app\.(get|post)\(/.test(src.slice(0, a)), 'index.js mounts it first, before express.json and every route');
  console.log(f ? `analyser-auth: ${f} FAILED, ${p} passed` : `analyser-auth: ${p} checks passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('  x harness: ' + e.message); process.exit(1); });
