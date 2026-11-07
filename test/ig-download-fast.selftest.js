#!/usr/bin/env node
// ⚡ Instagram download: fast scrape first, the slow re-host scrape (includeDownloadedVideo, 2–5 min measured
// 2026-10-14) only when the direct file fails or has no audio. Runs the LIVE function from index.js with Apify,
// the CDN, the disk and the audio probe mocked. Nothing is fetched or paid.
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'index.js'), 'utf8');
const a = SRC.indexOf('async function apifyReelItem('), b = SRC.indexOf('// TikTok video fetch');
assert.ok(a > 0 && b > a, 'anchors drifted');
// backupItem = what the 18+ actor (intropix, 2.99.0) answers. Default: nothing (vendor down) → the old path.
// `posts` holds only the reel-scraper calls, so the old counts stay meaningful; `backups` holds the 18+ calls.
function harness({ fastItem, slowItem, backupItem = null, cdn = {}, audio = {}, env = {} }) {
  const posts = [], gets = [], files = {}, backups = [];
  const axios = {
    post: async (url, body) => {
      if (body.postUrls) { backups.push({ url, body }); if (backupItem === 'THROW') throw new Error('Request failed with status code 502'); return { data: backupItem ? [backupItem] : [] }; }
      posts.push(body); if (!body.includeDownloadedVideo && fastItem === 'THROW') throw new Error('timeout of 150000ms exceeded'); if (body.includeDownloadedVideo && slowItem === 'THROW_SLOW') throw new Error('Apify Instagram scrape failed: 502'); return { data: [body.includeDownloadedVideo ? slowItem : fastItem] }; },
    get: async (u, o) => { gets.push(u); if (cdn[u] === 'v4fail' && o.family === 4) { const e = new Error('connect ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; } if (cdn[u] === 'fail') { const e = new Error('Request failed with status code 403'); e.response = { status: 403 }; throw e; } return { data: Buffer.from('VID:' + u) }; },
  };
  const fsm = { writeFileSync: (p, buf) => { files[p] = String(buf); }, unlinkSync: (p) => { delete files[p]; } };
  const hasAudioStream = async (p) => { const c = files[p] || ''; return audio[c.replace('VID:', '')] !== false; };
  const fn = new Function('axios', 'fs', 'hasAudioStream', 'process', 'console', SRC.slice(a, b) + '\nreturn downloadInstagramViaApify;')(
    axios, fsm, hasAudioStream, { env: { APIFY_API_KEY: 'k', ...env } }, { log() {}, warn() {} });
  return { run: () => fn('https://www.instagram.com/reel/X/', '/t/v.mp4'), posts, gets, files, backups };
}
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  x   ' + n + ' :: ' + e.message); } };
(async () => {
  await t('direct file with audio: ONE fast scrape, no re-host, Instagram\'s own file kept', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1', musicInfo: { song_name: 'S', artist_name: 'A', uses_original_audio: false } } });
    const r = await h.run();
    assert.strictEqual(h.posts.length, 1); assert.ok(!h.posts[0].includeDownloadedVideo, 'the fast scrape must not ask for the re-host');
    assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn1'); assert.deepStrictEqual(r.sourceAudio, { title: 'S', artist: 'A', original: false }); assert.strictEqual(r.audioPath, null);
  });
  await t('direct fetch fails: the re-host scrape runs and its copy is the fallback (old behaviour)', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: { videoUrl: 'cdn2', downloadedVideo: 'apify2' }, cdn: { cdn1: 'fail', cdn2: 'fail' } });
    await h.run();
    assert.strictEqual(h.posts.length, 2); assert.strictEqual(h.posts[1].includeDownloadedVideo, true);
    assert.strictEqual(h.files['/t/v.mp4'], 'VID:apify2');
  });
  await t('direct file has no audio: the re-host scrape supplies the audio source, frames stay high quality', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: { videoUrl: 'cdn2', downloadedVideo: 'apify2' }, audio: { cdn1: false, cdn2: false } });
    const r = await h.run();
    assert.strictEqual(h.posts.length, 2); assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn2'); assert.strictEqual(r.audioPath, '/t/v.mp4.audiosrc');
  });
  await t('a deleted post is reported from the fast scrape — no slow run', async () => {
    const h = harness({ fastItem: { error: 'not_found' } });
    await assert.rejects(h.run(), /no longer exists/); assert.strictEqual(h.posts.length, 1);
  });
  await t('an empty fast answer still gets the re-host scrape before giving up', async () => {
    const h = harness({ fastItem: null, slowItem: { videoUrl: 'cdn2' } });
    await h.run(); assert.strictEqual(h.posts.length, 2); assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn2');
  });
  await t('a failed fast scrape falls through to the re-host scrape instead of failing the download', async () => {
    const h = harness({ fastItem: 'THROW', slowItem: { videoUrl: 'cdn2' } });
    await h.run(); assert.strictEqual(h.posts.length, 2); assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn2');
  });
  await t('the CDN file is fetched over IPv4 first; a connect failure retries dual-stack, an HTTP refusal does not', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, cdn: { cdn1: 'v4fail' } });
    await h.run(); assert.strictEqual(h.posts.length, 1, 'no re-host needed'); assert.deepStrictEqual(h.gets, ['cdn1', 'cdn1']);
    const h2 = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: { downloadedVideo: 'apify2' }, cdn: { cdn1: 'fail' } });
    await h2.run(); assert.strictEqual(h2.gets.filter(g => g === 'cdn1').length, 1, 'a 403 is not retried');
  });
  // ── 🔞 18+ backup (2.99.0) ──────────────────────────────────────────────────────────────────────────
  const bk = (url, sc = 'X') => ({ shortcode: sc, media: [{ media_type: 'image', media_url: 'img' }, { media_type: 'video', media_url: url }] });
  await t('18+: a fast file with sound never calls the backup', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, backupItem: bk('age1') });
    await h.run(); assert.strictEqual(h.backups.length, 0);
  });
  await t('18+: refused fast scrape → backup file with sound is used, NO slow scrape, refusal error never shown', async () => {
    const h = harness({ fastItem: { error: 'restricted_page' }, backupItem: bk('age1') });
    const r = await h.run();
    assert.strictEqual(h.files['/t/v.mp4'], 'VID:age1'); assert.strictEqual(h.posts.length, 1, 'no re-host run');
    assert.strictEqual(h.backups.length, 1); assert.ok(/intropix~instagram-posts-reels-scraper/.test(h.backups[0].url));
    assert.deepStrictEqual(h.backups[0].body.postUrls, ['https://www.instagram.com/reel/X/']); assert.strictEqual(r.audioPath, null);
  });
  await t('18+: silent fast file (Leilaa VP9) → backup file with sound replaces it, music info kept from the fast item', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1', musicInfo: { song_name: 'S', artist_name: 'A' } }, backupItem: bk('age1'), audio: { cdn1: false } });
    const r = await h.run();
    assert.strictEqual(h.files['/t/v.mp4'], 'VID:age1'); assert.strictEqual(h.posts.length, 1); assert.strictEqual(r.sourceAudio.title, 'S');
  });
  await t('18+: backup file also silent → old re-host path runs as before', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: { videoUrl: 'cdn2', downloadedVideo: 'apify2' }, backupItem: bk('age1'), audio: { cdn1: false, age1: false, cdn2: false } });
    const r = await h.run();
    assert.strictEqual(h.posts.length, 2); assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn2'); assert.strictEqual(r.audioPath, '/t/v.mp4.audiosrc');
  });
  await t('18+: backup actor errors (502) → old path, the download does not fail on it', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: { videoUrl: 'cdn2' }, backupItem: 'THROW', cdn: { cdn1: 'fail' } });
    await h.run(); assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn2');
  });
  await t('18+: backup CDN refuses (403) → old path', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: { videoUrl: 'cdn2' }, backupItem: bk('age1'), cdn: { cdn1: 'fail', age1: 'fail' } });
    await h.run(); assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn2');
  });
  await t('18+: a DIFFERENT post (shortcode mismatch) is never used', async () => {
    const h = harness({ fastItem: { error: 'restricted_page' }, backupItem: bk('age1', 'OTHER') });
    await assert.rejects(h.run(), /private or restricted/); assert.ok(!h.gets.includes('age1'));
  });
  await t('18+: refused by both → today\'s message and reason, unchanged', async () => {
    const h = harness({ fastItem: { error: 'restricted_page' } });
    await assert.rejects(h.run(), (e) => e.reason === 'restricted_page' && /private or restricted/.test(e.message));
  });
  await t('18+: IG_AGEGATE_ACTOR=off disables the backup entirely', async () => {
    const h = harness({ fastItem: { error: 'restricted_page' }, backupItem: bk('age1'), env: { IG_AGEGATE_ACTOR: 'off' } });
    await assert.rejects(h.run(), /private or restricted/); assert.strictEqual(h.backups.length, 0);
  });
  // ── 🔇 silent last resort (2.99.0) ──
  await t('silent: fast file has picture only, backup gone, re-host REFUSED → keep the silent picture, no failure', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1', musicInfo: { song_name: 'S' } }, slowItem: { error: 'restricted_page' }, audio: { cdn1: false } });
    const r = await h.run();
    assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn1'); assert.strictEqual(r.silent, true); assert.strictEqual(r.audioPath, null); assert.strictEqual(r.sourceAudio.title, 'S');
  });
  await t('silent: re-host scrape THROWS → silent picture kept', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: 'THROW_SLOW', audio: { cdn1: false } });
    const r = await h.run(); assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn1'); assert.strictEqual(r.silent, true);
  });
  await t('silent: never used when the fast FILE itself failed to download (nothing to keep)', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: { error: 'restricted_page' }, cdn: { cdn1: 'fail' } });
    await assert.rejects(h.run(), /private or restricted/);
  });
  await t('silent: re-host gives URLs but every fetch fails → silent picture kept (reviewer gap)', async () => {
    const h = harness({ fastItem: { videoUrl: 'cdn1' }, slowItem: { videoUrl: 'cdn2', downloadedVideo: 'apify2' }, audio: { cdn1: false }, cdn: { cdn2: 'fail', apify2: 'fail' } });
    const r = await h.run(); assert.strictEqual(h.files['/t/v.mp4'], 'VID:cdn1'); assert.strictEqual(r.silent, true);
  });
  await t('18+: the backup call has a 60 s timeout, never longer', async () => {
    assert.ok(/postUrls: \[videoUrl\], maxPosts: 1 \},[\s\S]{0,250}\{ timeout: 60000 \}/.test(SRC.slice(a, b)), 'backup timeout drifted');
  });
  console.log(`\nig-download-fast: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
