// test/tempvid-audio.selftest.js — /api/temp-video keeps Instagram's sound (2.77.0, 2026-10-11).
// A licensed-music reel's best rendition has no audio stream; downloadInstagramViaApify returns the other
// rendition as audioPath. /api/clone used it, /api/temp-video threw it away — so a saved reel's kept copy
// (InfluencerFounder-tool savedLinkMedia.js) played silent and its script came back empty.
const fs = require('fs'); const path = require('path');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  x ' + m); } };
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const a = src.indexOf("app.post('/api/temp-video'"); const b = src.indexOf("app.get('/api/temp-video", a);
const block = src.slice(a, b > a ? b : a + 6000);
ok(/const igDl = await downloadInstagramViaApify\(videoUrl, outputPath\)/.test(block), 'temp-video keeps the Instagram download result');
ok(/if \(igDl && igDl\.audioPath\)/.test(block) && /'-map', '0:v:0', '-map', '1:a:0', '-c', 'copy'/.test(block), 'a separate audio rendition is muxed in losslessly (-c copy)');
ok(/fs\.unlinkSync\(igDl\.audioPath\)/.test(block), 'the .audiosrc file is cleaned up');
console.log(`tempvid-audio: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
