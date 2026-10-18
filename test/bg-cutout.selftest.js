#!/usr/bin/env node
// ✂️ Background-only swap by cut-out (2026-10-18). Executes the REAL bgcutout.js helpers on synthetic
// frames: the people's solid core comes through unchanged, an old bright background is cleaned out of the
// edge (the "white line" Mike saw), cuts are found, short shots stay findable, light match is bounded.
const B = require('../bgcutout');
let p = 0, f = 0; const ok = (c, m) => { c ? p++ : (f++, console.log('  x ' + m)); };
const W = 64, H = 64, n = W * H;
const fill = (r, g, b) => { const a = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b; } return a; };
// a dark "person" square on a bright old background; soft 2-px edge in the mask
const src = fill(230, 220, 200), mask = new Uint8Array(n);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const d = Math.min(x - 16, 47 - x, y - 16, 47 - y);
  const a = d >= 2 ? 255 : d >= 0 ? Math.round(255 * (d + 1) / 3) : 0;
  mask[y * W + x] = a;
  if (a > 0) { const al = a / 255; for (let c = 0; c < 3; c++) src[(y * W + x) * 3 + c] = Math.round(20 * al + [230, 220, 200][c] * (1 - al)); }
}
const bg = fill(40, 35, 30);
const m = B.firmMatte(mask, mask, mask);
const neutral = { gainY: 1, dCb: 0, dCr: 0 };
const out = B.compositeFrame(src, bg, m, W, H, neutral);
// 1 — the solid core is the original pixel
let coreMax = 0; for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) for (let c = 0; c < 3; c++) coreMax = Math.max(coreMax, Math.abs(out[(y * W + x) * 3 + c] - src[(y * W + x) * 3 + c]));
ok(coreMax <= 1, `the person's core is unchanged (max diff ${coreMax})`);
// 2 — no bright rim: edge brighter than both the person (20) and the new background (40) = a visible rim
let rim = 0; for (let y = 14; y < 50; y++) for (const x of [15, 16, 17, 46, 47, 48]) rim = Math.max(rim, out[(y * W + x) * 3]);
ok(rim < 60, `edge decontamination removes the old bright background from the edge (brightest edge red ${rim})`);
// 3 — without decontamination the same edge WOULD be bright (proves the test can fail)
let naive = 0; for (let y = 14; y < 50; y++) for (const x of [16, 17, 46, 47]) { const i = y * W + x, al = mask[i] / 255; naive = Math.max(naive, Math.round(src[i * 3] * al + bg[i * 3] * (1 - al))); }
ok(naive >= 60, `a plain alpha paste leaves a bright rim (${naive}) — the case decontamination fixes`);
// 4 — cuts
const diffs = [3, 4, 3, 60, 4, 3, 5, 70, 4, 4];
ok(JSON.stringify(B.detectCuts(diffs, 11)) === '[0,4,8,11]', 'hard cuts found at the big jumps');
ok(JSON.stringify(B.detectCuts([3, 4, 3, 4], 5)) === '[0,5]', 'no cut in steady motion');
// 5 — light match is bounded and neutral when nothing changed
const same = B.lightParams([100, 100, 100], [100, 100, 100]);
ok(Math.abs(same.gainY - 1) < 1e-6 && Math.abs(same.dCb) < 1e-6 && Math.abs(same.dCr) < 1e-6, 'identical light → no change');
const huge = B.lightParams([20, 20, 20], [250, 250, 250]);
ok(huge.gainY <= 1.15 && huge.gainY >= 0.9, 'brightness gain capped to 0.90–1.15');
// 6 — VACE inputs: background greyed, core protected in the regenerate mask
const v = B.vaceInputs(src, mask, W, H);
ok(v.grey[0] === 128 && v.inv[0] === 255, 'background is grey and marked for regeneration');
ok(v.inv[32 * W + 32] === 0, "the person's core is never regenerated");
// 7 — a motion-blurred, half-transparent hand stays fairly solid after firming
const blur = new Uint8Array(n).fill(110);
ok(B.firmMatte(blur, blur, blur)[0] > 0.45, 'a 43% matte (motion blur) is firmed above 45%');
console.log(f ? `bg-cutout: ${f} FAILED, ${p} passed` : `bg-cutout: ${p} checks passed`);
process.exit(f ? 1 : 0);
