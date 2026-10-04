#!/usr/bin/env node
// 🪝 HOOK-FIRST STYLE (v2.48.0, 2026-10-01) — the owner-only test arm.
//
// Executes the REAL code read out of index.js at run time (same discipline as hook-window.selftest:
// a frozen copy once produced a false pass). Pins: (1) measured cuts are parsed and merged
// correctly, (2) the hook frames sit INSIDE the first shot, (3) the rule carries the measured
// decimal times exactly and the Wan multi-shot shape, (4) a source with no cut gets timed phases +
// "Generate single shot" and never a "Shot"/transition instruction, (5) every other style is
// untouched — the rule is empty and SHOT_CUTS_RULE behaves as before.
const fs = require('fs'), path = require('path'), assert = require('assert');
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

// (1) cut parsing + merge, executed on a fake ffmpeg stderr
const parse = grab('        const raw = [...out.matchAll', "        console.log(`[clone] hookfirst measured cuts", 'cut parse');
const parseCuts = new Function('out', 'duration', `let measuredCuts;\n${parse}\nreturn measuredCuts;`);
const fake = 'pts_time:0.05 x pts_time:1.208333 y pts_time:2.916667 pts_time:3.05 pts_time:5.083 pts_time:9.10';
t('cuts are read off ffmpeg showinfo, rounded to 0.01 s', () => assert.deepStrictEqual(parseCuts(fake, 9.17).slice(0, 2), [1.21, 2.92]));
t('a cut within 0.3 s of the previous one is merged (a flash is one event)', () => assert.ok(!parseCuts(fake, 9.17).includes(3.05)));
t('cuts in the first/last 0.15 s are ignored', () => { const c = parseCuts(fake, 9.17); assert.ok(!c.includes(0.05) && !c.includes(9.1)); });
t('no cut found → an EMPTY list (a measured "none"), not null', () => assert.deepStrictEqual(parseCuts('nothing here', 9), []));

// (2) hook frames inside the first shot
const hookTsCode = grab('    const hookEnd = Math.min(', '    for (const ts of hookTs) {', 'hookTs');
const hookTs = new Function('promptStyle', 'duration', 'measuredCuts', `${hookTsCode}\nreturn hookTs;`);
t('hookfirst: all hook frames before the first cut (1.21 s), dense in the first second', () => { const h = hookTs('hookfirst', 9.17, [1.21, 2.92]); assert.ok(h.length >= 6 && h.every(x => x > 0 && x < 1.21), JSON.stringify(h)); });
t('hookfirst: at least 4 frames inside the first 0.6 s, so a short leg/hand movement spans several frames', () => { const h = hookTs('hookfirst', 9, []); assert.ok(h.filter(x => x <= 0.6).length >= 4, JSON.stringify(h)); });
t('hookfirst: frames sorted and never closer than 0.1 s', () => { const h = hookTs('hookfirst', 9, []); for (let i = 1; i < h.length; i++) assert.ok(h[i] - h[i-1] >= 0.1, JSON.stringify(h)); });
t('hookfirst with no cut: frames spread over the first 3 s', () => { const h = hookTs('hookfirst', 9, []); assert.ok(h[h.length - 1] > 2.5 && h[h.length - 1] < 3, JSON.stringify(h)); });
t('every other style keeps the fixed 0.3/1/2/3 s window', () => assert.deepStrictEqual(hookTs('realism', 9, [1.21]), [0.3, 1.0, 2.0, 3.0]));

// (3)-(5) the rule
const ruleCode = grab('    const cutList = (measuredCuts && measuredCuts.length)', '    const sysSend = [', 'HOOK_FIRST_RULE');
const rule = new Function('promptStyle', 'isBgSwap', 'measuredCuts', 'shotTarget', `${ruleCode}\nreturn HOOK_FIRST_RULE;`);
const multi = rule('hookfirst', false, [1.21, 2.92, 5.08, 7.04, 7.67], 9);
t('carries every measured cut as an exact decimal time', () => ['1.21s', '2.92s', '5.08s', '7.04s', '7.67s'].forEach(c => assert.ok(multi.includes(c), c)));
t('the writer is told to use the measured times EXACTLY, never its own estimate', () => assert.ok(/Use these EXACT decimal times as the shot boundaries — never estimate your own, never round them/.test(multi)));
t('names the hook (Shot 1 up to the first cut) without a transition', () => assert.ok(multi.includes('"Shot 1 [0-1.21s]" with no transition words')));
t('later shots use Wan\'s shape: Shot N [a-bs] Hard cut transition + camera state + end state', () => assert.ok(/Shot N \[a-bs\] Hard cut transition, <framing>, <camera state>: <one action>\. Ends with <end state>/.test(multi)));
t('the hook is the most precise part; later shots one short line each', () => assert.ok(/MOST PRECISE part/.test(multi) && /ONE line of 15-35 words/.test(multi)));
t('the hook is written as a MOMENT with real movement, never a pose', () => assert.ok(/Write the hook as a MOMENT, never a pose: name what \[INFLUENCER\]'s head, eyes and hands are already doing/.test(multi)));
t('EVERY visible movement in the hook, legs and feet included, never invented (2026-10-01)', () => assert.ok(/and EVERY other movement \[INFLUENCER\] makes in the hook, in order, for every part of the body the frame shows: arms, shoulders, torso, legs, knees and feet/.test(multi) && /never invent a movement the frames do not show/.test(multi)));
t('IF people are visible around the influencer, EACH gets an ongoing action (frozen crowd fix, 2026-10-02)', () => assert.ok(/IF other people are visible behind or around \[INFLUENCER\], give EACH one an ongoing action of their own that keeps going through the hook/.test(multi) && /nobody is frozen\./.test(multi)));
t('the outfit is restated as a fixed fact after the overall sentence', () => assert.ok(multi.includes('[INFLUENCER] wears this same outfit, fully dressed, in every shot.')));
t('every later shot line names the outfit again (3 of 10 takes lost it without this)', () => assert.ok(/name the outfit again inside that line in 2-4 words/.test(multi)));
t('the last shot ends with "no new action" (stops invented filler)', () => assert.ok(multi.includes('"no new action"')));
t('cuts past the clip length are dropped from the list', () => { const r = rule('hookfirst', false, [1.21, 9.5], 9); assert.ok(r.includes('1.21s') && !r.includes('9.5s')); });
const none = rule('hookfirst', false, [], 9);
t('no cut: one continuous take, timed phases, "Generate single shot."', () => assert.ok(/ONE continuous take/.test(none) && none.includes('"Generate single shot."') && /timed PHASES/.test(none)));
t('no cut: never instructs a Shot label or a transition (that is what made the 09-29 dissolve)', () => assert.ok(!/Shot N \[a-bs\] Hard cut/.test(none) && /do NOT write any transition word/.test(none)));
t('no-cut phases also restate the outfit', () => assert.ok(/naming the outfit again in 2-4 words whenever \[INFLUENCER\] is in it/.test(none)));
t('measurement unavailable: the writer reads cuts itself, says so', () => assert.ok(/measurement was unavailable/.test(rule('hookfirst', false, null, 9))));
t('every other style: the rule is EMPTY (byte-identical prompts)', () => { assert.strictEqual(rule('realism', false, [1.2], 9), ''); assert.strictEqual(rule('original', false, null, 9), ''); });
t('bgswap: the rule is empty', () => assert.strictEqual(rule('hookfirst', true, [1.2], 9), ''));
t('hookfirst never also gets SHOT_CUTS_RULE', () => assert.ok(SRC.includes("(shotCuts && !isBgSwap && promptStyle !== 'improve' && promptStyle !== 'hookfirst') ? SHOT_CUTS_RULE : ''")));
t('a wardrobe override reaches the system prompt and the cache key', () => { assert.ok(/\(wardrobe && !isBgSwap\) \? `👕 WARDROBE OVERRIDE — \[INFLUENCER\] does NOT wear the source person's top/.test(SRC)); assert.ok(/String\(b\.wardrobe \|\| ''\),\n[\s\S]{0,360}?\n  \]\);/.test(SRC)); });
t('hookfirst asks the writer whether the influencer is in the opening frame', () => assert.ok(/\(promptStyle === 'hookfirst' && !isBgSwap\) \? 'Also output, on its own line directly after the LEGS line, exactly "OPENING: SHOWN"/.test(SRC)));
{ // the parser, executed on real-shaped output
  const pc = grab('    let influencerInOpening = null;', '    // 🧠 WHY-IT-WENT-VIRAL REPORT', 'opening parse');
  const run = (txt) => new Function('basePrompt', pc + '\nreturn { influencerInOpening, basePrompt };')(txt);
  t('OPENING: ABSENT is read and stripped from the prompt', () => { const r = run('OPENING: ABSENT\nThe video opens on a bald man.'); assert.strictEqual(r.influencerInOpening, false); assert.ok(!/OPENING/.test(r.basePrompt)); });
  t('OPENING: SHOWN is read', () => assert.strictEqual(run('LEGS: COVERED\nOPENING: SHOWN\nx').influencerInOpening, true));
  t('no OPENING line → null (unknown), never "shown"', () => assert.strictEqual(run('The video opens.').influencerInOpening, null));
}
t('hookfirst is accepted by the whitelist and gets the realism layer', () => { assert.ok(SRC.includes("['original','realism','improve','hookfirst'].includes(req.body.promptStyle)")); assert.ok(SRC.includes("promptStyle === 'improve' || promptStyle === 'hookfirst') ? `${basePrompt} ${LANE_LAYERS[lane]}`")); });

t('frameMode grid (v2.62.0, default v2.64.0) joins the cache key and never reaches bgswap', () => {
  assert.ok(SRC.includes("const frameMode = req.body.frameMode === 'frames' ? '' : 'grid';"), 'grid is the DEFAULT since v2.64.0; frames is the opt-out');
  assert.ok(SRC.includes("b.frameMode === 'frames' ? 'frames' : 'grid',"));
  assert.ok(/The sheets are SMALL: read timing, movement and camera from them, but read clothing, printed text and logos from the full-size HOOK WINDOW frames/.test(SRC), 'print and logos come from the full-size frames (grid misread a tee 2026-10-04)');
  assert.ok(/if \(frameMode === 'grid' && !isBgSwap && frameFiles\.length\)/.test(SRC));
  assert.ok(SRC.includes("const subset = gridContent ? gridContent"));
});
t('shotLog gemini (v2.63.0) is off by default, joins the cache key, fails open and only adds a text block', () => {
  assert.ok(SRC.includes("const shotLogMode = req.body.shotLog === 'gemini' ? 'gemini' : '';"));
  assert.ok(SRC.includes("b.shotLog === 'gemini' ? 'gemini' : '',"));
  assert.ok(SRC.includes(".catch(e => ({ ok: false, error:"));
  assert.ok((SRC.match(/\.\.\.shotLogContent, \{ type: 'text', text: userFinal/g) || []).length === 3, 'the log reaches all three writer calls (Kie, fallback, Anthropic)');
  assert.ok(SRC.includes("shotLogContent = [...shotLogContent, { type: 'text', text: 'MEASURED TIMELINE"), 'the Gemini log is ADDED to the block, never overwrites the direction note');
  assert.ok(SRC.includes("const dirMode = req.body.dirMode === 'off' ? '' : 'screen';") && SRC.includes("b.dirMode === 'off' ? 'off' : 'screen',"), 'screen direction is the DEFAULT since v2.65.0 (opt-out off) and joins the cache key');
  assert.ok(/LEFT AND RIGHT: every "left" and "right" you write means the VIEWER\\'S screen left\/right/.test(SRC), 'the note names the viewer\'s screen');
});

t('timed lines are normalised to [a-bs] before any matcher reads them (v2.64.0)', () => {
  assert.ok(/hookGuard = \{ posed: false, revised: false, tempoRemoved: \[\] \};\n\s*\/\/[^\n]*\n\s*\{ const n = hookGuardLib\.normalizeTimedLines\(basePrompt\)/.test(SRC), 'first thing in the hookfirst block');
  assert.ok(SRC.includes('basePrompt = hookGuardLib.normalizeTimedLines(revised).text;'), 'and again on an accepted hook revision');
});

console.log(`\n${fail ? 'x FAIL' : 'OK'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
