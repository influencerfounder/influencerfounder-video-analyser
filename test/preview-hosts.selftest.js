#!/usr/bin/env node
// 🔒 PREVIEW HOSTS — /api/preview downloads up to 300 MB and runs a full libx264 encode, and
// like every analyser route it has no credential (TOOL-CLEANUP I19). Found 2026-09-25 by
// /toolscan (F1): it accepted ANY http(s) link from ANYONE. Mike chose option A: accept only
// our own masters — the Vercel Blob store and GHL's media CDN — over https, with the host
// compared exactly, and no redirects followed.
//
// Blocks are read out of index.js AT RUN TIME (same rule as the other selftests here): if an
// anchor drifts, extraction throws instead of testing a stale snapshot.
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

const helper = grab('const PREVIEW_HOSTS', "app.post('/api/preview'", 'allowlist helper');
const route = grab("app.post('/api/preview'", '\n});\n', '/api/preview route');
const allowed = new Function(helper + '\nreturn previewSourceAllowed;')();

const BLOB = 'https://awn0zbclt6wlzynd.public.blob.vercel-storage.com/assets/HBsod9XwSFfV2qswu9tX/x.mp4';
const GHL = 'https://assets.cdn.filesafe.space/HBsod9XwSFfV2qswu9tX/media/a89a122b.mp4';

t('our Blob store and GHL media are accepted', () => {
  assert.strictEqual(allowed(BLOB), true);
  assert.strictEqual(allowed(GHL), true);
});
t('plain http is refused, even on our own host', () => {
  assert.strictEqual(allowed(BLOB.replace('https:', 'http:')), false);
  assert.strictEqual(allowed(GHL.replace('https:', 'http:')), false);
});
t('ANOTHER Vercel customer\'s Blob store is refused (the portrait-top / I24 hole)', () => {
  assert.strictEqual(allowed('https://someoneelse123.public.blob.vercel-storage.com/a.mp4'), false);
});
t('lookalike hosts are refused: suffix, prefix, userinfo, query, port', () => {
  for (const u of [
    'https://awn0zbclt6wlzynd.public.blob.vercel-storage.com.evil.io/a.mp4',
    'https://evil-assets.cdn.filesafe.space.io/a.mp4',
    'https://awn0zbclt6wlzynd.public.blob.vercel-storage.com@evil.io/a.mp4',
    'https://user:pw@assets.cdn.filesafe.space/a.mp4',
    'https://evil.io/?u=https://assets.cdn.filesafe.space/a.mp4',
    'https://assets.cdn.filesafe.space:8443/a.mp4',
  ]) assert.strictEqual(allowed(u), false, u);
});
t('garbage never throws and is refused', () => {
  for (const u of ['', null, undefined, 42, {}, 'ftp://assets.cdn.filesafe.space/a.mp4', 'not a url', 'file:///etc/passwd'])
    assert.strictEqual(allowed(u), false, String(u));
});
t('the route checks the allowlist BEFORE it downloads anything', () => {
  const check = route.indexOf('previewSourceAllowed(videoUrl)');
  const dl = route.indexOf('axios.get(videoUrl');
  assert.ok(check > -1, 'route no longer calls previewSourceAllowed');
  assert.ok(dl > -1, 'download call moved — re-anchor this test');
  assert.ok(check < dl, 'allowlist must run before the download');
  assert.ok(/if \(!previewSourceAllowed\(videoUrl\)\) \{\s*return res\.status\(403\)/.test(route), 'a refused host must RETURN, not fall through');
});
t('the download follows no redirects (an allowed host must not bounce the fetch elsewhere)', () => {
  const dl = route.slice(route.indexOf('axios.get(videoUrl'), route.indexOf('fs.writeFileSync(inputPath'));
  assert.ok(/maxRedirects:\s*0\b/.test(dl), 'maxRedirects: 0 missing from the preview download');
});

console.log(`\npreview-hosts: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
