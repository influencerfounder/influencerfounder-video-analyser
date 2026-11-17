#!/usr/bin/env node
// 🔇 dehum (VQL 2026-11-17-04): the decision rules, and the whole chain on a synthetic clip — a 60 Hz hum under
// noise is found, notched away, and the picture comes out bit-identical. The chain part needs ffmpeg + python3 with
// numpy; it says SKIP (not pass) where they are missing.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { decide, filterFor, FLUX_MAX } = require('../dehum');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

t('no hum tone → untouched', () => assert.strictEqual(decide({ hum: [], flux: 0.6 }).clean, false));
t('no audio → untouched, reason kept', () => { const d = decide({ hum: [], reason: 'no or too little audio' }); assert.ok(!d.clean && /no or too little/.test(d.reason)); });
t('a lively track (likely music) is left alone', () => assert.strictEqual(decide({ hum: [{ hz: 65, prom: 15, persist: 0.9 }], flux: FLUX_MAX + 0.1 }).clean, false));
t('steady hum on a flat track → notched, strongest 4, sorted', () => {
  const d = decide({ hum: [{ hz: 43, prom: 29, persist: 0.99 }, { hz: 75.4, prom: 33, persist: 1 }, { hz: 151, prom: 17, persist: 0.97 }, { hz: 205, prom: 13, persist: 0.9 }, { hz: 118, prom: 12.5, persist: 0.86 }, { hz: 400, prom: 30, persist: 1 }], flux: 0.65 });
  assert.ok(d.clean); assert.deepStrictEqual(d.tones, [43, 75, 151, 205]);
});
t('filter = high-pass 80 Hz + one notch per tone', () => assert.strictEqual(filterFor([54, 97]), 'highpass=f=80:poles=2,equalizer=f=54:t=q:w=8:g=-25,equalizer=f=97:t=q:w=8:g=-25'));

t('a voice take keeps every tone above 100 Hz', () => {
  const det = { hum: [{ hz: 54, prom: 20, persist: 0.99 }, { hz: 151, prom: 18, persist: 0.95 }], flux: 0.65 };
  assert.deepStrictEqual(decide(det, { voice: true }).tones, [54]);
  assert.strictEqual(decide({ hum: [{ hz: 151, prom: 18, persist: 0.95 }], flux: 0.65 }, { voice: true }).clean, false);
  assert.deepStrictEqual(decide(det).tones, [54, 151]);
});
let FF = null; try { FF = execFileSync('which', ['ffmpeg']).toString().trim(); } catch (_) {}
let PY = process.env.PYTHON || 'python3', np = false; try { execFileSync(PY, ['-c', 'import numpy']); np = true; } catch (_) {}
if (!FF || !np) console.log('  SKIP chain test (needs ffmpeg + python3 with numpy)');
else t('chain: a 60 Hz hum under noise is found, removed, and the picture is bit-identical', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dehumtest-'));
  const inp = path.join(d, 'in.mp4'), out = path.join(d, 'out.mp4');
  execFileSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=24:d=6', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.02:d=6:r=44100', '-f', 'lavfi', '-i', 'sine=f=60:r=44100:d=6',
    '-filter_complex', '[2:a]volume=0.25[h];[1:a][h]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', inp]);
  const det = JSON.parse(execFileSync(PY, [path.join(__dirname, '..', 'dehum.py'), inp, FF]).toString());
  const dec = decide(det);
  assert.ok(dec.clean && dec.tones.some((h) => Math.abs(h - 60) < 12), JSON.stringify(det));
  execFileSync(FF, ['-v', 'error', '-y', '-i', inp, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', filterFor(dec.tones), '-c:a', 'aac', '-b:a', '192k', out]);
  const after = JSON.parse(execFileSync(PY, [path.join(__dirname, '..', 'dehum.py'), out, FF]).toString());
  assert.strictEqual(after.hum.length, 0, JSON.stringify(after));
  const md5 = (f) => execFileSync(FF, ['-v', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
  assert.strictEqual(md5(out), md5(inp));
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\ndehum: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
