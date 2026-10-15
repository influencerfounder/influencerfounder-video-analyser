#!/usr/bin/env node
// 🔍 Focus blur after generation (2026-10-14): where the soft moment goes, pinned on three REAL takes
// measured with subjectmotion.py that day. Mike approved the angry-grandmother take with the blur at
// 0.5–1.05 s ("before the action … around 1 second"), so the chooser must land in that spot.
const assert = require('assert');
const { pickBlurWindow, actionOnset, blurFilter } = require('../focusblur');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
const FX = {"mad": {"motion": [null, 6.434, 10.742, 6.901, 15.296, 16.944, 17.317, 14.77, 15.783, 16.256, 17.318, 18.591, 22.463, 21.744, 20.104, 19.093, 23.149, 21.197, 15.489, 15.424, 30.04, 22.865, 27.537, 27.198, 4.887, 6.582, 9.368, 12.999, 18.09, 19.537, 39.653, 29.764, 48.177, 41.51, 17.174, 34.684, 12.599, 10.918, 6.821, 12.708, 8.437, 3.925, 7.072, 4.745, 3.409, 9.134, 6.729], "cuts": [5.3]}, "monfinal": {"motion": [null, 2.178, 3.381, 1.804, 3.741, 2.565, 2.076, 3.886, 3.661, 4.83, 6.111, 6.673, 6.62, 6.593, 6.398, 8.986, 22.381, 40.39, 25.285, 53.008, 19.569, 17.048, 14.387, 17.461, 8.386, 16.291, 11.901, 18.507, 17.442, 25.663, 13.128, 11.384, 16.871, 21.428, 12.36, 20.956, 16.68, 24.178, 23.163, 11.89, 18.071, 10.04, 18.614, 22.192, 15.028, 11.969, 14.351], "cuts": [1.666667, 1.833333]}, "gwfinal": {"motion": [null, 4.756, 7.067, 2.915, 7.638, 6.282, 3.879, 112.311, 11.826, 18.886, 18.053, 14.805, 21.381, 11.552, 29.628, 22.871, 24.473, 25.259, 28.903, 29.607, 35.232, 33.975, 15.926, 11.428, 13.008, 9.946, 20.197, 19.389, 20.824, 20.443, 19.794, 20.834, 23.803, 20.938, 27.717, 27.263, 27.203, 7.15, 6.786, 6.961, 25.929, 32.383, 28.895, 7.424, 20.159, 7.189, 27.581], "cuts": [0.633333, 4, 7.966667, 12.3, 13.966667]}};
const m = (k) => FX[k].motion.map((v) => (v === null ? NaN : v));

t('angry grandmother (7 s): soft just before she turns, sharp again as the outburst starts', () => {
  assert.strictEqual(actionOnset(m('mad')), 0.5);
  const w = pickBlurWindow({ duration: 7, motion: m('mad'), cuts: FX.mad.cuts });
  assert.ok(w && w.from >= 0.4 && w.from <= 0.6 && w.to <= 1.15, JSON.stringify(w));
});
t('a window never sits on or next to a cut', () => {
  const w = pickBlurWindow({ duration: 21, motion: m('gwfinal'), cuts: FX.gwfinal.cuts });
  assert.ok(w, 'found one');
  for (const c of FX.gwfinal.cuts) assert.ok(!(c > w.from - 0.2 && c < w.to + 0.2), 'clear of the cut at ' + c + ': ' + JSON.stringify(w));
});
t('Monaco: the cut-blocked spot before the action falls back to the calm car seconds, early', () => {
  const w = pickBlurWindow({ duration: 10, motion: m('monfinal'), cuts: FX.monfinal.cuts });
  assert.ok(w && w.to <= 1.5, JSON.stringify(w));
});
t('close-ups passed in as avoid are never blurred; all close-up → nothing', () => {
  const w = pickBlurWindow({ duration: 7, motion: m('mad'), cuts: [], avoid: [[0, 1.2]] });
  assert.ok(w && w.from >= 1.2, JSON.stringify(w));
  assert.strictEqual(pickBlurWindow({ duration: 7, motion: m('mad'), cuts: [], avoid: [[0, 7]] }), null);
});
t('the opening frame stays sharp and the moment is early (never past 4 s when an early spot exists)', () => {
  for (const k of ['mad', 'gwfinal', 'monfinal']) {
    const w = pickBlurWindow({ duration: k === 'gwfinal' ? 21 : k === 'mad' ? 7 : 10, motion: m(k), cuts: FX[k].cuts });
    assert.ok(w.from >= 0.4 && w.from <= 4, k + ' ' + JSON.stringify(w));
  }
});
t('reviewer probes: never moved later into the action, never on unmeasured or busy seconds', () => {
  const m1 = [NaN]; for (let i = 1; i < 80; i++) m1.push(i < 10 ? 3 : 20);
  const w1 = pickBlurWindow({ duration: 8, motion: m1, cuts: [0.85] });
  assert.ok(w1 === null || w1.to <= 1.3, 'a cut-blocked calm opening must not push the blur into the action: ' + JSON.stringify(w1));
  const m2 = [NaN]; for (let i = 1; i < 60; i++) m2.push(20);
  assert.strictEqual(pickBlurWindow({ duration: 12, motion: m2, cuts: [], avoid: [[0, 6]] }), null, 'no calm, nothing measured past 6 s → none');
});
t('too short a video gets nothing', () => assert.strictEqual(pickBlurWindow({ duration: 1.2, motion: [] }), null));
t('the filter is three blur stages over 0.55 s and nothing else', () => {
  const f = blurFilter({ from: 0.5 });
  assert.strictEqual((f.match(/gblur=/g) || []).length, 3, f);
  assert.ok(/between\(t,0\.5,0\.6\)/.test(f) && /between\(t,0\.95,1\.05\)/.test(f), f);
});
t('/api/focus-blur measures people (camera removed), not frame difference, and copies the audio', () => {
  const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const body = SRC.slice(SRC.indexOf("app.post('/api/focus-blur'"), SRC.indexOf("app.post('/api/ad-assemble'"));
  assert.ok(/subjectmotion\.py/.test(body) && !/tblend/.test(body), 'subject motion');
  assert.ok(/'-c:a', 'copy'/.test(body), 'audio untouched');
  assert.ok(/skipped: true/.test(body), 'nothing fits → the caller keeps the original');
});

// ── 🎲 Randomized focus (2026-10-15, Mike's five points) ──
const { planFocusBlur, planFilter } = require('../focusblur');
const long = [NaN]; for (let i = 1; i < 120; i++) long.push((i >= 30 && i < 45) || (i >= 70 && i < 80) ? 25 : 6);  // 12 s, two bursts of action
const runMany = (opts, n = 400, withMemory = true) => {
  const out = []; let recent = [];
  for (let s = 1; s <= n; s++) {
    const p = planFocusBlur({ ...opts, seed: s, recent: withMemory ? recent : [] });
    out.push(p); recent = [{ count: p.count, events: p.events }].concat(recent).slice(0, 5);
  }
  return out;
};
t('1. strength: never above the reel\'s deepest (sigma 2.7), mostly mild, sometimes deep', () => {
  const ev = runMany({ duration: 12, motion: long, cuts: [] }).flatMap((p) => p.events);
  assert.ok(ev.length > 200);
  assert.ok(ev.every((e) => e.peak >= 0.9 && e.peak <= 2.7), 'peak range');
  const deep = ev.filter((e) => e.depth === 'deep').length / ev.length;
  assert.ok(deep > 0.2 && deep < 0.5, 'deep share ' + deep);
  for (const e of ev.slice(0, 50)) for (const m of planFilter([e]).matchAll(/sigma=([0-9.]+)/g)) assert.ok(Number(m[1]) <= 2.7, planFilter([e]));
});
t('2. shape: a quick drop, a hold at the peak, then focus returning in falling steps', () => {
  const e = { from: 1, drop: 0.08, hold: 0.3, recover: 0.45, peak: 2.4 };
  const sig = [...planFilter([e]).matchAll(/sigma=([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(sig, [1.2, 2.4, 1.56, 0.96, 0.48]);
  assert.ok(/gte\(t,1\)\*lt\(t,1\.08\)/.test(planFilter([e])) && /gte\(t,1\.38\)\*lt\(t,1\.53\)/.test(planFilter([e])), planFilter([e]));
});
t('2b. no frame ever gets two blurs stacked (real frame times at 24 and 30 fps), so the peak never passes 2.7', () => {
  // Evaluates each segment's enable exactly as ffmpeg does, on the frame timestamps of real encodes.
  const segs = (f) => [...f.matchAll(/sigma=([0-9.]+):enable='gte\(t,([0-9.]+)\)\*lt\(t,([0-9.]+)\)'/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  let worst = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    const p = planFocusBlur({ duration: 12, motion: long, cuts: [], seed });
    const sg = segs(planFilter(p.events));
    for (const [tb, fps] of [[15360, 30], [12288, 24]]) for (let n = 0; n < 12 * fps; n++) {
      const t = Math.round(n * tb / fps) / tb;
      const on = sg.filter(([, x, y]) => t >= x && t < y);
      assert.ok(on.length <= 1, `seed ${seed} t=${t}: ${on.length} blurs stacked`);
      if (on.length) worst = Math.max(worst, on[0][0]);
      if (n === 0) assert.strictEqual(on.length, 0, 'frame 0 is never blurred');
    }
  }
  assert.ok(worst <= 2.7 && worst > 2, 'worst ' + worst);
});
t('3. count: some none, most one, some two — and never "none" or "two" twice in a row', () => {
  const ps = runMany({ duration: 12, motion: long, cuts: [] });
  const c = [0, 0, 0]; ps.forEach((p) => c[p.count]++);
  assert.ok(c[0] > 30 && c[0] < 140 && c[1] > 180 && c[2] > 30, JSON.stringify(c));
  for (let i = 1; i < ps.length; i++) {
    assert.ok(!(ps[i].count === 0 && ps[i - 1].count === 0), 'two nones in a row at ' + i);
    assert.ok(!(ps[i].count === 2 && ps[i - 1].count === 2), 'two twos in a row at ' + i);
  }
});
t('4. where: spread over the first two thirds, never the opening frame, a cut, an avoid range or the action', () => {
  const cuts = [5.0], avoid = [[6.5, 7.5]];
  const ps = runMany({ duration: 12, motion: long, cuts, avoid });
  const ev = ps.flatMap((p) => p.events);
  const meanAt = (a, b) => { const xs = long.slice(Math.floor(a * 10), Math.ceil(b * 10)).filter(Number.isFinite); return xs.reduce((s, v) => s + v, 0) / xs.length; };
  for (const e of ev) {
    assert.ok(e.from >= 0.4 && e.to <= 8 + 1e-9, 'in [0.4, 2/3]: ' + JSON.stringify(e));
    assert.ok(!(5.0 > e.from - 0.2 && 5.0 < e.to + 0.2), 'clear of the cut: ' + JSON.stringify(e));
    assert.ok(!(e.from < 7.5 && e.to > 6.5), 'clear of the close-up: ' + JSON.stringify(e));
    if (!/before the action/.test(e.reason)) assert.ok(meanAt(e.from, e.to) < 10, 'not on the action: ' + JSON.stringify(e));
  }
  const seconds = new Set(ev.map((e) => Math.floor(e.from)));
  assert.ok(seconds.size >= 4, 'spread over at least 4 different seconds: ' + [...seconds]);
  ps.filter((p) => p.count === 2).forEach((p) => assert.ok(p.events[1].from - p.events[0].to >= 1.5 - 1e-9, 'two moments apart: ' + p.reason));
});
t('4b. the angry grandmother: the approved "just before the action" spot stays one of the options', () => {
  const ps = runMany({ duration: 7, motion: m('mad'), cuts: FX.mad.cuts }, 300);
  const before = ps.flatMap((p) => p.events).filter((e) => /before the action/.test(e.reason));
  assert.ok(before.length > 30, 'picked ' + before.length + '/300');
  before.forEach((e) => assert.ok(e.from >= 0.4 && e.to <= 1.4 + 1e-9, JSON.stringify(e)));
  assert.ok(ps.flatMap((p) => p.events).some((e) => !/before the action/.test(e.reason)), 'and not always');
});
t('5. memory: a spot the last videos used is picked far less often', () => {
  const free = runMany({ duration: 12, motion: long, cuts: [] }, 400, false).flatMap((p) => p.events);
  const share = (evs) => evs.filter((e) => Math.abs(e.from - 1.0) < 0.7).length / evs.length;
  const recent = [{ count: 1, events: [{ from: 1.0, depth: 'mild' }] }, { count: 1, events: [{ from: 1.1, depth: 'deep' }] }];
  const steered = []; for (let s = 1; s <= 400; s++) steered.push(...planFocusBlur({ duration: 12, motion: long, cuts: [], seed: s, recent }).events);
  assert.ok(share(steered) < share(free) * 0.6, `near 1.0 s: ${share(steered).toFixed(2)} with memory vs ${share(free).toFixed(2)} without`);
});
t('5b. memory: three of the same depth in a row → the next one is the other depth', () => {
  const recent = [1, 2, 3].map(() => ({ count: 1, events: [{ from: 2, depth: 'deep' }] }));
  for (let s = 1; s <= 50; s++) { const p = planFocusBlur({ duration: 12, motion: long, cuts: [], seed: s, recent }); if (p.events.length) assert.strictEqual(p.events.find((e) => e.from === Math.min(...p.events.map((x) => x.from))) && p.events.some((e) => e.depth === 'mild'), true); }
});
t('the route plans with planFocusBlur + planFilter, passes `recent`, and measures beyond 8 s', () => {
  const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const body = SRC.slice(SRC.indexOf("app.post('/api/focus-blur'"), SRC.indexOf("app.post('/api/ad-assemble'"));
  assert.ok(/planFocusBlur\(\{[^}]*recent/.test(body), 'recent passed');
  assert.ok(/planFilter\(plan\.events\)/.test(body) && !/blurFilter\(/.test(body), 'new filter only');
  assert.ok(/Math\.min\(12, duration \* 2 \/ 3/.test(body), 'measured over two thirds');
});
console.log('\nfocusblur: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
