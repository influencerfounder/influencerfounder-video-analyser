#!/usr/bin/env node
// ✂️ A dead ffmpeg encoder must FAIL the cut-out job, never hang it (/toolscan 2026-10-19). write() waited for a
// 'drain' that a dead process never emits, so a bad size or a full disk left the job on "processing" for good
// (no tmp cleanup, the Studio polling 45 min), with an EPIPE uncaughtException and an unhandledRejection on the
// side. Runs the REAL encoder() against a local ffmpeg.
const fs = require('fs'), os = require('os'), path = require('path');
const { encoder } = require('../bgcutout');
if (typeof encoder !== 'function') { console.log('  x bgcutout.js does not export encoder()'); console.log('bg-cutout-encoder: 1 FAILED'); process.exit(1); }
let p = 0, f = 0; const ok = (c, m) => { c ? p++ : (f++, console.log('  x ' + m)); };
let stray = 0; const onStray = () => { stray++; };
process.on('uncaughtException', onStray); process.on('unhandledRejection', onStray);
const within = (pr, ms) => Promise.race([pr.then(() => 'ok', (e) => 'rejected: ' + e.message), new Promise((r) => setTimeout(() => r('hung'), ms))]);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgenc_'));
  // 1. odd size: libx264 + yuv420p refuses it and ffmpeg exits — the writes must reject
  {
    const e = encoder(path.join(dir, 'bad.mp4'), 3, 3, 30, false), big = new Uint8Array(3 * 3 * 3 * 200000);
    const res = await within((async () => { for (let k = 0; k < 20; k++) await e.write(big); await e.end(); })(), 8000);
    ok(/^rejected/.test(res), 'a dead encoder rejects the write (got ' + res + ')');
  }
  // 2. a normal encode still finishes
  {
    const e = encoder(path.join(dir, 'ok.mp4'), 16, 16, 30, false), fr = new Uint8Array(16 * 16 * 3).fill(90);
    const res = await within((async () => { for (let k = 0; k < 10; k++) await e.write(fr); await e.end(); })(), 15000);
    ok(res === 'ok' && fs.statSync(path.join(dir, 'ok.mp4')).size > 0, 'a normal encode still finishes (got ' + res + ')');
  }
  // 3. kill() ends an open encoder (the job's error path), and a later write rejects
  {
    const e = encoder(path.join(dir, 'k.mp4'), 16, 16, 30, true);
    ok(typeof e.kill === 'function', 'the encoder can be killed');
    if (typeof e.kill === 'function') { e.kill(); await new Promise((r) => setTimeout(r, 300)); ok(/^rejected/.test(await within(e.write(new Uint8Array(256)), 3000)), 'a write after kill rejects'); }
  }
  await new Promise((r) => setTimeout(r, 300));
  ok(stray === 0, 'no uncaughtException / unhandledRejection (' + stray + ')');
  // 4. the job's error path kills every encoder it opened
  const src = fs.readFileSync(path.join(__dirname, '..', 'bgcutout.js'), 'utf8');
  const i = src.indexOf('async function runBgCutout('), body = src.slice(i, src.indexOf('\nmodule.exports', i));
  ok((body.match(/\bencoder\(/g) || []).length === (body.match(/track\(encoder\(/g) || []).length && /catch \(e\) \{[\s\S]{0,200}encs\.forEach/.test(body), 'runBgCutout tracks every encoder and kills them on error');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(f ? `bg-cutout-encoder: ${f} FAILED, ${p} passed` : `bg-cutout-encoder: ${p} checks passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('  x harness: ' + e.message); process.exit(1); });
