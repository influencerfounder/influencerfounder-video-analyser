#!/usr/bin/env node
// 🩳 LEGS: BARE|COVERED — decides whether the two leg-showing identity portraits (fullBody,
// back) are sent with a generation. On an ink persona both are shot in athletic shorts so leg
// ink is visible; sent on a clothed scene they beat the wardrobe. MEASURED 2026-09-19: a Peaky
// Blinders recreate whose prompt said "a long overcoat falling to mid-shin over a dark pinstripe
// three-piece suit" came back in shorts, bare legs and the reference's own black trainers.
//
// The parse block is sliced out of index.js AT RUN TIME and executed, so this tests the real
// parser rather than a snapshot of it — a grep for a string would pass with the logic inverted.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

const grab = (start, end, label) => {
  const i = SRC.indexOf(start);
  if (i === -1) throw new Error('anchor drifted, start not found: ' + label);
  const j = SRC.indexOf(end, i);
  if (j === -1) throw new Error('anchor drifted, end not found: ' + label);
  return SRC.slice(i, j);
};

// the three header strips, exactly as they run in /api/clone
const parseSrc = grab("    let lane = 'AUTHENTIC';", '    // 🧠 WHY-IT-WENT-VIRAL REPORT', 'header parse block');

function runParse(basePrompt, { isBgSwap = false, promptStyle = 'realism' } = {}) {
  const ctx = { basePrompt, isBgSwap, promptStyle, console: { warn() {} } };
  vm.createContext(ctx);
  vm.runInContext(parseSrc + '\n;globalThis.__out = { lane, talkingHead, legsBare, basePrompt };', ctx);
  return ctx.__out;
}

const BODY = 'Kryfex walks across a marble lobby in a black overcoat.';

t('the normal header: LANE, TALKING, LEGS all strip and the body survives clean', () => {
  const r = runParse(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\n\n${BODY}`);
  assert.strictEqual(r.lane, 'AUTHENTIC');
  assert.strictEqual(r.talkingHead, false);
  assert.strictEqual(r.legsBare, false);
  assert.strictEqual(r.basePrompt, BODY, 'a header line leaked into the prompt body: ' + JSON.stringify(r.basePrompt.slice(0, 80)));
});

t('BARE is read as bare', () => {
  const r = runParse(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: BARE\n\nKryfex stands in the surf in navy swim shorts.`);
  assert.strictEqual(r.legsBare, true);
  assert.ok(!/LEGS:/.test(r.basePrompt), 'the LEGS line is still in the body');
});

t('a MISSING line means COVERED — withhold, never guess bare', () => {
  // The safe direction: a wrong BARE reproduces the shorts-under-a-suit bug; a wrong
  // COVERED only costs leg-ink fidelity on a scene that never showed legs.
  const r = runParse(`LANE: AUTHENTIC\nTALKING: NO\n\n${BODY}`);
  assert.strictEqual(r.legsBare, false);
  assert.strictEqual(r.basePrompt, BODY);
});

t('it is read BY NAME, so a model that moves the line still works', () => {
  const r = runParse(`LEGS: BARE\nLANE: HIGH-END\nTALKING: NO\n\n${BODY}`);
  assert.strictEqual(r.legsBare, true, 'LEGS on line 1 was not found');
});

t('and moving it does NOT break the two lines whose position is load-bearing', () => {
  // LANE and TALKING are anchored at the start of the remaining string. If the LEGS strip
  // ran first and left a blank line, or ran between them, these would silently go to default.
  const r = runParse(`LANE: HIGH-END\nTALKING: YES\nLEGS: BARE\n\n${BODY}`);
  assert.strictEqual(r.lane, 'HIGH-END', 'LANE was lost');
  assert.strictEqual(r.talkingHead, true, 'TALKING was lost');
  assert.strictEqual(r.legsBare, true);
});

t('a garbage value is not read as BARE', () => {
  const r = runParse(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: MAYBE\n\n${BODY}`);
  assert.strictEqual(r.legsBare, false);
});

t('the word "legs" inside the prompt body is never mistaken for the line', () => {
  const r = runParse(`LANE: AUTHENTIC\nTALKING: NO\n\nThe guard runs the wand along Kryfex's legs. LEGS are visible.`);
  assert.strictEqual(r.legsBare, false, 'prose matched the header regex');
});

// ── the rule is actually SENT, in every style that writes a 1:1 prompt ──
t('the header regex is ANCHORED — mid-sentence prose can never set it', () => {
  // Without ^...$ a sentence that happens to contain the token would flip the flag and, worse,
  // have a chunk spliced out of the prompt body. The line must start a line and end one.
  const prose = `LANE: AUTHENTIC\nTALKING: NO\n\nThe camera pans down to show his LEGS: BARE skin marked with ink below the coat.`;
  const r = runParse(prose);
  assert.strictEqual(r.legsBare, false, 'mid-sentence prose set the flag');
  assert.ok(/LEGS: BARE skin marked with ink/.test(r.basePrompt), 'the parser cut a hole in the prompt body');
});

t('LEGS_LINE_RULE exists and judges the influencer ALONE', () => {
  const m = SRC.match(/const LEGS_LINE_RULE = '([^\n]*)';/);
  assert.ok(m, 'LEGS_LINE_RULE is gone');
  const rule = m[1];
  assert.ok(/ALONE/.test(rule), 'the influencer-only scoping is gone — this is what a regex could never do');
  assert.ok(/unsure, answer COVERED/i.test(rule), 'the unsure-default is gone');
  for (const w of ['shorts', 'bikini', 'trousers', 'out of frame']) {
    assert.ok(new RegExp(w, 'i').test(rule), 'the rule no longer names: ' + w);
  }
});

t('it is sent in realism, original AND improve', () => {
  const realism = SRC.match(/const REALISM_CLONE_SYSTEM = [\s\S]{0,900}?\);/);
  assert.ok(realism && /LEGS_LINE_RULE/.test(realism[0]), 'realism (the DEFAULT style) does not ask for it');
  const orig = SRC.match(/const ORIGINAL_CLONE_SYSTEM_TAGGED = [\s\S]{0,900}?\);/);
  assert.ok(orig && /LEGS_LINE_RULE/.test(orig[0]), 'the original style does not ask for it');
  assert.ok(/Line 3: "LEGS: BARE" or "LEGS: COVERED"/.test(SRC), 'improve mode does not ask for it');
});

t('improve mode renumbered its remaining lines — no two labels share a number', () => {
  const nums = [...SRC.matchAll(/^Line (\d+): "([A-Z]+):/gm)].map(m => m[1] + ':' + m[2]);
  assert.ok(nums.length >= 8, 'the improve OUTPUT FORMAT block is gone, found ' + nums.length);
  const seen = new Set();
  for (const n of nums) { const k = n.split(':')[0]; assert.ok(!seen.has(k), 'two fields claim line ' + k); seen.add(k); }
});

t('the TALKING silent-default warning still exists', () => {
  // It was briefly parked inside `if (false)` while this was being written. That warning is
  // the only thing that surfaces a model which stops answering.
  assert.ok(/no TALKING: line in the model output/.test(SRC), 'the TALKING warning is gone');
  assert.ok(!/if \(false\) \{/.test(SRC), 'a dead `if (false)` block was left behind');
  assert.ok(/no LEGS: line in the model output/.test(SRC), 'the LEGS warning is gone');
});

t('legsBare travels in the response', () => {
  assert.ok(/^\s+legsBare,$/m.test(SRC), 'legsBare is parsed but never returned — the tool would never see it');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
