#!/usr/bin/env node
// 😏 SIGNATURE ENDING (2.100.0 / v2-1.12.0, Video Quality Lab case 2026-11-12-01). An influencer's own closing beat
// (Kryfex: a confident smile into the camera) is added ONLY where the writer that watched the source judged it fits
// (R17: the trigger is the observer) and ONLY for an influencer whose field is set (never a template default).
// Classic: the ENDING: line is sliced out of index.js and executed. NEW: the real compiler.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { compile, RULES, signaturePhrase, endingFits } = require('../v2/compile');
const { writerSystem, WRITER_RULES } = require('../v2/spec');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };

// ── Classic (v1) line ────────────────────────────────────────────────────────────────────────
const i = SRC.indexOf("    let lane = 'AUTHENTIC';"), j = SRC.indexOf('    // 🧠 WHY-IT-WENT-VIRAL REPORT', i);
if (i < 0 || j < 0) { console.log('anchor drifted'); process.exit(1); }
const parseSrc = SRC.slice(i, j);
function run(basePrompt) {
  const ctx = { basePrompt, isBgSwap: false, promptStyle: 'realism', console: { warn() {} } };
  vm.createContext(ctx);
  vm.runInContext(parseSrc + '\n;globalThis.__out = { closingSmileFits, chestOpen, basePrompt };', ctx);
  return ctx.__out;
}
const BODY = 'Kryfex walks up to the camera holding the black holdall and stops.';
t('ENDING: FITS read and stripped', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\nCHEST: COVERED\nFOREARMS: BARE\nENDING: FITS\n\n${BODY}`);
  assert.strictEqual(r.closingSmileFits, true); assert.strictEqual(r.chestOpen, false); assert.strictEqual(r.basePrompt, BODY);
});
t('ENDING: NO read as false (negative case), body clean', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\nCHEST: COVERED\nFOREARMS: COVERED\nENDING: NO (walks away)\n\n${BODY}`);
  assert.strictEqual(r.closingSmileFits, false); assert.strictEqual(r.basePrompt, BODY);
});
t('missing line → null (the tool adds nothing)', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\n\n${BODY}`);
  assert.strictEqual(r.closingSmileFits, null); assert.strictEqual(r.basePrompt, BODY);
});
t('a decorated, lowercase line is still read and stripped', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\n**ending: fits**\n\n${BODY}`);
  assert.strictEqual(r.closingSmileFits, true); assert.strictEqual(r.basePrompt, BODY);
});
t('a sentence in the prompt is never read as the line', () => {
  const r = run(`LANE: AUTHENTIC\nTALKING: NO\nLEGS: COVERED\n\nKryfex reads a sign that says ENDING: FITS.`);
  assert.strictEqual(r.closingSmileFits, null);
});
t('the rule is sent to the writer (not on a background swap) and returned', () => {
  assert.ok(/!isBgSwap \? ENDING_LINE_RULE : ''/.test(SRC));
  assert.ok(/forearmsBare,\n\s+closingSmileFits,/.test(SRC));
  assert.ok(/never write a closing smile into the prompt yourself/.test(SRC));
});

// ── NEW (v2) compiler ────────────────────────────────────────────────────────────────────────
const SIG = 'a confident, sexy smile straight into the camera';
const spec = (ending, lastVisible = true) => ({
  look: 'phone', outfit: { top_name: 'a black tee' }, ...(ending ? { ending } : {}),
  shots: [
    { start: 0, size: 'medium', camera: { move: 'fixed' }, main_events: ['walks toward the camera', 'stops'], end_state: 'MAIN stands facing the camera' },
    { start: 4, cut_before: true, size: 'close-up', camera: { move: 'fixed' }, main_visible: lastVisible, main_events: lastVisible ? ['lifts the bag'] : [], end_state: 'MAIN holds the bag at the chest' },
  ],
});
const FITS = { main_face: 'toward camera', closing_smile: 'fits', why: 'calm finished pose' };
const opts = (o = {}) => ({ name: 'Kryfex', gender: 'male', cuts: [4], durationSec: 7, model: 'wan', ...o });
const LINE = /In the final second Kryfex ends with a confident, sexy smile straight into the camera\./;

t('fits + field set → ONE sentence, in the last shot, after its end state', () => {
  const p = compile(spec(FITS), opts({ signatureEnding: SIG })).prompt;
  assert.strictEqual((p.match(/final second/g) || []).length, 1);
  const shot2 = p.slice(p.indexOf('Shot 2'));
  assert.ok(LINE.test(shot2), shot2);
  assert.ok(shot2.indexOf('End of the shot') < shot2.indexOf('final second'));
  assert.ok(!/smile/.test(p.slice(0, p.indexOf('Shot 2'))), 'the hook is never touched');
});
t('Seedance gets the same sentence', () => assert.ok(LINE.test(compile(spec(FITS), opts({ model: 'seedance', signatureEnding: SIG })).prompt)));
t('NEGATIVE: writer said "no" → 0 characters', () => {
  const a = compile(spec({ main_face: 'hidden', closing_smile: 'no', why: 'walks away' }), opts({ signatureEnding: SIG })).prompt;
  const b = compile(spec({ main_face: 'hidden', closing_smile: 'no' }), opts()).prompt;
  assert.strictEqual(a, b); assert.ok(!/smile|final second/.test(a));
});
t('NEGATIVE: no field set (Dorzy, Leilaa) → byte-identical to before, even when it fits', () => {
  assert.strictEqual(compile(spec(FITS), opts({ name: 'Dorzy', gender: 'female' })).prompt, compile(spec(null), opts({ name: 'Dorzy', gender: 'female' })).prompt);
  assert.ok(!/final second/.test(compile(spec(FITS), opts({ signatureEnding: '' })).prompt));
});
t('NEGATIVE: no ending judgement (an older stored spec) → nothing', () => assert.ok(!/final second/.test(compile(spec(null), opts({ signatureEnding: SIG })).prompt)));
t('NEGATIVE: "fits" but the face absent/hidden, or MAIN not in the last shot → nothing', () => {
  assert.ok(!/final second/.test(compile(spec({ main_face: 'absent', closing_smile: 'fits' }), opts({ signatureEnding: SIG })).prompt));
  assert.ok(!/final second/.test(compile(spec({ main_face: 'hidden', closing_smile: 'fits' }), opts({ signatureEnding: SIG })).prompt));
  assert.ok(!/final second/.test(compile(spec(FITS, false), opts({ signatureEnding: SIG })).prompt));
});
t('NEGATIVE: product-only runs never get it', () => assert.ok(!/final second/.test(compile(spec(FITS), opts({ productOnly: true, productName: 'the bag', signatureEnding: SIG })).prompt)));
t('a one-take video gets it on its last phase', () => {
  const s = spec(FITS); s.shots[1].cut_before = false;
  const p = compile(s, opts({ cuts: [], signatureEnding: SIG })).prompt;
  assert.strictEqual((p.match(/final second/g) || []).length, 1);
  assert.ok(p.lastIndexOf('final second') > p.indexOf('[4-7s]'));
});
t('the phrase is cleaned: tempo words dropped (R5), "ends with" not doubled, junk refused', () => {
  assert.strictEqual(signaturePhrase('Ends with a slowly growing confident smile.'), 'a growing confident smile');
  assert.strictEqual(signaturePhrase('x'.repeat(130)), '');
  assert.strictEqual(signaturePhrase('a smile {Image 1}'), '');
  assert.strictEqual(signaturePhrase(null), '');
});
t('endingFits reads only "fits"', () => {
  assert.strictEqual(endingFits({ ending: FITS }), true);
  assert.strictEqual(endingFits({ ending: { closing_smile: 'FITS', main_face: 'visible' } }), true);
  assert.strictEqual(endingFits({ ending: { closing_smile: 'maybe' } }), false);
  assert.strictEqual(endingFits({}), false);
});
t('the writer is asked, and told never to write the smile into the plan', () => {
  const w = writerSystem({ personaGender: 'male' });
  assert.ok(/"ending":\{"main_face"/.test(w) && /"closing_smile":"fits\|no"/.test(w));
  assert.ok(/never add a smile or a look to "main_events" or "end_state"/.test(w));
  assert.ok(WRITER_RULES.closingLook && RULES.signatureEnding);
});
t('/api/compile-v2 passes the field through', () => {
  const cv = fs.readFileSync(path.join(__dirname, '..', 'v2', 'cloneV2.js'), 'utf8');
  assert.ok(/signatureEnding: typeof b\.signatureEnding === 'string' \? b\.signatureEnding\.slice\(0, 160\) : ''/.test(cv));
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
