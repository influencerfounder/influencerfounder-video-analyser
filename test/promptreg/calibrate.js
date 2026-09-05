#!/usr/bin/env node
// Calibration report — reads the STORED baselinePrompt from every fixture and reports
// which assertion patterns fire. Costs nothing (no Claude calls), so it can be re-run
// freely while tuning checks.js.
//
// ⚠️ READ THIS BEFORE CHANGING A PATTERN. These 7 prompts are the CURRENT production
// output. A pattern firing here is one of exactly two things:
//   1. a real defect the suite should catch (cosanostra's stillness claim), or
//   2. a broken pattern (false positive) — tighten it in checks.js.
// It is never a reason to weaken the system prompt.
//
//   node test/promptreg/calibrate.js
const fs = require('fs'), path = require('path');
const DIR = __dirname, FIX = path.join(DIR, 'fixtures');
const RX = require('./checks.js');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'sources.json'), 'utf8'));

const rows = [];
for (const s of manifest.sources) {
  const f = path.join(FIX, `${s.slug}.json`);
  if (!fs.existsSync(f)) { rows.push({ slug: s.slug, missing: true }); continue; }
  const fx = JSON.parse(fs.readFileSync(f, 'utf8'));
  const p = fx.baselinePrompt || '';
  // ⚠️ An empty baseline is MISSING DATA, not a prompt that happens to describe nothing.
  // Counting it as a row would report "0 movement patterns" and read as a failing prompt.
  if (!p) { rows.push({ slug: s.slug, missing: true, halfBuilt: true, motion: fx.motion }); continue; }
  const hit = (list) => list.map(r => (p.match(r) || [])[0]).filter(Boolean);
  rows.push({
    slug: s.slug, motion: fx.motion, dur: fx.duration, words: p.split(/\s+/).filter(Boolean).length,
    // ⚠️ MUST use the same finders run.js asserts on, never the raw pattern lists -- a report
    // that disagrees with the gate it calibrates is worse than no report.
    appearance: hit(RX.appearance), params: hit(RX.params), crowd: RX.findCrowdFiller(p),
    pronoun: RX.findWrongPronoun(p, s.personaGender || fx.personaGender),
    movement: RX.findMovement(p).map(h => h.verb), still: RX.findStillness(p).map(h => h.phrase), staticCam: hit(RX.staticCamera),
    tempo: RX.findTempo(p).map(h => h.word),
  });
}

console.log('\nCALIBRATION — assertion patterns vs the CURRENT production prompts\n');
console.log('slug             motion   dur   words  appear params crowd  pron   moves  STILL  staticCam  TEMPO');
console.log('─'.repeat(88));
for (const r of rows) {
  if (r.missing) { console.log(`${r.slug.padEnd(16)} ${r.halfBuilt ? '<video + motion captured, ANALYSIS FAILED — re-run builder>' : '<fixture not built yet>'}`); continue; }
  const n = a => String(a.length).padStart(3);
  console.log(
    `${r.slug.padEnd(16)} ${String(r.motion).padStart(6)} ${String(r.dur).padStart(5)} ${String(r.words).padStart(6)}  ` +
    `${n(r.appearance)}    ${n(r.params)}   ${n(r.crowd)}   ${n(r.pronoun)}   ${n(r.movement)}   ${n(r.still)}    ${n(r.staticCam)}      ${n(r.tempo)}`
  );
}

console.log('\nDETAIL — every hit, so a false positive is visible rather than a number:');
for (const r of rows) {
  if (r.missing) continue;
  const bad = [];
  if (r.appearance.length) bad.push(`  appearance : ${JSON.stringify(r.appearance)}`);
  if (r.pronoun.length) bad.push(`  pronoun    : ${JSON.stringify(r.pronoun)}`);
  if (r.params.length)     bad.push(`  params     : ${JSON.stringify(r.params)}`);
  if (r.crowd.length)      bad.push(`  crowd      : ${JSON.stringify(r.crowd)}`);
  if (r.still.length)      bad.push(`  STILLNESS  : ${JSON.stringify(r.still)}`);
  if (r.staticCam.length)  bad.push(`  staticCam  : ${JSON.stringify(r.staticCam)} (informational)`);
  // ⚠️ Baselines predate the 2026-09-05 tempo rule, so hits here are the OLD behaviour, not false
  // positives — what matters is that none of them is a camera move (calibration of the exclusion).
  if (r.tempo.length)      bad.push(`  TEMPO      : ${JSON.stringify(r.tempo)} (pre-rule baseline; must not be camera moves)`);
  if (!r.movement.length)  bad.push(`  ⚠ NO MOVEMENT DESCRIBED AT ALL`);
  if (bad.length) console.log(`\n${r.slug} (motion ${r.motion}):\n${bad.join('\n')}`);
}

// ⭐ The threshold question, answered from the data rather than guessed.
const built = rows.filter(r => !r.missing);
const withStill = built.filter(r => r.still.length);
const motions = built.map(r => r.motion).sort((a, b) => a - b);
console.log('\n' + '─'.repeat(88));
console.log(`sources built        : ${built.length} of ${manifest.sources.length}`);
console.log(`motion range         : ${motions[0]} … ${motions[motions.length - 1]}`);
console.log(`carry a STILLNESS claim: ${withStill.length} — ${withStill.map(r => `${r.slug}(${r.motion})`).join(', ') || 'none'}`);
console.log(`
MOTION GATE — SETTLED 2026-09-04, this report is the evidence:
  The stillness rule is UNCONDITIONAL. A gate ("assert only when motion > X") is meaningful
  only if some real source sits below X; the lowest measured here is ${motions[0]}, so any
  gate below that can never be false. The freeze case measured 0.862 and genuinely moves —
  the bug was the prompt calling it still, not the source being still.

  ⚠️ RE-OPEN THIS if a genuinely static source is ever added: the STILL column would then
  show a hit on a source that is NOT broken. That is the signal to set a real gate from
  that source's measured motion — and the only thing that should ever reintroduce one.`);
