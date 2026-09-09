#!/usr/bin/env node
// ⏱ KIE CLAUDE TIMEOUT — the student path's Claude call must be budgeted against the
// proxy window, never a flat 80s, and a timeout must reach the student as a sentence
// that says what to do — not as axios's "timeout of 80000ms exceeded" (seen live on a
// valid Instagram reel, 2026-09-08).
//
// Blocks are read out of index.js AT RUN TIME (same rule as hook-window.selftest.js):
// if an anchor drifts, extraction throws instead of testing a stale snapshot.
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

const budget = grab('const CLONE_PROXY_WINDOW_MS', "app.post('/api/clone'", 'budget helper');
const kieCall = grab('      const kieBody = {', '    } else {\n      claudeResponse = await axios.post(\'https://api.anthropic.com', 'kie call');
const catchBlock = grab('    const message = err.response?.data?.error?.message || err.response?.data?.message', '  } finally {', '/api/clone catch');

// the helper, evaluated from the live source
const fn = new Function(budget + '\nreturn { kieClaudeTimeoutMs, CLONE_PROXY_WINDOW_MS, CLONE_BUDGET_MS, KIE_CLAUDE_TIMEOUT_FLOOR_MS };')();

t('window matches the Vercel proxy (270s) and the budget sits inside it', () => {
  assert.strictEqual(fn.CLONE_PROXY_WINDOW_MS, 270000);
  assert.ok(fn.CLONE_BUDGET_MS < fn.CLONE_PROXY_WINDOW_MS, 'budget must leave a margin for our own verdict to travel');
});
t('a fast download hands Claude far more than the old 80s', () => {
  assert.ok(fn.kieClaudeTimeoutMs(30000) > 80000, 'got ' + fn.kieClaudeTimeoutMs(30000));
  assert.strictEqual(fn.kieClaudeTimeoutMs(0), fn.CLONE_BUDGET_MS);
});
t('a slow download shrinks the budget so the answer still beats the proxy timeout', () => {
  assert.strictEqual(fn.kieClaudeTimeoutMs(150000), fn.CLONE_BUDGET_MS - 150000);
  assert.ok(150000 + fn.kieClaudeTimeoutMs(150000) < fn.CLONE_PROXY_WINDOW_MS);
});
t('the floor never lets a very slow download starve the call', () => {
  assert.strictEqual(fn.kieClaudeTimeoutMs(240000), fn.KIE_CLAUDE_TIMEOUT_FLOOR_MS);
  assert.strictEqual(fn.kieClaudeTimeoutMs(10 * 60 * 1000), fn.KIE_CLAUDE_TIMEOUT_FLOOR_MS);
  assert.ok(fn.KIE_CLAUDE_TIMEOUT_FLOOR_MS >= 45000, 'a 20-frame Sonnet call needs real time');
});
t('the Kie call uses the budget, and the flat 80s is gone from the student path', () => {
  assert.ok(/timeout: timeoutMs \}\)/.test(kieCall) && /kieCall\(kieTimeoutMs\)/.test(kieCall), 'every Kie call goes through kieCall with the clock-derived budget');
  assert.ok(!/timeout: 80000/.test(kieCall));
  assert.ok(!/api\.kie\.ai\/claude[\s\S]{0,400}timeout: 80000/.test(SRC), 'no Kie Claude call may keep a flat 80s');
});
t('a timeout becomes a retryable sentence, never the raw axios text', () => {
  assert.ok(/if \(e\.code === 'ECONNABORTED'\) \{/.test(kieCall) && /\n        throw e;\n      \}/.test(kieCall), 'the timeout and the 429 are rewritten; every other error passes through untouched');
  assert.ok(/nothing is wrong with your video/.test(kieCall));
  assert.ok(/Click Analyse & Clone again/.test(kieCall));
  assert.ok(/err\.reason = 'kie_timeout'/.test(kieCall));
});
t('a 429 or a gateway 5xx from Kie retries the Claude call ONCE, budget permitting, and a timeout never does', () => {
  assert.ok(/const KIE_RETRY_STATUSES = \[429, 500, 502, 503, 504\];/.test(kieCall), 'the transient statuses are named');
  assert.strictEqual((kieCall.match(/await kieCall\(kieTimeoutMs\)/g) || []).length, 2, 'exactly one first call and one retry');
  assert.ok(/if \(!KIE_RETRY_STATUSES\.includes\(st\) \|\| leftAfterPause < KIE_CLAUDE_TIMEOUT_FLOOR_MS\) throw e1;/.test(kieCall), 'the retry is skipped for a non-transient error and when the window has no room');
  assert.ok(/leftAfterPause = CLONE_BUDGET_MS - \(Date\.now\(\) - startedAt\) - KIE_RETRY_PAUSE_MS/.test(kieCall), 'the room check counts the pause');
  assert.ok(/kieTimeoutMs = kieClaudeTimeoutMs\(Date\.now\(\) - startedAt\);\n\s+claudeResponse = await kieCall\(kieTimeoutMs\)/.test(kieCall), 'the retry is re-budgeted from the clock');
  assert.ok(!/ECONNABORTED[\s\S]{0,200}await kieCall/.test(kieCall.slice(0, kieCall.indexOf('} catch (e) {'))), 'no timeout-triggered retry');
});
t('a 429 that survives the retry is a plain sentence with Kie\'s own words quoted, tagged kie_rate_limited', () => {
  assert.ok(/e\.response\?\.status === 429/.test(kieCall));
  assert.ok(/rate-limited the AI call/.test(kieCall) && /nothing is wrong with your video/.test(kieCall) && /Kie\.ai credit balance/.test(kieCall));
  assert.ok(/err\.reason = 'kie_rate_limited'/.test(kieCall));
  assert.ok(/d\.error\?\.message \|\| d\.msg \|\| d\.message/.test(kieCall), 'Kie\'s message is read in every body shape it uses');
});
t('the handler catch forwards reason so the proxy and worker can tell a stall from a bad link', () => {
  assert.ok(/reason: err\.reason/.test(catchBlock));
});
t('the Anthropic (owner) path is untouched — no timeout added there', () => {
  const owner = grab("      claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {\n        model: 'claude-sonnet-4-6', max_tokens: maxTok", '    let basePrompt', 'owner call');
  assert.ok(!/timeout:/.test(owner));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
