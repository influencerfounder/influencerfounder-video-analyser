#!/usr/bin/env node
// assetMedia.clipAudio — the per-clip "voice-over" and "background music" signals behind the
// tool's Assets clip filters. Music = loud where nobody speaks (a heuristic, labelled so in the UI).
const { clipAudio } = require('../assetMedia');
let p = 0, f = 0; const ok = (c, m) => { c ? p++ : (f++, console.log('  x ' + m)); };
const rms = (from, to, db) => Array.from({ length: Math.round((to - from) * 2) }, (_, i) => ({ t: from + i * 0.5, db }));
const segs = [{ start: 1, end: 3, text: 'hey this is the stash watch' }];
let r = clipAudio([0, 4], segs, rms(0, 4, -20));
ok(r.voiceover === true && /stash watch/.test(r.speech), 'speech inside the clip = voice-over with its words');
ok(r.music === true, 'loud outside the speech = background music');
r = clipAudio([4, 8], segs, rms(4, 8, -70));
ok(r.voiceover === false && r.music === false, 'silent clip without speech: no voice-over, no music');
r = clipAudio([4, 8], segs, rms(4, 8, -25));
ok(r.voiceover === false && r.music === true, 'loud clip without speech: music');
r = clipAudio([1, 3], segs, rms(1, 3, -20));
ok(r.voiceover === true && r.music === null, 'all speech, no quiet samples: music unknown (null), never guessed');
console.log(`asset-media: ${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
