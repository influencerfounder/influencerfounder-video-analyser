#!/usr/bin/env node
// 🎬 FIXTURE BUILDER for the prompt regression suite.
//
// Run ONCE per source (idempotent — re-run is a no-op unless --force). It stores:
//   fixtures/<slug>.mp4   the source video itself, so the suite survives the
//                         Instagram link going private/dead. THIS is what makes the
//                         set "fixed"; a suite that re-downloads on every run is at
//                         the mercy of whatever a stranger does to their account.
//   fixtures/<slug>.json  duration, measured motion, transcript, talkingHead, and the
//                         baseline prompt that the CURRENT deployed prompt produces.
//
// Frames are deliberately NOT cached: run.js re-extracts them from the mp4 using the
// extraction constants read out of index.js at run time, so if production changes its
// frame budget or scale the suite follows it instead of testing a stale snapshot.
//
// Cost: one Apify media lookup (~$0.002) + one real Claude analysis (~$0.25) per source,
// once. Re-running the SUITE costs only the Claude call.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// ⚠️ BINARY RESOLUTION. On Railway `npm ci` fetches a linux ffmpeg-static binary and
// everything just works. On a dev Mac that binary is often absent, so we fall back to a
// system ffmpeg. Two traps this guards, both hit for real on this machine:
//   1. ffmpeg-static resolves to a PATH STRING even when the file was never downloaded —
//      so existsSync, not truthiness, decides.
//   2. ~/bin/ffprobe on this Mac is an ffmpeg binary that has merely been RENAMED. Feeding
//      it ffprobe arguments fails in confusing ways, so we verify the binary identifies
//      itself as ffprobe before trusting it, and refuse loudly rather than half-work.
const FFMPEG = [ffmpegStatic, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', `${process.env.HOME}/bin/ffmpeg`]
  .find(p => { try { return p && fs.existsSync(p); } catch (_) { return false; } });
if (!FFMPEG) throw new Error('no ffmpeg found (ffmpeg-static not downloaded and no system ffmpeg)');

const FFPROBE = [ffprobeStatic && ffprobeStatic.path, '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']
  .find(p => {
    try {
      if (!p || !fs.existsSync(p)) return false;
      return /^ffprobe version/.test(execFileSync(p, ['-version'], { encoding: 'utf8' }).trim());
    } catch (_) { return false; }
  });
if (!FFPROBE) throw new Error('no real ffprobe found (note: ~/bin/ffprobe on this machine is a renamed ffmpeg and is deliberately rejected)');
if (FFMPEG !== ffmpegStatic) console.log(`  note: using system ffmpeg at ${FFMPEG} (ffmpeg-static binary not present locally)`);

const DIR = __dirname;
const FIX = path.join(DIR, 'fixtures');
const RAILWAY = process.env.ANALYSER_URL || 'https://influencerfounder-video-analyser-production.up.railway.app';
const STUDIO  = process.env.STUDIO_URL  || 'https://viralstudio.influencerfounder.ai';
const LID     = process.env.IF_LID      || 'HBsod9XwSFfV2qswu9tX';
const FORCE   = process.argv.includes('--force');
const ONLY    = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];

const j = (r) => r.json();
async function post(url, body, headers = {}, timeoutMs = 300000) {
  // ⚠️ A hung request must not block the build forever. 300s is deliberate — Railway waits
  // up to 280s on its own Apify fetch, so anything tighter would kill legitimate slow
  // analyses and read as a broken source rather than a slow one.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ac.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : e.message); }
  finally { clearTimeout(timer); }
  const t = await r.text();
  try { return JSON.parse(t); } catch (_) { throw new Error(`${url} -> ${r.status} non-JSON: ${t.slice(0, 200)}`); }
}

// motion = mean frame-to-frame absolute difference on a 64x112 grayscale copy.
// Same measurement used to diagnose the 2026-09-04 freeze. Cheap, objective, and the
// only input the suite needs to decide whether "completely static" is a lie.
function measureMotion(mp4) {
  const out = execFileSync(FFMPEG, [
    '-v', 'error', '-i', mp4,
    '-vf', 'scale=64:112,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const vals = [...out.matchAll(/YAVG=([0-9.]+)/g)].map(m => parseFloat(m[1]));
  if (!vals.length) throw new Error('motion measurement produced no frames for ' + mp4);
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
}

function probeDuration(mp4) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4], { encoding: 'utf8' });
  const d = parseFloat(out.trim());
  if (!isFinite(d) || d <= 0) throw new Error('bad duration for ' + mp4);
  return Math.round(d * 100) / 100;
}

(async () => {
  fs.mkdirSync(FIX, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'sources.json'), 'utf8'));
  const sources = manifest.sources.filter(s => !ONLY || s.slug === ONLY);
  if (!sources.length) { console.error('no sources matched --only=' + ONLY); process.exit(1); }

  const tok = (await j(await fetch(`${STUDIO}/api/auth/token?lid=${LID}`))).token;
  if (!tok) throw new Error('could not mint a studio token');

  for (const s of sources) {
    const mp4 = path.join(FIX, `${s.slug}.mp4`);
    const meta = path.join(FIX, `${s.slug}.json`);
    // ⚠️ A fixture is only "cached" if its analysis actually SUCCEEDED. A failed
    // analysis still writes duration/motion (both valid, and expensive to redo), but
    // leaves baselinePrompt empty — and an empty baseline silently reads downstream as
    // "the prompt described no movement", which is the opposite of missing data. So
    // treat it as incomplete and retry ONLY the Claude call.
    if (!FORCE && fs.existsSync(mp4) && fs.existsSync(meta)) {
      let done = false;
      try { done = !!JSON.parse(fs.readFileSync(meta, 'utf8')).baselinePrompt; } catch (_) {}
      if (done) { console.log(`  ok   ${s.slug} (cached)`); continue; }
      console.log(`  retry ${s.slug} — fixture exists but has no baseline prompt`);
    }

    // 1. the video itself
    if (FORCE || !fs.existsSync(mp4)) {
      const r = await post(`${STUDIO}/api/saved-links/video-url`, { lid: LID, url: s.url }, { 'X-IF-Token': tok, 'X-IF-Lid': LID });
      if (!r.videoUrl) { console.log(`  SKIP ${s.slug} — could not resolve media (${r.error || 'no videoUrl'})`); continue; }
      const buf = Buffer.from(await (await fetch(r.videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })).arrayBuffer());
      if (buf.length < 10000) { console.log(`  SKIP ${s.slug} — media too small (${buf.length}B)`); continue; }
      fs.writeFileSync(mp4, buf);
    }

    // 2. measurements from the local file
    const duration = probeDuration(mp4);
    const motion = measureMotion(mp4);

    // 3. transcript + talkingHead from ONE real analysis. This also captures the prompt the
    //    CURRENT deployed build produces, which is the before-picture for any prompt change.
    // ⚠️ Per-source isolation. A 502 (Railway container restart) throws out of post(); left
    // uncaught it aborts the entire build, so one flaky source silently costs every source
    // after it. Retry once — 502 is usually a restart, not a verdict on the video — then
    // give up on THIS source and carry on with the rest.
    let a = { success: false, error: 'not attempted' };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        a = await post(`${RAILWAY}/api/clone`, { videoUrl: s.url, promptStyle: 'original', personaGender: s.personaGender });
        break;
      } catch (e) {
        a = { success: false, error: e.message };
        if (attempt === 1) { console.log(`  ..   ${s.slug} — ${e.message.slice(0, 60)}; retrying in 20s`); await new Promise(r => setTimeout(r, 20000)); }
      }
    }
    if (!a.success) { console.log(`  WARN ${s.slug} — analysis failed (${a.error}); storing measurements only, re-run to retry`); }

    fs.writeFileSync(meta, JSON.stringify({
      slug: s.slug, url: s.url, class: s.class, personaGender: s.personaGender,
      duration, motion,
      transcript: a.transcript || '',
      talkingHead: !!a.talkingHead,
      capturedAt: new Date().toISOString(),
      baselinePrompt: a.clonePrompt || ''
    }, null, 2));
    console.log(`  ok   ${s.slug}  dur=${duration}s motion=${motion} transcript=${(a.transcript || '').length}ch talking=${!!a.talkingHead}`);
  }
  const incomplete = manifest.sources.filter(x => {
    const m = path.join(FIX, `${x.slug}.json`);
    if (!fs.existsSync(m)) return true;
    try { return !JSON.parse(fs.readFileSync(m, 'utf8')).baselinePrompt; } catch (_) { return true; }
  }).map(x => x.slug);
  console.log('\nfixtures in ' + FIX);
  if (incomplete.length) console.log(`⚠ INCOMPLETE (${incomplete.length}): ${incomplete.join(', ')} — re-run to retry these`);
  else console.log(`✓ all ${manifest.sources.length} fixtures complete`);
})().catch(e => { console.error('BUILD FAILED:', e.message); process.exit(1); });
