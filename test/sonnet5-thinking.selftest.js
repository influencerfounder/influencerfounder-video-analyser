#!/usr/bin/env node
// sonnet5-thinking.selftest.js — Sonnet 5 thinks unless told not to, and this repo's prompts
// were written for a model that does not. The tool measured the harm on 2026-09-13
// (/api/generate-hooks: thinking ate a 500-token budget and the reply carried no text block)
// and fixed it in its own modules/claude.js. This repo is the OTHER place that names
// claude-sonnet-5, and the fix did not cross — the cross-repo sibling-drift class.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
let p = 0, f = 0; const ok = (c, m) => { c ? p++ : (f++, console.log('  x ' + m)); };

// ── 1 · every sonnet-5 request turns thinking off ───────────────────────────────────────
const bodies = [...src.matchAll(/\{[^{}]*model:\s*'claude-sonnet-5'[\s\S]{0,400}?\}/g)].map((m) => m[0]);
ok(bodies.length > 0, 'found the claude-sonnet-5 request body');
for (const b of bodies) {
  ok(/thinking:\s*\{\s*type:\s*'disabled'\s*\}/.test(b),
     'a claude-sonnet-5 body must send thinking {type:disabled} — its budget assumes no thinking');
}
// the 4-6 fallbacks do NOT auto-think, so they must NOT be forced to carry the flag
const s46 = [...src.matchAll(/\{[^{}]*model:\s*'claude-sonnet-4-6'[\s\S]{0,300}?\}/g)].map((m) => m[0]);
ok(s46.length >= 1, 'the sonnet-4-6 fallbacks are still there');

// ── 2 · thinking blocks are filtered before content[0].text is read ─────────────────────
const readIdx = src.indexOf("content?.[0]?.text");
ok(readIdx > -1, 'the content[0].text read was located');
const before = src.slice(Math.max(0, readIdx - 700), readIdx);
ok(/type !== 'thinking'/.test(before) && /redacted_thinking/.test(before),
   'thinking blocks are dropped BEFORE that read — otherwise content[0] has no .text');

// ── 3 · drive the filter on a real Anthropic-shaped response ────────────────────────────
const m = src.match(/if \(claudeResponse && claudeResponse\.data && Array\.isArray\(claudeResponse\.data\.content\)\)[\s\S]*?\n    \}/);
ok(!!m, 'the filter block was located');
if (m) {
  const ctx = { claudeResponse: { data: { content: [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'REAL PROMPT' },
  ] } }, Array };
  vm.createContext(ctx);
  vm.runInContext(m[0], ctx);
  const got = ctx.claudeResponse.data.content?.[0]?.text;
  ok(got === 'REAL PROMPT', 'a thinking-first response still yields the prompt, got: ' + JSON.stringify(got));
  const ctx2 = { claudeResponse: { data: { content: [{ type: 'text', text: 'PLAIN' }] } }, Array };
  vm.createContext(ctx2); vm.runInContext(m[0], ctx2);
  ok(ctx2.claudeResponse.data.content[0].text === 'PLAIN', 'a response with no thinking is untouched');
}

console.log(f ? `  ${f} failed, ${p} passed` : `sonnet5-thinking selftest: ${p} checks passed`);
process.exit(f ? 1 : 0);
