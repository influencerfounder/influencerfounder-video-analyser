#!/usr/bin/env node
// ✂️ The cut-out background prompt must describe the NEW place (2026-10-18): with one frame per shot,
// Claude once described the ORIGINAL station and dropped "Amsterdam", so the paid run came back as the
// station again. Executes the real lightMatchedPrompt with a scripted Anthropic reply.
const path = require('path');
const axiosPath = require.resolve('axios', { paths: [path.join(__dirname, '..')] });
let reply = '', sent = null, queue = null, calls = 0;
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (_u, body) => { sent = body; calls++; const t = queue && queue.length ? queue.shift() : reply; return { data: { content: [{ type: 'text', text: t }] } }; } } };
const { lightMatchedPrompt, namesPlace } = require('../bgcutout');
let p = 0, f = 0; const ok = (c, m) => { c ? p++ : (f++, console.log('  x ' + m)); };
const brief = 'an open-air Amsterdam canal-side shopping street in the evening, canal houses and a canal visible behind';
const frames = [{ shot: 1, jpeg: Buffer.from('x') }, { shot: 2, jpeg: Buffer.from('y') }];
(async () => {
  const warn = console.warn; console.warn = () => {};
  reply = JSON.stringify({ prompt: 'Interior transit concourse with tall sandstone-clad columns, polished grey stone floor, recessed ceiling spotlights, station hallway stretching into the distance.', negative: 'x', shots: [{ shot: 1, add: 'floor' }] });
  const a = await lightMatchedPrompt({ anthropicKey: 'k', brief, shotFrames: frames });
  ok(a.source === 'fallback' && /Amsterdam/.test(a.prompt), 'a prompt describing the original location is rejected; the brief leads instead');
  reply = JSON.stringify({ prompt: 'An Amsterdam canal-side shopping street at dusk with gabled canal houses, soft light, strong bokeh.', negative: 'water under people', shots: [{ shot: 2, add: 'cobblestone quay underfoot, canal far left' }] });
  const b = await lightMatchedPrompt({ anthropicKey: 'k', brief, shotFrames: frames });
  ok(b.source === 'claude' && b.shots[2] === 'cobblestone quay underfoot, canal far left', 'a prompt for the new place is kept with its per-shot ground note');
  const firstText = sent.messages[0].content[0];
  ok(firstText.type === 'text' && firstText.text.includes(brief), 'the brief is the FIRST thing Claude reads, before the frames');
  ok(sent.messages[0].content.filter((c) => c.type === 'image').length === 2, 'one image per shot is sent');
  ok(/never the place you see in the frames/.test(sent.system) && /solid ground/.test(sent.system), 'the system prompt separates the new place from the frames and requires solid ground');
  // 2026-10-19 guard rewrite (/toolscan §6.4): whole words, plurals folded, Claude's English place phrase
  ok(namesPlace('A sandy beach at sunset, soft light', 'een strand bij zonsondergang', 'sandy beach at sunset'), 'a Dutch brief answered in English passes via the English place phrase');
  ok(namesPlace('Snowy mountain range behind them', 'mountains in the snow', ''), 'singular/plural are the same word (mountains = mountain)');
  ok(!namesPlace('A busy parking garage, concrete pillars', 'a quiet park with trees', 'quiet park with trees'), '"park" is not found inside "parking"');
  ok(!namesPlace('Interior transit concourse with sandstone columns', 'een Amsterdamse grachtenstraat', 'Amsterdam canal street'), 'the original-station prompt still fails with a Dutch brief');
  ok(namesPlace('Soft bokeh', 'busy street at night', ''), 'a brief of stop words only is not checkable and passes');
  // the retry: wrong place first, right place second → Claude's answer is kept (with its shot lines), 2 calls
  const wrong = JSON.stringify({ place: 'Amsterdam canal street', prompt: 'Interior transit concourse with tall sandstone-clad columns and a polished grey stone floor, spotlights.', shots: [] });
  const right = JSON.stringify({ place: 'Amsterdam canal street', prompt: 'An Amsterdam canal street at dusk, gabled houses along the water, soft light, strong bokeh.', shots: [{ shot: 1, add: 'quay underfoot' }] });
  calls = 0; queue = [wrong, right];
  const c = await lightMatchedPrompt({ anthropicKey: 'k', brief: 'een Amsterdamse grachtenstraat', shotFrames: frames });
  ok(c.source === 'claude' && c.retried === true && c.shots[1] === 'quay underfoot' && calls === 2, 'a wrong place gets one retry and the second answer is kept (calls ' + calls + ')');
  ok(/wrong place/.test(sent.messages[0].content.slice(-1)[0].text), 'the retry tells Claude what it got wrong');
  // both wrong → fallback in the ENGLISH place words, never the raw Dutch brief
  calls = 0; queue = [wrong, wrong];
  const d = await lightMatchedPrompt({ anthropicKey: 'k', brief: 'een Amsterdamse grachtenstraat', shotFrames: frames });
  ok(d.source === 'fallback' && /^Amsterdam canal street\./.test(d.prompt) && !/grachtenstraat/.test(d.prompt) && calls === 2, 'after two misses the fallback uses the English place, not the Dutch brief');
  ok(/"place"/.test(sent.system) && /in English/.test(sent.system), 'the system prompt asks for the English place phrase');
  queue = null;
  console.warn = warn;
  console.log(f ? `bg-cutout-prompt: ${f} FAILED, ${p} passed` : `bg-cutout-prompt: ${p} checks passed`);
  process.exit(f ? 1 : 0);
})();
