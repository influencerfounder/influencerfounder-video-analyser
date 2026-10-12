#!/usr/bin/env node
// /api/ad-assemble's filter graph (Ad Spy Video Ads, 2026-10-12): every labelled output must be consumed —
// an unconnected split output fails the whole ffmpeg graph (reviewer: logo on + end card 0 = always broken).
// The function is sliced out of the live index.js and run with stub caption helpers.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const a = src.indexOf('function adAssembleFilter('), b = src.indexOf("app.post('/api/ad-assemble'");
if (a < 0 || b < a) { console.log('  x adAssembleFilter not found'); process.exit(1); }
const drawtextCue = () => 'drawtext=x'; const captionYExpr = () => 'h*0.16';
const adAssembleFilter = new Function('drawtextCue', 'captionYExpr', src.slice(a, b) + '; return adAssembleFilter;')(drawtextCue, captionYExpr);
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log('  x ' + m)); };
for (const hasLogo of [true, false]) for (const end of [null, { seconds: 2 }]) for (const caps of [[], [{ start: 0, end: 1, text: 'x' }]]) {
  const { filter, out } = adAssembleFilter({ W: 720, H: 1280, caps, capFiles: caps.map(() => '/tmp/c'), fontPath: '/f.ttf', hasLogo, logoPos: 'tr', end, endFiles: end ? { headline: '/tmp/h', cta: '/tmp/c' } : {} });
  const chains = filter.split(';');
  const produced = chains.flatMap((c) => (c.match(/\[([a-z0-9]+)\]$/i) ? [] : []).concat((c.replace(/^(\[[^\]]+\])+/, '').match(/\[([a-z]\w*)\]/gi) || []).map((x) => x.slice(1, -1))));
  const consumed = chains.flatMap((c) => (c.match(/^(\[[^\]]+\])+/) || [''])[0].match(/\[([a-z]\w*)\]/gi) || []).map((x) => x.slice(1, -1));
  const unused = produced.filter((l) => l !== out && !consumed.includes(l));
  ok(!unused.length, `logo=${hasLogo} end=${!!end} caps=${caps.length}: unconnected outputs ${unused.join(',')}`);
  ok(out === (end ? 'vout' : caps.length || hasLogo ? (hasLogo ? 'vl' : 'vc') : 'v0'), `logo=${hasLogo} end=${!!end} caps=${caps.length}: final label ${out}`);
}
console.log(`ad-assemble: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
