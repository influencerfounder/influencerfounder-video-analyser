#!/usr/bin/env node
// ✂️ The cut-out background prompt must describe the NEW place (2026-10-18): with one frame per shot,
// Claude once described the ORIGINAL station and dropped "Amsterdam", so the paid run came back as the
// station again. Executes the real lightMatchedPrompt with a scripted Anthropic reply.
const path = require('path');
const axiosPath = require.resolve('axios', { paths: [path.join(__dirname, '..')] });
let reply = '', sent = null;
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (_u, body) => { sent = body; return { data: { content: [{ type: 'text', text: reply }] } }; } } };
const { lightMatchedPrompt } = require('../bgcutout');
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
  console.warn = warn;
  console.log(f ? `bg-cutout-prompt: ${f} FAILED, ${p} passed` : `bg-cutout-prompt: ${p} checks passed`);
  process.exit(f ? 1 : 0);
})();
