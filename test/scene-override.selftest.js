#!/usr/bin/env node
// 🏟 SETTING OVERRIDE (v2.55.0, 2026-10-01) — the writer is told the new place, so the prompt and the
// tool's new-setting first frame agree. Executes the real cache-key function and the rule line.
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('  x ' + n + ' :: ' + e.message); } };
const ki = SRC.indexOf('function cloneJoinKey(b) {'), kj = SRC.indexOf('\n}\n', ki) + 2;
const key = new Function(SRC.slice(ki, kj) + '\nreturn cloneJoinKey;')();
t('a different setting is a different cache entry (never served the stadium prompt)', () => assert.notStrictEqual(key({ videoUrl: 'v', sceneOverride: 'courtside' }), key({ videoUrl: 'v' })));
t('the setting is read from the request, trimmed to 300', () => assert.ok(/const sceneOverride = String\(req\.body\.sceneOverride \|\| ''\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.slice\(0, 300\);/.test(SRC)));
const li = SRC.indexOf("(sceneOverride && !isBgSwap) ? `🏟 SETTING OVERRIDE");
const lj = SRC.indexOf("` : '',", li) + 1;
t('rule found inside the system-prompt list', () => assert.ok(li > 0 && lj > li && SRC.lastIndexOf('const sysSend = [', li) > 0));
const rule = (sceneOverride, isBgSwap) => new Function('sceneOverride', 'isBgSwap', 'return ' + SRC.slice(li, lj) + " : '';")(sceneOverride, isBgSwap);
t('with a setting: names it, keeps camera/timing/actions, re-dresses the bystanders', () => { const r = rule('courtside at an NBA game', false); assert.ok(r.includes('It takes place here: courtside at an NBA game.') && /same number, positions and live actions/.test(r) && /the camera, framing and distance, the timing/.test(r)); });
t('a named garment replaces ONLY that garment; trousers/shoes stay and are written out', () => { const r = rule('fashion show, a black tee', false); assert.ok(/replaces ONLY that garment/.test(r) && /trousers, shoes, jacket — stays exactly as the source shows it and is written out, never dropped/.test(r)); });
t('the event goes where the source has it — behind the camera, never behind the influencer', () => { const r = rule('fashion show', false); assert.ok(/GEOMETRY OF ATTENTION/.test(r) && /is BEHIND THE CAMERA, out of frame, and behind \[INFLUENCER\] are only more of the audience/.test(r)); });
t('without a setting: nothing (every other recreate is byte-identical)', () => assert.strictEqual(rule('', false), ''));
t('bgswap: nothing', () => assert.strictEqual(rule('courtside', true), ''));
console.log(`\n${fail ? 'x FAIL' : 'OK'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
