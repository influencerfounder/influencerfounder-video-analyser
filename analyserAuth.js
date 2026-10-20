// 🔐 Shared secret between the tool and this analyser (/toolscan 2026-10-19, Mike: "let's fix that now").
// Every route here used to answer anyone who knew the address, and several spend Mike's own keys
// (Anthropic on /api/bg-cutout and /api/clone-v2/moment whenever no student key is sent, fal through
// the caller's key, CPU on all of them). Only the tool's SERVER calls this service (the extension, the
// MCP server, the desktop app and every browser page go through the tool), so one header closes it.
//
// OPEN on purpose — fetched by vendors (Kie, fal) and browsers that cannot carry a header, each behind an
// unguessable token: GET /, GET /health, GET /api/temp-video/:token, GET /api/faceswap/download/:jobId.
//
// FAIL CLOSED by default since the rollout finished (2026-10-20, reviewer): a missing or wrong key is refused
// unless ANALYSER_SECRET_MODE=log is set EXPLICITLY (serve + log — only for a key rotation). No secret set
// refuses everything. So a variable deleted by a `railway config apply` (both are preserve()d in
// .railway/railway.ts) makes a loud outage, never a silently open analyser.
const crypto = require('crypto');

const HEADER = 'x-if-analyser-key';
const OPEN = [/^\/$/, /^\/health\/?$/, /^\/api\/temp-video\/[^/]+$/, /^\/api\/faceswap\/download\/[^/]+$/];

function isOpen(method, path) {
  if (method === 'OPTIONS') return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  const p = String(path || '').toLowerCase();   // Express matches routes case-insensitively
  return OPEN.some((re) => re.test(p));
}
function keyMatches(given, secret) {
  if (!secret || typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}
/** Decide one request: { allow, reason }. env defaults to process.env. */
function check(req, env = process.env) {
  if (isOpen(req.method, req.path)) return { allow: true, reason: 'open' };
  const secret = env.ANALYSER_SECRET || '';
  const require_ = String(env.ANALYSER_SECRET_MODE || '').toLowerCase() !== 'log';
  const ok = keyMatches(req.get ? req.get(HEADER) : (req.headers || {})[HEADER], secret);
  if (ok) return { allow: true, reason: 'key' };
  if (require_) return { allow: false, reason: secret ? 'bad_key' : 'no_secret_configured' };
  return { allow: true, reason: 'missing_key_logged' };
}
function middleware(log = console.log) {
  return (req, res, next) => {
    const d = check(req);
    if (d.reason === 'missing_key_logged') log(`[auth] ${req.method} ${req.path} without a valid ${HEADER} (served: mode is log)`);
    if (!d.allow) { log(`[auth] refused ${req.method} ${req.path} (${d.reason})`); return res.status(401).json({ success: false, error: 'Unauthorized' }); }
    next();
  };
}
module.exports = { HEADER, isOpen, keyMatches, check, middleware };
