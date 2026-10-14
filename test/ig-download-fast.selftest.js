#!/usr/bin/env node
// ⚡ Instagram download: fast scrape first, the slow re-host scrape (includeDownloadedVideo, 2–5 min measured
// 2026-10-14) only when the direct file fails or has no audio. Runs the LIVE function from index.js with Apify,
// the CDN, the disk and the audio probe mocked. Nothing is fetched or paid.
const fs = require('fs'), path = require('path'), assert = require('assert');
const SRC = fs.readFileSync(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'index.js'), 'utf8');
const a = SRC.indexOf('async function apifyReelItem('), b = SRC.indexOf('// TikTok video fetch');
assert.ok(a > 0 && b > a, 'anchors drifted');
function harness({ fastItem, slowItem, cdn = {}, audio = {} }) {
  const posts = [], gets = [], files = {};
  const axios = {
    post: async (url, body) => { posts.push(body); if (!body.includeDownloadedVideo && fastItem === 'THROW') throw new Error('timeout of 150000ms exceeded'); return { data: [body.includeDownloadedVideo ? slowItem : fastItem] }; },
    get: async (u) => { gets.push(u); if (cdn[u] === 'fail') { const e = new Error('Request failed with status code 403'); e.response = { status: 403 }; throw e; } return { data: Buffer.from('VID:' + u) }; },
  };
  const fsm = { writeFileSync: (p, buf) => { files[p] = String(buf); }, unlinkSync: (p) => { delete files[p]; } };
  const hasAudioStream = async (p) => { const c = files[p] || ''; return audio[c.replace('VID:', '')] !== false; };
  const fn = new Function('axios', 'fs', 'hasAudioStream', 'process', 'console', SRC.slice(a, b) + '\nreturn downloadInstagramViaApify;')(
    axios, fsm, hasAudioStream, { env: { APIFY_API_KEY: 'k' } }, { log() {}, warn() {} });
  return { run: () => fn('https://www.instagram.com/reel/X/', '/t/v.mp4'), posts, gets, files };
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
  console.log(`\nig-download-fast: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
