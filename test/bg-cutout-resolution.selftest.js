#!/usr/bin/env node
// ✂️ Cut-out backgrounds at 480p (half the fal price) are an explicit option; 720p stays the default (2026-10-20).
// Reads the live source: the route forwards only '480p'/'720p', runBgCutout sends that to VACE and prices it.
const fs = require('fs'), path = require('path');
const bg = fs.readFileSync(path.join(__dirname, '..', 'bgcutout.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let p = 0, f = 0; const ok = (c, m) => { c ? p++ : (f++, console.log('  x ' + m)); };
ok(/const vaceRes = ctx\.resolution === '480p' \? '480p' : '720p', vaceRate = vaceRes === '480p' \? 0\.04 : 0\.08;/.test(bg), 'runBgCutout picks 480p only when asked, 720p otherwise, with the matching rate');
const vace = bg.slice(bg.indexOf("'fal-ai/wan-vace-14b/inpainting'"), bg.indexOf("'fal-ai/wan-vace-14b/inpainting'") + 600);
ok(/resolution: vaceRes,/.test(vace) && !/resolution: '720p'/.test(vace), 'the VACE call sends the chosen resolution');
ok(/costUsd: Math\.round\(vaceSeconds \* vaceRate \* 100\) \/ 100, resolution: vaceRes/.test(bg), 'the cost estimate uses the chosen rate');
const route = idx.slice(idx.indexOf("app.post('/api/bg-cutout'"), idx.indexOf("app.post('/api/bg-cutout'") + 2000);
ok(/resolution: resolution === '480p' \? '480p' : '720p'/.test(route), 'the route forwards only 480p or 720p');
console.log(f ? `bg-cutout-resolution: ${f} FAILED, ${p} passed` : `bg-cutout-resolution: ${p} checks passed`);
process.exit(f ? 1 : 0);
