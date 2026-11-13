// 🔇 /api/clone-v2 passes on the download's "picture only" verdict as silentSource (v2-1.12.1; toolscan 2026-11-13).
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(process.env.IF_SRC_ROOT || path.join(__dirname, '..'), 'v2/cloneV2.js'), 'utf8');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('  x ' + m); } };
const a = src.indexOf('// 1. Download (same helpers as v1).'), b = src.indexOf("mark('download')", a);
ok(a > 0 && b > a, 'download block found');
const dl = src.slice(a, b);
ok(/const igDl = await downloadInstagramViaApify\(videoUrl, video\)/.test(dl), 'the download result is kept');
ok(/if \(igDl && igDl\.silent\) \{ silentSource = true;/.test(dl), 'a picture-only download sets silentSource');
ok(/let silentSource = false;/.test(dl), 'silentSource starts false');
const r = src.indexOf('success: true, version: V2_VERSION, durationSec:', b);
ok(r > 0 && /\.\.\.\(silentSource \? \{ silentSource: true \} : \{\}\)/.test(src.slice(r, r + 300)), 'the success response carries silentSource only when true');
if (fails) { console.error(`v2-silent-source: ${fails} failed`); process.exit(1); }
console.log('v2-silent-source: all passed');
