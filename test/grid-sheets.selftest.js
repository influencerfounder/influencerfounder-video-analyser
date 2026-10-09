#!/usr/bin/env node
// 🧩 GRID SHEETS — every contact sheet holds exactly the frames its label names (/toolscan 2026-10-09).
// ffmpeg's `tile` fills every cell of its grid, so `tile=4x2` took 8 consecutive frames while the
// label listed only `per` (5-7 for a 6-10 s source): 3 unlabelled frames per sheet, repeated at the
// start of the next one (measured with numbered test frames). The real loop is sliced from index.js
// at run time and run against a recording spawnSync; no ffmpeg runs here.
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

const a = SRC.indexOf('        const GRIDS = Math.max(1, Math.min(11, 20 - hookImgCount));');
const b = SRC.indexOf('        gridContent = parts;', a);
if (a < 0 || b < 0) throw new Error('anchor drifted: grid loop');
const loop = SRC.slice(a, b);

function run(frames, hookImgCount, fps = 8) {
  const calls = [];
  const spawnSync = (bin, args) => { calls.push(args); return { status: 0 }; };
  const fakeFs = { existsSync: () => true, readFileSync: () => Buffer.from('x') };
  const frameFiles = Array.from({ length: frames }, (_, i) => `frame-${i + 1}.jpg`);
  const parts = new Function('frameFiles', 'hookImgCount', 'fps', 'framesDir', 'path', 'fs', 'spawnSync', 'bin',
    loop + '\nreturn parts;')(frameFiles, hookImgCount, fps, '/tmp/x', path, fakeFs, spawnSync, 'ffmpeg');
  const sheets = calls.map((args, i) => {
    const vf = args[args.indexOf('-vf') + 1];
    const m = vf.match(/tile=(\d+)x(\d+)(?::nb_frames=(\d+))?/);
    const cells = Number(m[1]) * Number(m[2]);
    const used = m[3] ? Math.min(Number(m[3]), cells) : cells;   // without nb_frames, tile consumes every cell
    const start = Number(args[args.indexOf('-start_number') + 1]) - 1;
    const label = parts.filter(p => p.type === 'text' && /^Sheet \d+:/.test(p.text))[i].text;
    const named = label.split(':')[1].split(',').length;
    return { start, used, named };
  });
  return sheets;
}

for (const [frames, hooks, why] of [[46, 9, 'per 5 (a ~6 s source with 9 hook frames)'], [60, 9, 'per 6'], [80, 9, 'per 8'], [20, 9, 'per 2'], [80, 0, 'per 8, no hook frames'], [33, 9, 'per 3, short last sheet']]) {
  t(`${frames} frames, ${why}: each sheet uses exactly the frames it names, none twice, none skipped`, () => {
    const s = run(frames, hooks);
    let next = 0;
    for (const x of s) {
      assert.strictEqual(x.used, x.named, `sheet at ${x.start}: ffmpeg takes ${x.used} frames, label names ${x.named}`);
      assert.strictEqual(x.start, next, 'sheets must follow on without overlap');
      next = x.start + x.used;
    }
    assert.strictEqual(next, frames, 'every frame lands on exactly one sheet');
  });
}

console.log(`\ngrid-sheets: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
