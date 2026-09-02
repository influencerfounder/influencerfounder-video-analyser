const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const FormData = require('form-data');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

ffmpeg.setFfmpegPath(ffmpegStatic);
// drawtext (used by caption burn-in) needs libfreetype, which the ffmpeg-static
// build does not ship. The container apt-installs a full ffmpeg, so resolve it once
// here and use it for that one command only.
const SYSTEM_FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
ffmpeg.setFfprobePath(ffprobeStatic.path);

// ─────────────────────────────────────────
// Instagram video fetch — via Apify's instagram-reel-scraper actor.
// yt-dlp increasingly returns "empty media response" for unauthenticated
// Instagram scrapes even on public posts, and Instagram cookie auth means
// exposing a real logged-in account to bot-detection/ban risk. Apify's actor
// runs from its own managed scraping infrastructure (no Instagram login on
// our side at all) and re-hosts the video file (includeDownloadedVideo) so
// we're not hitting Instagram's CDN directly either.
// ─────────────────────────────────────────
async function downloadInstagramViaApify(videoUrl, outputPath) {
  const apifyKey = process.env.APIFY_API_KEY;
  if (!apifyKey) throw new Error('APIFY_API_KEY not configured');

  let items;
  try {
    const resp = await axios.post(
      `https://api.apify.com/v2/actors/apify~instagram-reel-scraper/run-sync-get-dataset-items?token=${apifyKey}`,
      { username: [videoUrl], resultsLimit: 1, includeDownloadedVideo: true },
      { timeout: 280000 }
    );
    items = resp.data;
  } catch (e) {
    throw new Error('Apify Instagram scrape failed: ' + (e.response?.data?.error?.message || e.message));
  }

  const item = Array.isArray(items) ? items[0] : null;
  const remoteVideoUrl = item?.downloadedVideo || item?.videoUrl;
  if (!remoteVideoUrl) {
    // Apify distinguishes a DELETED post from one that merely is not publicly
    // readable, and that difference is invisible everywhere else: Instagram's
    // oEmbed answers the identical 404 "No Media Match" for both (measured
    // 2026-08-07). This is the only authoritative signal in the whole pipeline,
    // so it is passed upstream rather than collapsed into one message.
    // NOT ASSUMED for this actor: apify/instagram-scraper emits not_found /
    // restricted_page; whether instagram-reel-scraper uses the same vocabulary is
    // unverified, so anything unrecognised stays 'unknown' and marks nothing.
    const raw = String(item?.error || item?.errorDescription || '').toLowerCase();
    // Vocabulary is VERIFIED for apify/instagram-scraper (not_found /
    // restricted_page) and MEASURED for instagram-reel-scraper, which returned
    // restricted_page for a post the other actor called not_found — the two
    // disagree, so neither string set can be treated as canonical. Widened to
    // cover the wordings any of these actors plausibly emit, and anything
    // unrecognised stays 'unknown' and marks nothing rather than guessing.
    //
    // Order matters: check GONE first. A body can contain both ("post not found
    // or private"), and calling a deleted post merely private is the wrong error
    // to leave a student staring at — it sends them looking for a login fix that
    // does not exist.
    const reason =
      /not_?found|no results|does not exist|deleted|removed|no longer available|404/.test(raw) ? 'not_found'
      : /restrict|private|login|unavailable|age|gated|geoblock|forbidden|403|sign in/.test(raw) ? 'restricted_page'
      : 'unknown';
    const err = new Error(
      reason === 'not_found'
        ? 'This Instagram post no longer exists — it was deleted or the link is wrong.'
        : reason === 'restricted_page'
          ? 'This account is private or restricted, so the post cannot be fetched.'
          : 'Could not find this Instagram post — it may be private, deleted, or the link is invalid.'
    );
    err.reason = reason;
    err.apifyError = raw || null;
    throw err;
  }

  const videoRes = await axios.get(remoteVideoUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: 200 * 1024 * 1024,
  });
  fs.writeFileSync(outputPath, Buffer.from(videoRes.data));

  // Music metadata — field names PROBED against the live actor 2026-09-01 (the
  // 2026-08-31 lesson: write-ups lie about this actor family's schemas). Items
  // carry musicInfo { artist_name, song_name, uses_original_audio, ... }.
  // Surfaced so the tool can name the sound the source video used — Mike adds
  // the real track when posting, and knowing WHICH track the viral source used
  // is half of modelling it.
  const mi = item?.musicInfo || null;
  return {
    sourceAudio: mi ? {
      title: String(mi.song_name || ''),
      artist: String(mi.artist_name || ''),
      original: !!mi.uses_original_audio,
    } : null,
  };
}

// ─────────────────────────────────────────
// TikTok video fetch — yt-dlp first (free), Apify as an automatic fallback.
// yt-dlp's TikTok extractor breaks whenever TikTok changes their page shape. On
// 2026-08-31 it returned "Unexpected response from webpage request" for every
// public video, which surfaced in the Studio as a bare "retry". Instagram hit
// the same wall in July and was moved to Apify wholesale; TikTok keeps yt-dlp as
// the free first attempt (it works most of the time and costs nothing) and falls
// back automatically, so a breakage is a ~$0.002 charge instead of a dead feature.
// It also self-heals: once yt-dlp is fixed upstream the free path resumes on its own.
//
// downloadAddr is a SIGNED TikTok CDN url — fetched immediately in the same
// request, never stored. shouldDownloadVideos is deliberately NOT used: it is a
// charged add-on that writes into a key-value store instead of returning a url.
// ─────────────────────────────────────────
async function downloadTikTokViaApify(videoUrl, outputPath) {
  const apifyKey = process.env.APIFY_API_KEY;
  if (!apifyKey) throw new Error('APIFY_API_KEY not configured');

  let items;
  try {
    const resp = await axios.post(
      `https://api.apify.com/v2/actors/clockworks~tiktok-scraper/run-sync-get-dataset-items?token=${apifyKey}`,
      { postURLs: [videoUrl], resultsPerPage: 1, shouldDownloadVideos: true, shouldDownloadCovers: false },
      { timeout: 280000 }
    );
    items = resp.data;
  } catch (e) {
    throw new Error('Apify TikTok scrape failed: ' + (e.response?.data?.error?.message || e.message));
  }

  const item = Array.isArray(items) ? items[0] : null;
  // PROBED against the live actor 2026-08-31, because the field names in the
  // write-ups are wrong for this actor version: videoMeta carries NO downloadAddr
  // and NO playAddr (its keys are height/width/duration/coverUrl/definition/format/
  // subtitleLinks/transcriptionLink/...). The ONLY downloadable url is mediaUrls[0],
  // and it is populated ONLY when shouldDownloadVideos is true — which is why that
  // flag is on despite being a charged add-on. mediaUrls is an empty array without it.
  const candidates = (Array.isArray(item?.mediaUrls) ? item.mediaUrls : []).filter(Boolean);

  if (!candidates.length) {
    const raw = String(item?.error || item?.errorDescription || '').toLowerCase();
    const err = new Error(
      /not_?found|does not exist|deleted|removed|404/.test(raw)
        ? 'This TikTok video no longer exists — it was deleted or the link is wrong.'
        : /private|restrict|login|age|unavailable|region/.test(raw)
          ? 'This TikTok account is private or the video is restricted, so it cannot be fetched.'
          : 'Could not fetch this TikTok video — it may be private, deleted, or region-locked.'
    );
    err.apifyError = raw || null;
    throw err;
  }

  // musicMeta { musicName, musicAuthor, musicOriginal } — PROBED live 2026-09-01.
  const mm = item?.musicMeta || null;
  const sourceAudio = mm ? {
    title: String(mm.musicName || ''),
    artist: String(mm.musicAuthor || ''),
    original: !!mm.musicOriginal,
  } : null;

  let lastErr = null;
  for (const remote of candidates) {
    try {
      // mediaUrls points into Apify's own key-value store, which is PRIVATE — an
      // unauthenticated GET returns 403. Measured: with the token appended it
      // returns a real 1,065,656-byte mp4 (ftypisom).
      const authed = remote.includes('api.apify.com')
        ? remote + (remote.includes('?') ? '&' : '?') + 'token=' + apifyKey
        : remote;
      const videoRes = await axios.get(authed, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: 200 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' },
      });
      fs.writeFileSync(outputPath, Buffer.from(videoRes.data));
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size >= 1000) return { sourceAudio };
    } catch (e) { lastErr = e; }
  }
  throw new Error('TikTok video url could not be downloaded' + (lastErr ? ': ' + lastErr.message : ''));
}

// Each call site keeps its own yt-dlp flags and timeout; this only owns the
// try-then-fall-back decision, so all three TikTok paths share one behaviour.
async function downloadTikTok(videoUrl, outputPath, ytDlpAttempt) {
  try {
    await ytDlpAttempt();
    // yt-dlp gives no music metadata (a second -j fetch could, but the extractor
    // is currently broken anyway so everything real goes via Apify) — the audio
    // name is simply unknown on this path and the UI omits the row.
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size >= 1000) return { via: 'yt-dlp', sourceAudio: null };
    throw new Error('yt-dlp produced no usable file');
  } catch (e) {
    console.log(`[tiktok] yt-dlp failed (${String(e.message).slice(0, 140)}) — falling back to Apify`);
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    const r = await downloadTikTokViaApify(videoUrl, outputPath);
    return { via: 'apify', sourceAudio: (r && r.sourceAudio) || null };
  }
}

const app = express();

// ── Recreate duration/model recommendation — the SINGLE source of truth ──
// Both the phone-app/queue worker AND the desktop Recreate tab read these two
// fields off the /api/clone response, so their choice can never drift apart
// (Mike, 2026-09-02: "always consistent for desktop and phone app"). RULE:
// round the source length UP to the smallest clip that fully covers it — a
// shorter clip cuts off content, so a length between two options always takes
// the LONGER (a 7.5s source -> 10s, never 5s). Seedance 2.0 offers 5/10/15s; a
// source longer than 15s auto-switches to Seedance 2.5 (up to 30s) at the same
// aspect ratio and resolution tier.
function recommendRecreateSpec(sourceSecs) {
  const sec = Number(sourceSecs) || 0;
  if (sec > 15) return { recommendedDuration: 30, recommendedSpeedMode: 'v25' };
  const recommendedDuration = sec <= 5 ? 5 : sec <= 10 ? 10 : 15;
  return { recommendedDuration, recommendedSpeedMode: 'v20' };
}
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────

// Log yt-dlp availability on startup
const { execSync } = require('child_process');
try {
  const ytDlpPath = execSync('which yt-dlp 2>/dev/null || echo "NOT FOUND"', { encoding: 'utf8' }).trim();
  const ytDlpVer  = execSync('yt-dlp --version 2>/dev/null || echo "N/A"', { encoding: 'utf8' }).trim();
  console.log(`[startup] yt-dlp: ${ytDlpPath} (${ytDlpVer})`);
} catch(e) { console.log('[startup] yt-dlp check failed:', e.message); }

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'InfluencerFounder Video Analyser', version: '2.16.3', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────
// VIRAL LAB — ANALYSE VIDEO
// Full deconstruction: virality scorecard, hook, blueprint, Seedance prompt
// ─────────────────────────────────────────

// (Legacy handleViralAnalyse removed 2026-07-10 — it passed only the video URL as TEXT
// to Claude, which cannot fetch URLs, so every 'analysis' it returned was hallucinated.
// The real frame-based analysis lives in the Vercel service: POST /api/viral/analyse.)


// ─────────────────────────────────────────
// CLONE — Copy Viral Video tab
// Downloads video → extracts frames → transcribes audio → Claude vision
// ─────────────────────────────────────────

// ─────────────────────────────────────────
// VIRAL DRIVER TAXONOMY (2026-09-02, Mike: "why did this video go viral?")
//
// A closed list on purpose. Free-text "why" invites vague answers ("great
// editing") that cannot be counted, and the whole point is that the Viral Brain
// GROUPS BY this value to learn which mechanisms actually perform for THIS
// account. An open string splits into a hundred one-row groups and says nothing.
//
// ⚠️ MIRRORED in the service's BRAIN_ENUMS.driver — the service validates and
// DROPS anything not on its own list, so that copy is authoritative. Keep them
// in sync; a value added here and not there is silently discarded (which is the
// safe direction, but it means the Brain never learns it).
const VIRAL_DRIVERS = [
  'pattern_interrupt','withheld_reveal','aspirational_fantasy','transformation',
  'relatable_tension','curiosity_gap','social_proof_reaction','comedic_subversion',
  'loop_bait','info_density','other',
];

app.post('/api/clone', async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));

  try {
    // mode 'bgswap' reuses this endpoint's ENTIRE download + frame-extraction path
    // (Apify for Instagram, yt-dlp for TikTok, axios for a direct URL, then ffmpeg)
    // and only swaps the system prompt and response shape. A separate endpoint would
    // have duplicated all of that — the duplication class this codebase keeps paying
    // for. Default '' keeps every existing caller byte-identical.
    const { videoUrl, locationId, kieApiKey, mode, bgBrief, hookReport, driverPriors } = req.body;
    // Recreate prompt style (Mike's A/B, 2026-09-02). 'original' = the exact
    // May 2026 director method (recreate the video 1:1, swap the person; NO realism
    // layer) — the DEFAULT, exactly the May 1:1 method that predates the reach decline. 'realism' =
    // the SAME May 1:1 prompt with the lane realism layer appended (authentic/high-end auto-classified).
    // The July scaffolded/condensing builder is fully removed — it was the suspected viral-cliff cause.
    // 'improve' = the DELIBERATE re-engineering mode (a SEPARATE feature from recreation): it resurrects the
    // scaffolded builder (systemPrompt) — hook-mechanism-first, timestamped shots, full sequence, realism layer —
    // NOT to copy the source but to make a stronger version of it, optionally steered by improveBrief.
    const promptStyle = ['original','realism','improve'].includes(req.body.promptStyle) ? req.body.promptStyle : 'original';
    const improveBrief = String(req.body.improveBrief || '').slice(0, 600).trim();
    const isBgSwap = mode === 'bgswap';
    if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

    // Cost split (2026-07-17): kieApiKey present = student account, routed to
    // Kie.ai's Claude Sonnet 5 endpoint on their own credits (Vercel's
    // clone-proxy decides owner-vs-student and only forwards a key for
    // students). No kieApiKey = Mike's own account, unchanged direct-Anthropic
    // path on Sonnet 4.6.
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!kieApiKey && !ANTHROPIC_API_KEY) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });

    // 1. Download video
    const videoPath = path.join(tmpDir, 'video.mp4');

    const isInstagram = /instagram\.com\/(p|reel|reels)\//.test(videoUrl);
    const isTikTok = /tiktok\.com\/@[^/]+\/video\/|tiktok\.com\/t\//.test(videoUrl);

    let sourceAudio = null; // { title, artist, original } from the source post, when known
    if (isInstagram) {
      try {
        const igDl = await downloadInstagramViaApify(videoUrl, videoPath);
        sourceAudio = (igDl && igDl.sourceAudio) || null;
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message, reason: e.reason || null, apifyError: e.apifyError || null });
      }
      if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1000) {
        return res.status(400).json({ success: false, error: 'Could not download video from this URL. The post may be private or the link may have expired.' });
      }
    } else if (isTikTok) {
      // Use yt-dlp — try common install paths
      const { execFile, execSync } = require('child_process');
      let ytDlpBin = 'yt-dlp';
      try {
        ytDlpBin = execSync('which yt-dlp || echo /usr/local/bin/yt-dlp', { encoding: 'utf8' }).trim().split('\n')[0];
      } catch(_) {}

      try {
        const via = await downloadTikTok(videoUrl, videoPath, () => new Promise((resolve, reject) => {
          execFile(ytDlpBin, [
            '-o', videoPath,
            '-f', 'mp4/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--no-playlist',
            '--quiet',
            '--no-warnings',
            videoUrl,
          ], { timeout: 90000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error('yt-dlp failed: ' + (stderr || err.message)));
            resolve();
          });
        }));
        console.log(`[clone] tiktok downloaded via ${via.via}`);
        sourceAudio = via.sourceAudio || null;
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message, apifyError: e.apifyError || null });
      }
      if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1000) {
        return res.status(400).json({ success: false, error: 'Could not download video from this URL. The post may be private or the link may have expired.' });
      }
    } else {
      const videoRes = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: 200 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' }
      });
      // Check the response is actually a video, not an HTML error page
      const contentType = videoRes.headers['content-type'] || '';
      const firstBytes = Buffer.from(videoRes.data).slice(0, 20).toString('latin1');
      const isHtml = contentType.includes('text/html') || firstBytes.startsWith('<!') || firstBytes.startsWith('<h');
      if (isHtml) {
        return res.status(400).json({ success: false, error: 'URL returned an HTML page instead of a video file. Please download the video and upload it directly.' });
      }
      fs.writeFileSync(videoPath, Buffer.from(videoRes.data));
    }

    // 2. Probe duration
    const duration = await new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, meta) => resolve(err ? 15 : (meta?.format?.duration || 15)));
    });

    // 2b. Keep a short-lived PLAYABLE copy of the source video, so the Studio can
    // show the original next to the finished recreate ("what went well / what to
    // improve"). The file is already downloaded and probed here — copying it out of
    // tmpDir (which the finally block deletes) into the existing tempVideos map
    // costs one local file copy and NO extra download / Apify call. 30-min TTL,
    // pruned by the existing interval; the Studio re-hosts it durably (Blob/GHL)
    // while the recreate generates, so the comparison outlives this copy.
    // Scheme is forced to https: express has no `trust proxy` here, so req.protocol
    // reads `http` behind Railway's proxy and an http src would be blocked as mixed
    // content on the https Studio page.
    let sourceVideoUrl = '', sourceVideoToken = '';
    try {
      cleanOldTempVideos();
      sourceVideoToken = `src${Date.now()}_${(Math.random().toString(36) + '000000').slice(2, 8)}`;
      const srcCopyPath = path.join(os.tmpdir(), `tempvid_${sourceVideoToken}.mp4`);
      fs.copyFileSync(videoPath, srcCopyPath);
      tempVideos.set(sourceVideoToken, { filePath: srcCopyPath, createdAt: Date.now() });
      sourceVideoUrl = `https://${req.get('host')}/api/temp-video/${sourceVideoToken}`;
    } catch (e) {
      // FAILS OPEN — losing the comparison copy must never fail an analysis.
      console.warn('[clone] could not keep a source copy for comparison:', e.message);
      sourceVideoUrl = ''; sourceVideoToken = '';
    }

    // 3. Extract frames for Claude's analysis — SAME duration-based budget as the /watch
    // skill's auto_fps (short clips sampled densely, long clips capped at 80, single-pass
    // fps extraction):
    //   <=30s -> max(12, round(duration))   (e.g. 7s -> 12, 25s -> 25)
    //   <=60s -> 40   |   <=180s -> 60   |   <=600s -> 80   |   >600s -> 80
    const framesDir = path.join(tmpDir, 'frames');
    fs.mkdirSync(framesDir);
    // Always spend the FULL frame budget regardless of clip length — a shorter
    // clip gets denser sampling (more detail), never fewer frames. Previously
    // tiered (12–80 by duration) with a 2fps ceiling, which let sub-half-second
    // beats (fast cuts, quick gestures) fall between frames on exactly the
    // quick-cut clips students clone most (Mike, 2026-07-17).
    // fps ceiling 8 = catches beats down to ~0.125s; beyond that adjacent
    // frames are near-duplicates and only add Claude vision cost.
    const ANALYSIS_FRAME_COUNT = 80;
    const fps = Math.min(8.0, ANALYSIS_FRAME_COUNT / Math.max(duration, 0.1));

    // opts.width/opts.qv: analysis frames stay 640/q5 (Claude vision needs no more and
    // 80 of them go into the prompt) — but frames RETURNED to the client double as
    // GENERATION inputs (the filmstrip anchor, the recreate worker's scene frame, the
    // custom-first-frame scene reference), and a 640px q5 JPEG as the source of truth
    // for an anchored generation was a real quality ceiling (found 2026-08-25).
    const extractFrame = (ts, outPath, opts = {}) => new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(ts)
        .outputOptions([
          '-vframes 1',
          `-q:v ${opts.qv || 5}`,
          `-vf scale=${opts.width || 640}:-1`,
          '-threads 1'        // single-threaded = predictable low RAM per ffmpeg call
        ])
        .output(outPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions([
          `-vf fps=${fps},scale=640:-1`,
          '-frames:v', String(ANALYSIS_FRAME_COUNT),
          '-q:v 5',
          '-threads 1'
        ])
        .output(path.join(framesDir, 'frame-%03d.jpg'))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const frameFiles = fs.readdirSync(framesDir).sort();

    // Claude vision gets ALL extracted analysis frames (up to 80) for a thorough read.
    const frameBase64s = frameFiles.map(f => fs.readFileSync(path.join(framesDir, f)).toString('base64'));

    // The frame PICKER (clickable thumbnails in the Recreate tab) is capped at 12 —
    // showing all 80 thumbnails for a long video would be unusable. Evenly sample
    // up to 12 frames across the full analysis set so the picker still spans the
    // whole clip.
    const PICKER_MAX = 12;
    let pickerFiles = frameFiles;
    if (frameFiles.length > PICKER_MAX) {
      const picked = new Set();
      for (let i = 0; i < PICKER_MAX; i++) {
        picked.add(frameFiles[Math.round(i * (frameFiles.length - 1) / (PICKER_MAX - 1))]);
      }
      pickerFiles = frameFiles.filter(f => picked.has(f));
    }
    // Timestamps for the picker frames (fps-based extraction: frame n ≈ n/fps seconds)
    const frameTimestamps = pickerFiles.map(pf => Math.round((frameFiles.indexOf(pf) / fps) * 10) / 10);

    // Re-extract the PICKER frames at 1024px/q4 — these are the frames the client can
    // turn into a first-frame anchor or a scene reference, so they deserve real pixels
    // (the 80 analysis frames stay 640/q5, Claude-vision-appropriate). SIZE GUARD: the
    // whole response must clear Vercel's ~4.5MB serverless response cap through
    // /api/clone-proxy, so if the hi-res set runs heavy (grain-dense sources) we fall
    // back to the 640px analysis files rather than break the response.
    let pickerB64s = [];
    try {
      let total = 0;
      const hi = [];
      for (let i = 0; i < pickerFiles.length; i++) {
        const hp = path.join(framesDir, `picker-hi-${String(i).padStart(2, '0')}.jpg`);
        await extractFrame(Math.max(frameTimestamps[i] || 0, 0.05), hp, { width: 1024, qv: 4 });
        const buf = fs.readFileSync(hp);
        total += buf.length;
        hi.push(buf.toString('base64'));
      }
      if (total <= 2_600_000) pickerB64s = hi;
      else console.warn(`[clone] hi-res picker set ${Math.round(total / 1024)}KB — falling back to 640px frames to stay under the proxy response cap`);
    } catch (e) {
      console.warn('[clone] hi-res picker extraction failed, using 640px frames:', e.message);
    }
    const frameDataUrls = pickerB64s.length === pickerFiles.length
      ? pickerB64s.map(b64 => `data:image/jpeg;base64,${b64}`)
      : pickerFiles.map(f => `data:image/jpeg;base64,${fs.readFileSync(path.join(framesDir, f)).toString('base64')}`);

    // ── Scorecard v2 (2026-07-10) ──
    // Densely sample the HOOK WINDOW (first 3s): the virality scorecard weights the
    // hook heaviest, but evenly-sampled frames on a longer clip may contain only a
    // single frame from 0-3s — the model literally couldn't see the window it was
    // scoring. Extracted sequentially with the same low-memory options.
    const hookFrames = [];
    for (const ts of [0.3, 1.0, 2.0, 3.0]) {
      if (ts >= duration) break;
      try {
        const hp = path.join(framesDir, `hook-${String(ts).replace('.', '_')}.jpg`);
        await extractFrame(ts, hp);
        hookFrames.push({ ts, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(hp).toString('base64')}` });
      } catch (_) {}
    }

    // 3b. Extract the TRUE opening frame (t≈0) separately — sequential, same low-mem options
    let firstFrameUrl = '';
    try {
      const firstFramePath = path.join(framesDir, 'frame-opening.jpg');
      await extractFrame(0.1, firstFramePath, { width: 1024, qv: 4 });
      const openingB64 = fs.readFileSync(firstFramePath).toString('base64');
      firstFrameUrl = `data:image/jpeg;base64,${openingB64}`;
    } catch (_) { /* fall back to frames[0] on the client if this fails */ }

    // 4. Transcribe audio with Groq's Whisper endpoint (skip gracefully if no key)
    // Transcription failure must never block the clone/prompt flow — but a
    // silent catch(_) meant every failure mode (missing key, ffmpeg failure,
    // Whisper 4xx/5xx, quota) looked identical to "this video has no audio"
    // from the client's perspective, with no way to tell them apart. Now
    // captured into transcriptError and returned alongside transcript/
    // hasAudio so a real failure is visible instead of silently indistinguishable
    // from a genuinely silent video.
    // Switched from OpenAI Whisper to Groq's OpenAI-compatible Whisper endpoint
    // 2026-07-01 — Groq's free tier (2,000 requests/day, no credit card required)
    // is generous enough to open this to every student rather than gating it to
    // the owner account like the OpenAI version was. locationId is only logged
    // (not used to gate access) so usage against the shared free-tier cap is
    // traceable to an account if it's ever needed.
    let transcript = '';
    let transcriptError = '';
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
      transcriptError = 'GROQ_API_KEY not configured on the analyser service';
    } else {
      console.log(`[transcribe] request from locationId=${locationId || 'unknown'}`);
      try {
        const audioPath = path.join(tmpDir, 'audio.mp3');
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('64k')
            .output(audioPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
          const form = new FormData();
          form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
          form.append('model', 'whisper-large-v3-turbo');
          // verbose_json gives per-segment confidence signals — Whisper invents
          // plausible-looking text on music-only/silent audio, so plain `text`
          // can't be trusted as proof that anyone is actually speaking.
          form.append('response_format', 'verbose_json');
          const whisperRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() },
            timeout: 60000
          });
          const segments = whisperRes.data?.segments;
          if (Array.isArray(segments)) {
            // Keep only segments Whisper itself is confident contain real speech.
            // Thresholds follow Whisper's own hallucination heuristics:
            // high no_speech_prob = likely music/silence, very low avg_logprob =
            // low-confidence guess, high compression_ratio = repetitive loop.
            const speechSegments = segments.filter(s =>
              (s.no_speech_prob ?? 0) < 0.6 &&
              (s.avg_logprob ?? 0) > -1.0 &&
              (s.compression_ratio ?? 1) < 2.4
            );
            transcript = speechSegments.map(s => (s.text || '').trim()).filter(Boolean).join(' ').trim();
            if (!transcript && segments.length) {
              console.log(`[transcribe] ${segments.length} segment(s) all rejected as non-speech/hallucination — treating video as having no spoken script`);
            }
          } else {
            transcript = whisperRes.data?.text || '';
          }
        }
        // else: audio track exists but is essentially empty/silent — not an error.
      } catch (err) {
        transcriptError = err.response?.data?.error?.message || err.message || 'Whisper transcription failed';
      }
    }

    // 5. Send frames + transcript to Claude vision
    const imageContent = frameBase64s.map(b64 => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: b64 }
    }));

    // 🪝 HOOK WINDOW LEADS THE CONTENT (2026-08-31) — the 4 densely-sampled 0-3s frames,
    // labelled and in order, so the builder can actually SEE the hook it has to preserve.
    // Until now these were extracted PURELY to be returned to the scorecard: the builder
    // saw only the evenly-sampled set, which on a longer clip can hold a single frame from
    // 0-3s — the exact blindness the scorecard fixed for itself on 2026-07-10 and that was
    // never swept into the prompt builder. They ride FIRST because prompt weight is
    // front-loaded and the hook is the one shot that decides whether a recreate works.
    // Kept OUT of imageContent on purpose: the Kie branch below even-samples that array to
    // stay under the gateway's image ceiling, and sampling a mixed text/image array would
    // both drop hook frames and splice stray labels into the subset.
    const hookContent = (hookFrames.length && !isBgSwap) ? [
      { type: 'text', text: `HOOK WINDOW — the source's opening ${hookFrames.length} frames in order (${hookFrames.map(h => h.ts + 's').join(', ')}). This is the scroll-stopping moment you must preserve.` },
      ...hookFrames.map(h => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: h.dataUrl.split(',')[1] } })),
      { type: 'text', text: 'FULL CLIP — evenly sampled frames covering the whole video:' },
    ] : [];
    const hookImgCount = hookContent.length ? hookFrames.length : 0;   // derive from hookContent so the bgswap gate can never desync the Kie frame budget

    const userText = transcript
      ? `These ${frameBase64s.length} frames were extracted from the viral video. Transcript: "${transcript}"\n\nCreate the Seedance prompt.`
      : `These ${frameBase64s.length} frames were extracted from the viral video (no audio). Create the Seedance prompt.`;

    // 🪝 MEASURED hook report, when the caller has one (2026-08-31). The Virality
    // Scorecard runs AFTER this builder in the Studio and is fed this call's own hook
    // frames, so hook_report cannot exist on a first pass — the frames above are how
    // pass 1 (and the whole phone-app worker, which never runs the scorecard at all)
    // sees the hook. On a RE-analyse the Studio replays the stored report, and a
    // measured mechanism beats one re-derived from the same frames.
    let hookBlock = '';
    try {
      const hr = hookReport || null;
      if (hr && typeof hr === 'object') {
        const bits = [];
        if (hr.hook_type) bits.push(`- mechanism: ${String(hr.hook_type).slice(0, 160)}`);
        if (hr.scroll_stop_grade) bits.push(`- scroll-stop grade: ${String(hr.scroll_stop_grade).slice(0, 80)}`);
        if (hr.grade_reason) bits.push(`- why: ${String(hr.grade_reason).slice(0, 300)}`);
        if (hr.mute_test && typeof hr.mute_test.pass === 'boolean') {
          bits.push(`- works with sound off: ${hr.mute_test.pass ? 'YES — the hook is visual, keep it visual' : 'NO — the hook leans on audio, so give the recreate a VISUAL equivalent'}`);
        }
        if (hr.first_frame_verdict) bits.push(`- opening frame as thumbnail: ${String(hr.first_frame_verdict).slice(0, 300)}`);
        if (bits.length) {
          hookBlock = `\n\nMEASURED HOOK REPORT for this exact video — this was scored from the same hook frames, so use it rather than re-deriving it, and rebuild this mechanism as the opening shot [0-2s]:\n${bits.join('\n')}`;
        }
      }
    } catch (_) { hookBlock = ''; }

    // 📈 LEARNED PRIORS — this account's OWN measured results per driver,
    // supplied by the service from the Viral Brain (viral_analyses GROUP BY
    // driver tag). This is what makes the tool self-improving: the more videos
    // are analysed AND posted, the better it knows which mechanisms actually
    // travel for THIS account rather than in general.
    //
    // The service only sends rows that clear its own evidence bar, so anything
    // arriving here is already worth acting on. We still cap the list and the
    // strings: they land inside a Claude prompt, and only the SHAPE is ours.
    // Absent/empty (a new account, or a Brain outage) -> no block at all, and
    // the builder behaves exactly as it did before this existed.
    let priorsBlock = '';
    try {
      const rows = Array.isArray(driverPriors) ? driverPriors.slice(0, 8) : [];
      const lines = rows
        .filter(r => r && typeof r === 'object' && r.driver)
        .map(r => {
          const d = String(r.driver).slice(0, 40);
          const n = Number(r.n) || 0;
          const m = Number(r.medianMultiplier);
          const perf = Number.isFinite(m) ? `${Math.round(m * 10) / 10}x normal views` : 'no outcome data yet';
          return `- ${d}: ${perf} (measured across ${n} video${n === 1 ? '' : 's'})`;
        });
      if (lines.length) {
        priorsBlock = `\n\nWHAT THIS ACCOUNT HAS ALREADY LEARNED \u2014 measured outcomes of its own analysed and posted videos, not theory. Only mechanisms with enough evidence to be worth trusting are listed:\n${lines.join('\n')}\n\nUse this when writing PLAN: if the source's driver has performed well here, lean into it harder. If it has performed poorly, say so plainly in PLAN and shift the improvement toward a mechanism that HAS worked \u2014 without abandoning the source's core idea, and never by inventing something the frames cannot support.`;
      }
    } catch (_) { priorsBlock = ''; }

    // ── Change-background mode (spec supplied by Mike 2026-08-18, locked) ──
    // Deliberately the MINIMAL DIRECTIVE format, not the heavy 3-block
    // CRITICAL KEEP / CRITICAL CHANGE / DO NOT structure used for from-scratch
    // generation: re-describing what is already in the reference video creates
    // semantic conflict with it and degrades fidelity. Trust the reference.
    const BG_SWAP_SYSTEM = `You are an expert Seedance video prompt engineer with one focus: prompts that recreate the user's own existing video while changing ONLY the background or environment. Nothing else. You do not handle from-scratch generation or other formats.

OUTPUT FORMAT — follow exactly, no markdown fences, no preamble, no closing commentary:

ANALYSIS
<3 to 5 lines only. State: total duration in seconds; number of distinct scenes / hard cuts (or "single continuous scene with micro-cuts"); foreground elements to preserve (person, hands, product, key props, actions); background elements being replaced; any text overlays present in the source; any safety, brand-safety or IP flag worth raising (apparent age of subject, sensitive setting, copyrighted elements) — flag briefly, never refuse, offer options.>

PROMPT A | <short vibe label>
<the complete prompt, ready to copy-paste>

PROMPT B | <short vibe label>
<only when the brief has interpretive room — see TWO-VERSION RULE>

MANDATORY TEMPLATE — every prompt uses this exact structure:

This is a recreation of my own original ~[X]-second vertical iPhone UGC video. I own @video_1 and all rights to it.

@video_1 is the full reference for everything in the output — [brief list of what to preserve: person, hands, product description, actions, shot structure, cut timing, camera angles, framing, iPhone UGC realism]. Keep the entire foreground absolutely identical to @video_1.

The ONLY changes:
(1) [Specific description of the background / environment / element swap, written richly enough to give Seedance a clear creative direction]
(2) The output contains absolutely NO text, NO captions, NO subtitles, NO emoji, NO graphic overlays anywhere in the video — zero text of any kind at any moment.

Ultra-realistic iPhone UGC look throughout, with zero text.

LOCKED RULES — apply to every prompt without exception:
1. OWNERSHIP CLAUSE: always open with the "recreation of my own original... I own @video_1 and all rights to it" line. It clarifies legitimacy and passes classifier safety checks.
2. FULL REFERENCE FRAMING: always state "@video_1 is the full reference for everything in the output". Trust the reference; never re-describe the shots in granular shot-by-shot detail.
3. "ONLY change" FRAMING: always isolate the delta as a numbered list. (1) is always the environment/element swap, (2) is always the text strip. This two-point structure is mandatory.
   (Audio, duration and aspect ratio are NOT written into the prompt: the tool sets audio off
   and the format via API parameters — generate_audio:false, duration, aspect_ratio — so any
   words about them are noise the model has to ignore. Removed 2026-09-01.)
4. TRIPLE-LOCK TEXT STRIP: always include the explicit no-text line, worded as in the template.
5. REALISM CLOSE: always close with "Ultra-realistic iPhone UGC look throughout, with zero text".
6. FOREGROUND INVENTORY: when describing what to keep, briefly list the ACTUAL elements visible in the frames — clothing, product, hand jewellery, surface props. Do not invent. Do not re-describe the video shot by shot.
7. ENVIRONMENT DENSITY: for the swap, be specific and visually rich — materials, colours, lighting tone, props, atmosphere. Never lazy ("luxurious room"). Write like "deep walnut wood panelled wall with brass accents, low-profile platform bed with cream linen, warm ambient pendant light, Persian rug on travertine floor". Density of specific visual elements produces better output.

DEFENSIVE FRAMING — if the source is a potentially sensitive context (bathroom + water, intimate-coded setting) and a classifier might block generation, layer these in: "styled product showcase set" instead of "real bathroom"; "clothed reviewer's hand" instead of "a hand"; "well-lit ambient product display lighting" instead of "moody dim lighting"; "no person present in the set" where applicable. Drop romantic/intimate/spa/sensual vocabulary. The ownership clause already helps; these push it further.

MULTI-SCENE EDGE CASE — if the source has distinct scenes needing different backgrounds, you may specify per scene within the single prompt: "For scenes where [foreground cue X] is visible, replace the background with [environment A]. For scenes where [foreground cue Y] is visible, replace the background with [environment B]." Say in the ANALYSIS that this is a stretch case and Seedance may mix the swaps, and recommend the fallback: split the source in CapCut, generate each scene as its own prompt, recombine in post.

TWO-VERSION RULE — if the creative direction has interpretive room ("make it luxurious", "Star Wars themed", "a cool nighttime spot"), deliver PROMPT A and PROMPT B with meaningfully DIFFERENT aesthetic directions, not minor tweaks, each with a short vibe label. If the brief is already highly specific ("matte black walls + brass fixtures + travertine floor"), deliver PROMPT A only — do not pad with a near-identical variant.

CRITICAL DON'TS — never use the heavy 3-block CRITICAL KEEP / CRITICAL CHANGE / DO NOT structure here. Never re-describe the source shot by shot. Never deliver partial blocks or "insert this here" instructions; every prompt must be complete and copy-pasteable. Never skip the text strip, the audio strip, or the ANALYSIS section. Never add disclaimers, caveats or filler.`;

    const systemPrompt = `You are a short-form video strategist and prompt engineer. Study the frames and transcript carefully and follow these five steps exactly.

STEP 0 — DIAGNOSE WHY THIS VIDEO WENT VIRAL. Do this FIRST, before you write a single word of the prompt, and commit to the answer in the output — every later step must serve it.
A video does not travel because it looks good. It travels because ONE mechanism does the work: it stops the scroll, holds attention, and gives the viewer a reason to rewatch, save or send it. Name that mechanism — do not describe the video.
Choose EXACTLY ONE primary driver, returning the token exactly as written:
- pattern_interrupt — a jarring or unexpected visual in the first seconds that breaks the scroll rhythm
- withheld_reveal — the payoff is deliberately delayed and the viewer stays to see it
- aspirational_fantasy — the viewer wants to BE this person or live this moment (lifestyle, status, being noticed, desirability)
- transformation — a visible before-to-after change
- relatable_tension — a frustration, struggle or social awkwardness the viewer recognises as their own
- curiosity_gap — an unanswered "how did they do that / what happens next" drives the watch
- social_proof_reaction — someone in frame visibly reacts to the subject, and THAT reaction is the payload
- comedic_subversion — a setup followed by a twist that lands as a joke
- loop_bait — the ending flows back into the opening, or the clip is short enough to rewatch compulsively
- info_density — genuinely useful information delivered fast; saved rather than shared
- other — only when nothing above genuinely fits
Rules for this step:
- Judge ONLY from what is in the frames and transcript. Never from the caption, the follower count, or an assumption about the account.
- If several mechanisms are present, name the one the video would DIE without. The rest belong in the plan, not the driver.
- Be honest when the driver is audio-dependent (a trending sound, a spoken punchline). Say so in LIMIT — a silent visual recreate cannot inherit it, so the plan must substitute a VISUAL equivalent rather than pretend the problem away.
- Never inflate. If the video is ordinary and its reach probably came from the creator's existing audience rather than the content, say exactly that in WHY and pick the closest driver anyway.

STEP 1 — CLASSIFY THE SOURCE as exactly one of TWO lanes:
- AUTHENTIC: phone-shot / creator-made — handheld or propped phone, casual real-world setting, available or simple lighting, unpolished. The huge majority of viral short-form lives here.
- HIGH-END: professionally produced — cinema or commercial camera work, deliberate composition, controlled lighting, graded color.

This classification is INTERNAL — it only decides which realism layer Step 3 appends. Never print a lane name anywhere in the output. When genuinely torn, choose AUTHENTIC — polished-looking creator content is still phone-made far more often than it looks.

STEP 2 — BUILD THE BASE PROMPT using this structure: Shot scaffold + Subject + Action + Environment + Camera + Lighting + Style. Rules:
- 🎯 SERVE THE STEP 0 DRIVER — this outranks every other rule here. The shot that delivers the driver gets the most words and the clearest description; anything that does not serve it gets cut to make room. You are re-engineering ONE mechanism to hit harder, not redecorating a scene. Never name the driver token inside the prompt itself — it is a decision, not prompt text.
- 🪝 PRESERVE THE HOOK MECHANISM — do this FIRST, before describing anything else. The leading labelled frames are the source's 0-3s hook window in order. Work out WHY that opening stops a scroll: the MECHANISM, not the scenery. Common mechanisms: starting mid-action with no setup, an object or person entering frame unexpectedly, a reveal deliberately withheld, a direct look to lens, an implied question, a jarring visual pattern-interrupt, an on-screen text claim. Then rebuild THAT SAME mechanism as the opening shot [0-2s] — same trigger, same timing, same thing withheld — dressed in the new subject and setting. Copying the source's setting while opening calmly throws away the one thing that made it work: a faithful-looking recreate with a dead first two seconds is the single most common way these fail. If the source opens on on-screen text, say so and carry an equivalent line.
- 🎭 REACTION IS OFTEN THE HOOK — CONDITIONAL: study the frames for a BYSTANDER REACTION: someone in the scene visibly reacting to the subject — a head-turn, a double-take, an admiring or shocked glance, a person stopping to look. For "someone walks through a public place" content this reaction IS the viral payload (the fantasy is being noticed). If the source clearly has one, identify WHO reacts and HOW, and preserve that exact shot at the moment it occurs — e.g. "[2-4s]: a woman nearby turns her head to look back at [INFLUENCER] with a lingering admiring glance". Only include this when the source actually shows it; if there is no such reaction, do NOT invent one or add generic "bystanders staring" filler.
- 🎯 DESCRIBE ONLY WHAT IS LITERALLY IN FRAME — never infer a comedic bit, a held product/prop, or a "can't-believe-this" gesture the frames do not plainly show. An arm raised to run a hand through the hair, or hands clasped behind the head, is a confident grooming gesture, NOT a head-grab, and there is no product in hand unless one is clearly visible. Inventing an action the source never had is worse than describing it plainly.
- Open with a short capture-style scaffold as the very first clause — plain language matching the Step 1 lane, but never the lane word itself and never aspect ratio or duration (the tool sets 9:16 and clip length separately). E.g. "Handheld phone selfie capture:" or "Cinema camera capture:". Never bury this mid-prompt
- Use [INFLUENCER] as the person placeholder — do NOT describe physical appearance (no hair color, eye color, skin tone, height, build — reference photos handle that)
- Describe outfit, action, environment, mood, shot progression
- Use ONE primary camera movement, chosen from Seedance's own vocabulary: push-in, pull-out, pan, tracking/follow, orbit, handheld, fixed. A compound move must be sequential ("slow push-in then subtle rise") — never simultaneous ("dolly in while panning left")
- Keep camera movement and subject movement in SEPARATE clauses — mixing them in one clause is Seedance's most common documented failure mode
- Name specific lighting direction and quality, and make it slightly imperfect — real light is uneven ("warm window light from the left, slightly hot on one cheek, soft shadow falloff to the right" beats "natural lighting")
- Ground the scene in a lived-in world: one or two ordinary specific details (a half-empty glass on the counter, a jacket over the chair, a slightly crooked picture frame) beat a clean empty backdrop — real rooms are never perfectly tidy or symmetric
- If any shot shows hands touching an object (phone, cup, product, fabric), anchor the hand explicitly to it (e.g. "fingers grip the phone case") — free-floating hand descriptions are the most common cause of hand artifacts
- Break the action into timestamped shots in sequence: [0-2s]: opening shot. [2-5s]: main action. Keep each shot to 1-2 sentences. Weave natural involuntary human motion through the shots: a soft slightly-uneven blink (never metronomic), a visible breath with gentle shoulder rise, a glance at something specific then back (gaze always has a destination — a locked dead-center stare renders as frozen and glassy), a small weight shift or self-adjustment (brushing a strand of hair back, tugging a sleeve). Different body parts move on slightly different timing — overlapping, never synchronized
- If the person walks in any shot, describe real gait mechanics: heel-to-toe footsteps with weight shifting onto each leg, arms swinging opposite the legs, head staying level — never a gliding or floating walk
- Cover the FULL sequence of the video start to finish — every distinct shot and every notable reaction, in order, not just the hook plus one main action. Do not compress or drop moments to save words. Stay within ~150 words (Seedance's attention ceiling) and spend them where the driver lives — this is an IMPROVED version, not a copy, so a beat that does not serve the driver may be shortened or dropped to buy words for the one that does.

STEP 3 — DO NOT append any realism layer, camera-quality block, fps mention, or avoid-list yourself.
ALSO BANNED ANYWHERE IN THE PROMPT, not just the opening clause:
  (a) aspect ratio, resolution or duration in ANY form — no "9:16", no "vertical", no "1080p", no "8 seconds total", no "[0-2s]"-style totals at the end. The tool sets the format and the clip length separately, so any figure you write is either ignored or actively contradicts the real setting. Timestamped SHOTS inside the action (e.g. [0-2s], [2-5s]) are fine and wanted; a stated total duration or frame format is not.
  (b) the person's physical appearance — no hair colour or length, eye colour, skin tone, age, height, build, ethnicity or tattoos. The user swaps in their own AI Influencer whose look is set by reference photos, and references beat prompt text on anything they depict, so a description of the SOURCE person can only fight those references. Write [INFLUENCER] and describe what they DO and WEAR, never what they look like. The server appends the lane's realism layer in code (so the user can switch lanes afterwards). Your base prompt must not duplicate that content — never write sensor noise / film grain lines, and never demand "sharp clarity" or "stable picture". There is deliberately NO avoid-list any more: do not write "avoid ..." lines of your own either. Every word you spend is a word inside a ~150-word attention budget, so spend them on the hook, the action and the light.

OUTPUT FORMAT — exactly this, nothing else:
Line 1: "LANE: AUTHENTIC" or "LANE: HIGH-END" (stripped by the server and shown to the user as a switchable choice — it is the ONLY place the lane may appear).
Line 2: "TALKING: YES" or "TALKING: NO" — YES only if the video is a TALKING-HEAD: a person on camera actually SPEAKING/narrating to the viewer with lip-synced spoken words (a monologue, piece-to-camera, vlog talk, interview answer). NO for everything else — music videos / lip-syncing to a song / singing, dance, product b-roll, montage, voiceover-over-visuals with no on-camera speaker, or no speech at all. When unsure, answer NO.
Line 3: "DRIVER: <token>" — the single Step 0 token, exactly as written in the list.
Line 4: "WHY: <one sentence>" — why THAT mechanism made this specific video travel, citing what you actually see (a moment, a timestamp, a reaction). No hedging, no generic praise.
Line 5: "BEAT: <one sentence>" — the exact moment in the source that delivers the driver (e.g. "the head-turn from the woman passing at ~4s").
Line 6: "PLAN: <one or two sentences>" — how the prompt you are about to write makes that mechanism hit HARDER than the original. Be concrete and specific to this video.
Line 7: "LIMIT: <one sentence or 'none'>" — what will NOT transfer to an AI recreate (audio-dependent punchline, a real location, a named person, on-screen text) and what you substituted instead.
Then a blank line, then ONLY the Step 2 base prompt text. No JSON, no explanation, no markdown, and never a lane word or a driver token inside the prompt itself.`;

    // Lane realism layers + negative suffix are appended in CODE (not by Claude) so
    // they are verbatim-stable — the frontend holds both layers and can swap them
    // exactly when the user overrides the detected lane before generating.
    const LANE_LAYERS = {
      'AUTHENTIC': 'Filmed on a smartphone: natural hand tremor with small framing corrections, slightly off-center framing, mild lens softness, faint sensor noise, mild compression artifacts, small auto-exposure shifts, uneven ambient lighting with natural shadow falloff, real skin with visible pores and tiny blemishes, no beauty filter, stray hair flyaways, natural facial asymmetry, lived-in surroundings, unedited social-media snapshot look, with everyday handheld phone-video motion.',
      'HIGH-END': 'Shot on a cinema camera: subtle lens vignetting, gentle highlight halation, fine organic film grain, controlled lighting with soft physical falloff and true shadows, photorealistic skin keeping pores and micro-texture under the key light, restrained filmic color grade, performers with natural body weight and visible breath, never posed stillness, with the smooth cadence of film.',
    };
    // Footwear is stated explicitly because the influencer's own full-body
    // reference photo is a plain studio shot and is very often BAREFOOT (it is
    // generated for ink/proportion capture, not wardrobe). Seedance faithfully
    // reproduces that reference, so without this line the persona walks out of a
    // car or down a street with no shoes on. Phrased as a setting rule rather
    // than "always wear shoes" so beach/pool/at-home scenes stay correct.
    // ⛔ THE WHOLE CODE-APPENDED TAIL IS GONE (2026-08-31, Mike, in three passes).
    // It was 63 words on EVERY recreate prompt, and the measured median prompt is 254
    // words against Seedance's ~150-word attention ceiling — so the tail sat at word
    // ~224 and was very likely never read at all. What it used to hold:
    //   • FOOTWEAR (43w) — the root fix is upstream: footwearClause in the Studio's
    //     portrait generator puts real sneakers on the master, and references beat
    //     prompt text on anything they depict. VIDEO_QUALITY_SUFFIX dropped its own
    //     copy 2026-08-30; this one was simply never swept. If footwear regresses,
    //     the fix is a shod master, NOT a sentence.
    //   • NO MUSIC (8w) — now the generate_audio:false PARAMETER on both recreate
    //     paths. Deterministic where a sentence was a hope, and it removes the
    //     ByteDance copyright-filter class that silently kills a paid generation.
    //   • AVOID-LIST (12w: jitter, bent limbs, temporal flicker, warping/morphing,
    //     extra fingers) — Mike: "AI nowadays doesn't have extra fingers and limbs".
    //     Correct for 2026 models; the finger/limb guards are SDXL-era. ⚠️ The one
    //     item with recent evidence behind it was WARPING/MORPHING — our own logs
    //     record print/logo smear during camera transitions (Streetwear Editorial,
    //     2026-07-11) and morph-smear from prompts asking for fake cuts. If that
    //     ever comes back, restore ONLY that: append ' Avoid warping or morphing.'
    //     here — do NOT restore the full five, and do not re-add footwear or music.

    // Kie.ai's Claude endpoint is native Anthropic Messages format (verified
    // 2026-07-17 with real base64 frames — identical request shape, model
    // string and auth header are the only differences), so the same
    // system/messages body serves both branches.
    // bgswap needs the real measured duration (rule 6 forbids estimating it) and a
    // far larger token budget: analysis + up to two full templated prompts.
    // ── May-2026 director prompt, verbatim EXCEPT the model name ──
    // Reproduced exactly for the A/B (Mike: "don't change anything, do exactly that").
    // The ONE deviation: May said "Wan 2.6 prompt" (the model then); we generate on
    // Seedance now, and naming a different video model would make Claude write for
    // Wan's conventions and sabotage the very comparison — so the model word is
    // neutralised to "video". Everything else is the May instruction word-for-word.
    const ORIGINAL_CLONE_SYSTEM = 'You are a video director. Study these frames and transcript carefully and create a video prompt that recreates this EXACT video 1:1 — same scene, camera angle, lighting, composition, energy, movement, clothing style. Replace the original creator with [INFLUENCER]. ACCURACY OVER EMBELLISHMENT: describe only what the frames actually show. Do NOT add, amplify or invent onlookers, crowd reactions, paparazzi energy, or bystanders holding up phones to film [INFLUENCER]. Reproduce the real, actual level of background attention in the source and no more. IF the source clearly shows a specific bystander reaction (a head-turn, a double-take, an admiring glance), preserve that ONE exact beat at its moment; otherwise keep any background people incidental and do NOT add "everyone filming", "celebrity sighting", or "crowd staring" filler. PARAMETERS ARE NOT PROSE: never state aspect ratio, resolution, duration, frame rate or format in the prompt (no "vertical 9:16", no "1080p", no "8 seconds", no "24fps", no "portrait format") — the tool sets those separately; write only the scene, subject, action, camera and lighting. Return only the prompt text, no JSON, no explanation.';
    // 'realism' = the EXACT May 1:1 prompt (same body/user message as 'original') with the lane realism
    // layer appended — the ONLY difference from 'original'. A LANE line is added so authentic vs high-end
    // is auto-classified per video; the server strips that line and appends LANE_LAYERS[lane].
    const REALISM_CLONE_SYSTEM = ORIGINAL_CLONE_SYSTEM.replace('Return only the prompt text, no JSON, no explanation.', 'FIRST output a single line — exactly "LANE: AUTHENTIC" if the source looks phone-shot / UGC / handheld, or "LANE: HIGH-END" if it looks cinematic / professionally lit / polished. Then a blank line, then only the prompt text (no JSON, no explanation, and never mention the lane again inside the prompt).');
    const originalUserText = transcript
      ? `These ${frameBase64s.length} frames were extracted from the viral video. Transcript: "${transcript}"\n\nCreate the video prompt.`
      : `These ${frameBase64s.length} frames were extracted from the viral video (no audio). Create the video prompt.`;
    // Both recreate arms use the verbatim May 1:1 director body. 'realism' only adds the LANE line
    // (so the server can append the realism layer). The July scaffolded/timestamped builder is gone
    // from the recreate path entirely — its condensing/re-engineering was the suspected viral-cliff cause.
    const sysFinal = isBgSwap ? BG_SWAP_SYSTEM
      : promptStyle === 'improve' ? systemPrompt          // the scaffolded/hook-optimised builder, used to IMPROVE (not copy)
      : promptStyle === 'realism' ? REALISM_CLONE_SYSTEM
      : ORIGINAL_CLONE_SYSTEM;
    const userFinal = isBgSwap
      ? `These ${frameBase64s.length} frames were extracted from my own source video. `
        + `Its exact duration is ${Math.round(duration * 10) / 10} seconds — use this figure, do not estimate.\n\n`
        + `The background change I want: ${String(bgBrief || '').trim() || '(none specified — ask one clarifying question in the ANALYSIS instead of guessing)'}`
      : promptStyle === 'improve'
        ? `IMPROVE MODE — this is NOT a faithful 1:1 copy. Complete STEP 0 first and commit to a driver, then write a prompt for a STRONGER version of the same core concept: sharpen the hook, tighten the pacing and heighten the payoff to maximise scroll-stopping power and watch-through. Keep [INFLUENCER] as the subject and keep the winning idea, but you MAY change setting, props, shot order or ending if it makes the video more likely to go viral.${improveBrief ? ` The user's specific direction: "${improveBrief}" — prioritise this.` : ''}\n\n` + userText + hookBlock + priorsBlock
        : originalUserText;   // 'original' and 'realism' use the verbatim May user message — the only
                              // difference between them is the realism layer, appended below for 'realism'/'improve'
    const maxTok = isBgSwap ? 2600 : 1000;

    let claudeResponse;
    if (kieApiKey) {
      // Kie.ai's backend has a real ceiling well under 80 images — verified
      // live: identical requests succeed FAST at 10-20 images but HANG for
      // ~90-100s before failing anywhere near 40+ (not a quick rejection —
      // Kie's own gateway grinds on the request then times out server-side).
      // A retry ladder starting at 80 would burn 100s+ per failed tier,
      // blowing past clone-proxy's 120s client timeout before ever reaching
      // a tier that works. So: go straight to the proven-fast/working tier
      // (KIE_SAFE_FRAME_COUNT) — no wasted attempts at sizes we already know
      // hang. Anthropic direct (the owner path below) has no such limit and
      // keeps the full 80-frame budget unchanged.
      // The hook frames are images too, so they come OUT of the same ceiling — 16 evenly
      // sampled + 4 hook = 20, not 24. Budgeting them keeps the proven-safe total intact.
      const KIE_SAFE_FRAME_COUNT = 20;
      const n = Math.min(KIE_SAFE_FRAME_COUNT - hookImgCount, imageContent.length);
      const subset = n === imageContent.length
        ? imageContent
        : Array.from({ length: n }, (_, i) => imageContent[Math.round(i * (imageContent.length - 1) / (n - 1))]);
      const note = n < imageContent.length ? ` (${n} representative frames shown, evenly sampled from the full clip.)` : '';
      claudeResponse = await axios.post('https://api.kie.ai/claude/v1/messages', {
        model: 'claude-sonnet-5', max_tokens: maxTok, system: sysFinal,
        messages: [{ role: 'user', content: [...hookContent, ...subset, { type: 'text', text: userFinal + note }] }]
      }, { headers: { 'Authorization': `Bearer ${kieApiKey}`, 'Content-Type': 'application/json' }, timeout: 80000 });
    } else {
      claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6', max_tokens: maxTok, system: sysFinal,
        messages: [{ role: 'user', content: [...hookContent, ...imageContent, { type: 'text', text: userFinal }] }]
      }, { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    }

    let basePrompt = claudeResponse.data?.content?.[0]?.text?.trim() || '';
    if (!basePrompt) return res.status(500).json({ success: false, error: 'Empty response from Claude' });

    // bgswap returns before ALL of the lane/realism-layer post-processing below —
    // none of it applies to a recreate+swap prompt, and appending a realism layer
    // would contradict rule 8's fixed close.
    if (isBgSwap) {
      const secA = basePrompt.split(/^ANALYSIS\s*$/mi)[1] || basePrompt;
      const parts = secA.split(/^PROMPT\s+([A-Z])\s*(?:\|\s*(.*))?$/mi);
      const analysis = (parts[0] || '').trim();
      const prompts = [];
      for (let i = 1; i < parts.length; i += 3) {
        const body = (parts[i + 2] || '').trim();
        if (body) prompts.push({ id: parts[i], label: (parts[i + 1] || '').trim(), text: body });
      }
      return res.json({
        success: true,
        mode: 'bgswap',
        analysis,
        prompts,
        // Raw text always returned: if the model ever drifts from the section
        // format the frontend can still show something useful rather than nothing.
        raw: basePrompt,
        durationSec: Math.round(duration * 10) / 10,
        firstFrameUrl: firstFrameUrl || frameDataUrls[0] || '',
        sourceVideoUrl,
        sourceVideoToken,
        metadata: { duration: Math.round(duration) + 's', frameCount: frameBase64s.length },
      });
    }

    // The builder outputs the lane classification on line 1 ("LANE: AUTHENTIC" /
    // "LANE: HIGH-END") — strip it (the prompt itself must never carry a lane
    // label), then compose base + lane layer + negative suffix in code so the
    // frontend can swap layers exactly when the user overrides the lane.
    let lane = 'AUTHENTIC';
    const laneMatch = basePrompt.match(/^LANE:\s*(AUTHENTIC|HIGH-END)\s*\n+/i);
    if (laneMatch) {
      lane = laneMatch[1].toUpperCase();
      basePrompt = basePrompt.slice(laneMatch[0].length).trim();
    }
    // TALKING: YES|NO on the next line — whether this is a genuine talking-head
    // (spoken narration to camera). Used to gate the "exact script" feature so a
    // music/lip-sync/no-speech video never surfaces a made-up "script".
    let talkingHead = false;
    const talkMatch = basePrompt.match(/^TALKING:\s*(YES|NO)\s*\n+/i);
    if (talkMatch) {
      talkingHead = talkMatch[1].toUpperCase() === 'YES';
      basePrompt = basePrompt.slice(talkMatch[0].length).trim();
    }
    // 🧠 WHY-IT-WENT-VIRAL REPORT (improve mode only). Parsed AFTER the LANE and
    // TALKING strips so those two anchored regexes keep matching line 1 / line 2
    // exactly as before — the report lines are appended below them, never above.
    //
    // Every field is optional by design: if the model drops a line we keep the
    // rest and the prompt still ships. A missing report degrades the UI to what
    // it showed yesterday; it must never fail an analysis the user paid for.
    let viralReport = null;
    {
      const pull = (label) => {
        const m = basePrompt.match(new RegExp('^' + label + ':\\s*(.+?)\\s*$', 'im'));
        return m ? m[1].trim() : '';
      };
      const rawDriver = pull('DRIVER').toLowerCase().replace(/[^a-z_]/g, '');
      const driver = VIRAL_DRIVERS.includes(rawDriver) ? rawDriver : '';
      const why   = pull('WHY').slice(0, 400);
      const beat  = pull('BEAT').slice(0, 300);
      const plan  = pull('PLAN').slice(0, 500);
      let   limit = pull('LIMIT').slice(0, 300);
      if (/^none\.?$/i.test(limit)) limit = '';
      if (driver || why || plan) viralReport = { driver, why, beat, plan, limit };
      // Strip every report line out of the prompt body. Anchored per line so a
      // sentence inside the prompt that merely CONTAINS one of these words is
      // untouched \u2014 only a real line-leading "LABEL:" is removed.
      basePrompt = basePrompt
        .replace(/^(DRIVER|WHY|BEAT|PLAN|LIMIT):.*$/gim, '')
        .replace(/^\s*\n+/, '')
        .trim();
    }

    const clonePrompt = (promptStyle === 'realism' || promptStyle === 'improve') ? `${basePrompt} ${LANE_LAYERS[lane]}` : basePrompt;

    res.json({
      success: true,
      frames: frameDataUrls,
      frameTimestamps,
      hookFrames,
      durationSec: Math.round(duration * 10) / 10,
      firstFrameUrl: firstFrameUrl || frameDataUrls[0] || '',
      sourceVideoUrl,
      sourceVideoToken,
      transcript,
      transcriptError: transcriptError || undefined,
      talkingHead,
      lane,
      laneLayers: LANE_LAYERS,
      ...recommendRecreateSpec(duration),
      metadata: { duration: Math.round(duration) + 's', frameCount: frameBase64s.length, hasAudio: !!transcript },
      sourceAudio,
      promptStyle,
      viralReport,
      viralDrivers: VIRAL_DRIVERS,
      clonePrompt
    });

  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.response?.data?.msg || err.message;
    res.status(status).json({ success: false, error: message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─────────────────────────────────────────
// FACE SWAP — frame-by-frame identity lock
// ─────────────────────────────────────────

const { execFile } = require('child_process');
const PYTHON = '/opt/venv/bin/python3';
const FACESWAP_SCRIPT = path.join(__dirname, 'faceswap.py');

// In-memory job store (Railway is long-running, not serverless)
const faceswapJobs = new Map(); // jobId -> { status, videoPath, error, createdAt }

function cleanOldJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
  for (const [id, job] of faceswapJobs) {
    if (job.createdAt < cutoff) {
      if (job.tmpDir) try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch (_) {}
      faceswapJobs.delete(id);
    }
  }
}

async function runFaceswap(jobId, videoUrl, faceUrl) {
  const job = faceswapJobs.get(jobId);
  const tmpDir = path.join(os.tmpdir(), `faceswap_${jobId}`);
  job.tmpDir = tmpDir;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const videoPath  = path.join(tmpDir, 'input.mp4');
    const facePath   = path.join(tmpDir, 'face.jpg');
    const framesDir  = path.join(tmpDir, 'frames');
    const swappedDir = path.join(tmpDir, 'swapped');
    const outputPath = path.join(tmpDir, 'output.mp4');
    fs.mkdirSync(framesDir, { recursive: true });
    fs.mkdirSync(swappedDir, { recursive: true });

    // 1. Download video + face image
    job.step = 'downloading';
    console.log(`[faceswap:${jobId}] downloading video...`);
    const [vidResp, faceResp] = await Promise.all([
      axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000 }),
      axios.get(faceUrl,  { responseType: 'arraybuffer', timeout: 30000 }),
    ]);
    fs.writeFileSync(videoPath, vidResp.data);
    fs.writeFileSync(facePath,  faceResp.data);
    console.log(`[faceswap:${jobId}] downloaded. video=${(vidResp.data.byteLength/1024).toFixed(0)}KB`);

    // 2. Extract frames at 24fps
    job.step = 'extracting_frames';
    console.log(`[faceswap:${jobId}] extracting frames...`);
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions(['-vf', 'fps=24,scale=iw:ih', '-q:v', '2'])
        .output(path.join(framesDir, 'frame_%04d.jpg'))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    const frameCount = fs.readdirSync(framesDir).length;
    console.log(`[faceswap:${jobId}] extracted ${frameCount} frames`);

    // 3. Python face swap
    job.step = 'swapping_faces';
    job.frameCount = frameCount;
    console.log(`[faceswap:${jobId}] running InsightFace on ${frameCount} frames...`);
    await new Promise((resolve, reject) => {
      const py = execFile(PYTHON, [FACESWAP_SCRIPT, facePath, framesDir, swappedDir], { timeout: 10 * 60 * 1000 });
      py.stderr.on('data', d => process.stdout.write(d));
      py.stdout.on('data', d => process.stdout.write(d));
      py.on('close', code => code === 0 ? resolve() : reject(new Error(`faceswap.py exited ${code}`)));
    });
    console.log(`[faceswap:${jobId}] face swap complete`);

    // 4. Reassemble video with original audio
    job.step = 'reassembling';
    console.log(`[faceswap:${jobId}] reassembling video...`);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(swappedDir, 'frame_%04d.jpg')).inputFPS(24)
        .input(videoPath)
        .outputOptions(['-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', (err) => {
          // Try without audio if audio stream missing
          ffmpeg()
            .input(path.join(swappedDir, 'frame_%04d.jpg')).inputFPS(24)
            .outputOptions(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        })
        .run();
    });
    console.log(`[faceswap:${jobId}] reassembly done`);

    job.status = 'done';
    job.videoPath = outputPath;
    console.log(`[faceswap:${jobId}] ✅ complete`);

  } catch (err) {
    console.error(`[faceswap:${jobId}] ❌ error:`, err.message);
    job.status = 'error';
    job.error = err.message;
  }
}

// POST /api/faceswap — start async face swap job
app.post('/api/faceswap', async (req, res) => {
  cleanOldJobs();
  const { videoUrl, faceUrl } = req.body;
  if (!videoUrl || !faceUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl or faceUrl' });

  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  faceswapJobs.set(jobId, { status: 'processing', step: 'queued', createdAt: Date.now() });

  // Run async — don't await
  runFaceswap(jobId, videoUrl, faceUrl).catch(() => {});

  res.json({ success: true, jobId });
});

// GET /api/faceswap/status/:jobId
app.get('/api/faceswap/status/:jobId', (req, res) => {
  const job = faceswapJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({
    success: true,
    status: job.status,   // 'processing' | 'done' | 'error'
    step: job.step,
    frameCount: job.frameCount,
    error: job.error || null,
  });
});

// GET /api/faceswap/download/:jobId — serve the processed video
app.get('/api/faceswap/download/:jobId', (req, res) => {
  const job = faceswapJobs.get(req.params.jobId);
  if (!job || job.status !== 'done' || !job.videoPath) {
    return res.status(404).json({ success: false, error: 'Video not ready' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="faceswap_output.mp4"');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(job.videoPath).pipe(res);
});

// ─────────────────────────────────────────
// TEMP VIDEO HOST — download & serve for fal.ai video_urls
// ─────────────────────────────────────────

const tempVideos = new Map(); // token -> { filePath, createdAt }

// ─────────────────────────────────────────
// PROCESS GUARDS
//
// On Node 22 an unhandled promise rejection TERMINATES the process — which on
// this single-container service means every in-flight request dies with a 502,
// not just the one that threw. Flagged 2026-08-06 as "the first thing to
// instrument if the 502 recurs" (it then recurred on 2026-08-28 for captions)
// and never added. Logging and staying up is strictly better here: the request
// that caused it still fails on its own, but it no longer takes its neighbours
// down with it.
// ─────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL-GUARD] unhandledRejection:', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL-GUARD] uncaughtException:', err && err.stack || err);
});

function cleanOldTempVideos() {
  const cutoff = Date.now() - 30 * 60 * 1000; // 30 min TTL
  for (const [token, v] of tempVideos) {
    if (v.createdAt < cutoff) {
      try { fs.unlinkSync(v.filePath); } catch (_) {}
      tempVideos.delete(token);
    }
  }
}

// cleanOldTempVideos was only called by /api/temp-video and /api/faststart — but
// SEVEN routes write into this map (room-sound, burn-captions, stitch,
// assemble-reel and variants were the five that never pruned). Their output
// files are large (a 26MB recreate, a 45MB variant set) and are dead ~30 min
// after the caller re-hosts to Blob, so they accumulated on the container disk
// until one of the two pruning routes happened to be hit. A timer also covers
// the idle case, where no request comes in to trigger a prune at all.
setInterval(cleanOldTempVideos, 5 * 60 * 1000).unref();

// POST /api/temp-video — download video via yt-dlp, return a public URL fal.ai can fetch
app.post('/api/temp-video', async (req, res) => {
  cleanOldTempVideos();
  const { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputPath = path.join(os.tmpdir(), `tempvid_${token}.mp4`);

  try {
    const isInstagram = /instagram\.com\/(p|reel|reels)\//.test(videoUrl);

    if (isInstagram) {
      console.log(`[tempvid:${token}] downloading via Apify: ${videoUrl.slice(0, 60)}`);
      await downloadInstagramViaApify(videoUrl, outputPath);
    } else {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);

      // Find yt-dlp binary
      let ytDlpPath;
      try { ytDlpPath = (await execFileAsync('which', ['yt-dlp'])).stdout.trim(); } catch (_) { ytDlpPath = '/usr/local/bin/yt-dlp'; }

      console.log(`[tempvid:${token}] downloading: ${videoUrl.slice(0, 60)}`);
      const runYtDlp = () => execFileAsync(ytDlpPath, [
        '--no-playlist', '-f', 'mp4/best[height<=720]', '--merge-output-format', 'mp4',
        '-o', outputPath, videoUrl,
      ], { timeout: 120000 });
      // Only TikTok gets the Apify fallback — a plain direct url has nothing to fall
      // back to, and paying for a scrape of a non-TikTok host would be wrong.
      if (/tiktok\.com\/@[^/]+\/video\/|tiktok\.com\/t\//.test(videoUrl)) {
        const via = (await downloadTikTok(videoUrl, outputPath, runYtDlp)).via;
        console.log(`[tempvid:${token}] tiktok via ${via}`);
      } else {
        await runYtDlp();
      }
    }

    if (!fs.existsSync(outputPath)) throw new Error('Download produced no output file');
    const stat = fs.statSync(outputPath);
    console.log(`[tempvid:${token}] downloaded: ${Math.round(stat.size / 1024)}KB`);

    tempVideos.set(token, { filePath: outputPath, createdAt: Date.now() });
    const publicUrl = `${req.protocol}://${req.get('host')}/api/temp-video/${token}`;
    // NOTE: this response used to also spread `captionsBurned, captionError,
    // captionCues` — variables that only exist inside the assemble-reel route's
    // scope. That was a copy-paste slip which made EVERY temp-video call throw
    // ReferenceError → 500 (found 2026-08-25). Plain response only.
    res.json({ success: true, videoUrl: publicUrl, token });
  } catch (err) {
    try { fs.unlinkSync(outputPath); } catch (_) {}
    console.error(`[tempvid:${token}] error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/temp-video/:token — serve the downloaded video
// Range support added 2026-09-02: the recreate side-by-side comparison plays this
// URL directly in a browser <video>, and without 206 responses a viewer cannot
// SCRUB (Safari/iOS often refuses to play at all). Server-side consumers send no
// Range header and take the unchanged full-file 200 path, so nothing regresses.
app.get('/api/temp-video/:token', (req, res) => {
  const v = tempVideos.get(req.params.token);
  if (!v || !fs.existsSync(v.filePath)) return res.status(404).json({ error: 'Video not found or expired' });
  const size = fs.statSync(v.filePath).size;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (m) {
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null) { // suffix range: bytes=-N (last N bytes)
      const n = Math.min(end || 0, size);
      start = size - n; end = size - 1;
    } else if (end === null || end >= size) {
      end = size - 1;
    }
    if (!(start >= 0) || start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return fs.createReadStream(v.filePath, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', String(size));
  fs.createReadStream(v.filePath).pipe(res);
});

// POST /api/faststart — LOSSLESS remux of an mp4 so the moov index sits at the
// FRONT of the file. Kie/Seedance output puts moov at the very END (measured
// 2026-08-25: byte 26,439,127 of a 26.4MB file), so a phone <video> must
// range-fetch the head, then the tail, then seek back — which is why app
// videos load slowly. `-c copy` copies the streams byte-for-byte: zero
// re-encode, zero quality change (proven: identical stream MD5s), so the
// never-degrade-a-deliverable rule holds. Side effect worth knowing: the
// remux drops ByteDance's C2PA `uuid` atom, so the output is also free of
// the AI-generated metadata declaration. Result is registered in the
// tempVideos map (30-min TTL) for the caller to fetch and re-host permanently.
app.post('/api/faststart', async (req, res) => {
  cleanOldTempVideos();
  const { videoUrl } = req.body || {};
  if (!videoUrl || !/^https?:\/\//i.test(String(videoUrl))) {
    return res.status(400).json({ success: false, error: 'Missing videoUrl' });
  }
  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(os.tmpdir(), `fastin_${token}.mp4`);
  const outputPath = path.join(os.tmpdir(), `tempvid_${token}.mp4`);
  try {
    const dl = await axios.get(videoUrl, {
      responseType: 'arraybuffer', timeout: 180000,
      maxContentLength: 300 * 1024 * 1024,
    });
    fs.writeFileSync(inputPath, Buffer.from(dl.data));
    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size < 1000) {
      return res.status(400).json({ success: false, error: 'Could not download that video — the link may have expired.' });
    }
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
      return res.status(500).json({ success: false, error: 'Remux produced no output' });
    }
    const bytes = fs.statSync(outputPath).size;
    tempVideos.set(token, { filePath: outputPath, createdAt: Date.now() });
    console.log(`[faststart:${token}] remuxed ${Math.round(bytes / 1024)}KB`);
    res.json({ success: true, videoUrl: `${req.protocol}://${req.get('host')}/api/temp-video/${token}`, token, bytes });
  } catch (err) {
    console.error(`[faststart:${token}] error:`, err.message);
    try { fs.unlinkSync(outputPath); } catch (_) {}
    res.status(500).json({ success: false, error: String(err.message || err).slice(0, 200) });
  } finally {
    try { fs.unlinkSync(inputPath); } catch (_) {}
  }
});

// ─────────────────────────────────────────
// AUTO CAPTIONS — burns Instagram-style word-timed subtitles onto a
// talking-head video. Mike-only feature (gated on the Vercel side) — the
// Whisper transcription call has a real per-use cost, so this endpoint
// itself stays ungated (simple, stateless) and the caller is responsible
// for deciding who gets to use it.
// ─────────────────────────────────────────

const CAPTION_FONT_PATH = path.join(__dirname, 'assets', 'fonts', 'Caption-Bold.ttf');

// ⚠️ Instagram's own typeface (Instagram Sans) is proprietary and cannot be bundled or shipped in
// a rendered video, so these are the closest open equivalents to the styles their editor offers.
// Liberation faces are metric-compatible with Arial/Courier, which is what the "clean" and
// "typewriter" styles read as on a phone.
const CAPTION_FONTS = {
  strong:     CAPTION_FONT_PATH,                                              // Archivo Black — the classic burned-in Reels caption
  clean:      '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', // Arial-metric, Instagram's "Modern"
  typewriter: '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf', // Courier-metric
  serif:      '/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf',
};
// Height ratios measured against a 1920-tall frame: 0.0175 -> ~34px, which is the size Mike
// settled on after "way too big" (the first burn used 0.07 -> 134px and ran off both edges).
const CAPTION_SIZES = { small: 0.014, medium: 0.0175, large: 0.022, xlarge: 0.028 };

function captionFontPath(name) {
  const f = CAPTION_FONTS[String(name || '').toLowerCase()];
  if (f && fs.existsSync(f)) return f;
  return CAPTION_FONT_PATH;   // always exists — bundled in the repo
}

// ffmpeg drawtext text= values need specific characters escaped or the
// filter string parser breaks (colons separate filter options, backslashes
// and quotes have their own meaning). Order matters — escape backslashes first.
function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

async function getVideoDimensions(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const stream = meta.streams.find(s => s.codec_type === 'video');
      if (!stream) return reject(new Error('No video stream found'));
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

// Groups Whisper's word-level timestamps into 2-3 word caption chunks.
function groupWordsIntoChunks(words, groupSize = 3) {
  const chunks = [];
  for (let i = 0; i < words.length; i += groupSize) {
    const group = words.slice(i, i + groupSize);
    if (!group.length) continue;
    chunks.push({
      text: group.map(w => w.word.trim()).join(' '),
      start: group[0].start,
      end: group[group.length - 1].end
    });
  }
  return chunks;
}

// ── Room sound: make a studio-clean TTS voice fit its scene ──────────────────
// The voice we generate is podcast-clean, which reads as WRONG in a car or on a
// street. Two separate things are modelled: the MIC (a phone is band-limited and
// compressed, not merely "worse") and the ROOM (a low ambience bed).
//
// Runs AFTER lip-sync on purpose. The lip-sync engines do phoneme detection on the
// audio track, so mixing noise in BEFORE would degrade sync — the opposite of the
// 44.1kHz/256kbps TTS upgrade. Video is remuxed with -c:v copy, so this costs a few
// seconds and zero visual quality.
//
// Beds are SYNTHESISED with ffmpeg rather than fetched from a vendor: no key, no
// per-student cost, nothing to expire. At ~20dB under the voice a bed's job is to
// remove the "recorded in a vacuum" quality, not to be individually identifiable.
const ROOM_PROFILES = {
  studio: { bed: null,                                          bedDb: null, phone: false },
  room:   { bed: 'anoisesrc=color=brown:amplitude=0.9,lowpass=f=250', bedDb: -34, phone: true },
  car:    { bed: 'anoisesrc=color=brown:amplitude=0.9,lowpass=f=320', bedDb: -26, phone: true },
  street: { bed: 'anoisesrc=color=pink:amplitude=0.9,lowpass=f=1500,highpass=f=120', bedDb: -25, phone: true },
  cafe:   { bed: 'anoisesrc=color=pink:amplitude=0.9,highpass=f=300,lowpass=f=2500', bedDb: -28, phone: true },
  gym:    { bed: 'anoisesrc=color=brown:amplitude=0.9,lowpass=f=500', bedDb: -27, phone: true },
  office: { bed: 'anoisesrc=color=brown:amplitude=0.9,lowpass=f=400', bedDb: -32, phone: true },
};

app.post('/api/room-sound', async (req, res) => {
  const { videoUrl, profile, bedDb } = req.body || {};
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });
  const prof = ROOM_PROFILES[profile] || ROOM_PROFILES.room;
  const token = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-'));
  const inPath = path.join(tmpDir, 'in.mp4');
  const outPath = path.join(os.tmpdir(), `tempvid_${token}.mp4`);
  try {
    const r = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 90000 });
    fs.writeFileSync(inPath, Buffer.from(r.data));

    // A phone recording is fairly full-range — most of the effect comes from the
    // room and the compression, not from making the voice thin. Overdoing the EQ
    // makes it sound like a phone CALL instead of a phone RECORDING.
    const voice = prof.phone
      ? '[0:a]highpass=f=150,lowpass=f=6800,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,volume=3dB[v]'
      : '[0:a]anull[v]';

    let filter, amap;
    if (prof.bed) {
      const db = Number.isFinite(Number(bedDb)) ? Number(bedDb) : prof.bedDb;
      // normalize=0 is NOT optional: amix divides each input by the number of
      // inputs by default, which measured as a 19dB drop on the finished mix.
      filter = `${voice};${prof.bed},volume=${db}dB[bed];[v][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`;
      amap = '[a]';
    } else {
      filter = `${voice}`;
      amap = '[v]';
    }

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(inPath)
        .outputOptions(['-filter_complex', filter, '-map', '0:v', '-map', amap,
                        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k'])
        .output(outPath)
        .on('end', resolve)
        .on('error', (e) => {
          console.error('[room-sound] ffmpeg failed. profile=%s filter=%s', profile, filter.slice(0, 400));
          reject(e);
        });
      if (SYSTEM_FFMPEG) cmd.setFfmpegPath(SYSTEM_FFMPEG);
      cmd.run();
    });
    if (!fs.existsSync(outPath)) throw new Error('Room sound produced no output file');

    tempVideos.set(token, { filePath: outPath, createdAt: Date.now() });
    res.json({ success: true, videoUrl: `${req.protocol}://${req.get('host')}/api/temp-video/${token}`, token, profile: ROOM_PROFILES[profile] ? profile : 'room' });
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    console.error('[room-sound] error:', message);
    res.status(500).json({ success: false, error: message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// POST /api/audio-timings { audioUrl } -> { durationSec, words:[{word,start,end}] }
//
// The first-reel format is built on noun-sync: every concrete noun must be on screen at the
// second it is SPOKEN. Until now the shot timeline was derived from `words / 3.6` — an estimate.
// A real TTS render is never exactly that, and the error compounds down the script, so the last
// nouns drifted furthest. This measures the actual audio instead: Groq Whisper with word-level
// timestamps, the same machinery the caption burner already uses, pointed at an audio file.
app.post('/api/audio-timings', async (req, res) => {
  const { audioUrl } = req.body || {};
  if (!audioUrl) return res.status(400).json({ success: false, error: 'Missing audioUrl' });
  const sttKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!sttKey) return res.status(500).json({ success: false, error: 'No transcription key configured' });
  const sttUrl = process.env.GROQ_API_KEY
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const sttModel = process.env.GROQ_API_KEY ? 'whisper-large-v3' : 'whisper-1';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'votimings-'));
  const audioPath = path.join(tmpDir, 'vo.mp3');
  try {
    const dl = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 60 * 1024 * 1024 });
    fs.writeFileSync(audioPath, Buffer.from(dl.data));

    // ffprobe is the authority on duration — Whisper's last word end is where SPEECH stops, which
    // is earlier than where the FILE stops whenever the render carries trailing silence. Cutting
    // picture to the speech end would leave the tail of the audio hanging past the video.
    const durationSec = await new Promise((resolve) => {
      ffmpeg.ffprobe(audioPath, (err, meta) => resolve(err ? 0 : Number(meta?.format?.duration) || 0));
    });

    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath));
    form.append('model', sttModel);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    const r = await axios.post(sttUrl, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${sttKey}` },
      timeout: 180000, maxBodyLength: Infinity,
    });
    const words = (r.data?.words || []).map(w => ({
      word: String(w.word || '').trim(),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0,
    })).filter(w => w.word);

    res.json({ success: true, durationSec: Math.round(durationSec * 100) / 100, words, text: r.data?.text || '' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data?.error?.message || e.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

app.post('/api/burn-captions', async (req, res) => {
  const { videoUrl, scriptText } = req.body;
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

  // Groq first: it is already configured on this service (it powers /api/clone's
  // transcription since 2026-07-01) and is OpenAI-compatible, so captions need no
  // extra key. OPENAI_API_KEY was never set here, which is why this endpoint has
  // returned "not configured" for its whole life while the Studio silently swallowed
  // the failure — the auto-captions checkbox has therefore never once worked.
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const sttKey = GROQ_API_KEY || OPENAI_API_KEY;
  if (!sttKey) return res.status(500).json({ success: false, error: 'No transcription key configured (set GROQ_API_KEY on the analyser service)' });
  const sttUrl = GROQ_API_KEY
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const sttModel = GROQ_API_KEY ? 'whisper-large-v3' : 'whisper-1';

  const token = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captions-'));
  const videoPath = path.join(tmpDir, 'input.mp4');
  const audioPath = path.join(tmpDir, 'audio.mp3');
  const outputPath = path.join(os.tmpdir(), `tempvid_${token}.mp4`);

  try {
    // 1. Download the source video
    const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000 });
    fs.writeFileSync(videoPath, Buffer.from(videoRes.data));

    const { width, height } = await getVideoDimensions(videoPath);

    // 2. Extract audio for transcription
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('64k')
        .output(audioPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 3. Whisper with word-level timestamps — works regardless of which TTS
    // engine produced the voice, so it's one uniform path for all 3 talking-
    // head engines (InfiniteTalk / Kling Avatar / OmniHuman).
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', sttModel);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    if (scriptText) form.append('prompt', String(scriptText).slice(0, 500));

    const whisperRes = await axios.post(sttUrl, form, {
      headers: { 'Authorization': `Bearer ${sttKey}`, ...form.getHeaders() },
      timeout: 60000
    });

    const words = whisperRes.data?.words || [];
    if (!words.length) throw new Error('Whisper returned no word-level timestamps — cannot build captions');

    const chunks = groupWordsIntoChunks(words, 3);

    // 4. Build one drawtext filter per chunk, each only visible during its
    // own time window — centered, bold white, dark outline (Instagram's
    // basic auto-caption look). Static per-chunk display, no karaoke animation.
    // Height alone is not enough: at height*0.07 (134px on a 1088x1920 clip) a
    // 3-word chunk in Archivo Black measures ~1200px on a 1088px-wide frame, so the
    // text ran off BOTH edges — measured 2026-08-14 on a real burn. drawtext cannot
    // auto-fit, so cap the size by the widest chunk. ~0.62em average advance for this
    // face; 92% of the frame leaves a safe margin. One size for the whole video so it
    // does not jitter between chunks.
    const longestChunk = Math.max(...chunks.map(c => (c.text || '').length), 1);
    const safeW = Number.isFinite(width) && width > 0 ? Math.round(width) : 1080;
    const safeH = Number.isFinite(height) && height > 0 ? Math.round(height) : 1920;
    // Caption size. The height ratio is the PRIMARY control — the width cap below only
    // shrinks it further when a chunk is unusually long. Was 0.07 (134px on a 1920-tall
    // clip), which read as enormous on short chunks; Mike asked for ~4x smaller, so
    // 0.0175 -> ~34px at 1920. Tune CAPTION_HEIGHT_RATIO alone to resize everything.
    const CAPTION_HEIGHT_RATIO = 0.0175;
    const widthLimited = Math.floor((safeW * 0.92) / (longestChunk * 0.62));
    let fontSize = Math.max(16, Math.min(Math.round(safeH * CAPTION_HEIGHT_RATIO), widthLimited));
    if (!Number.isFinite(fontSize) || fontSize < 12) fontSize = Math.round(safeH * CAPTION_HEIGHT_RATIO) || 34;

    // Only chunks with real text AND real timings. A word missing start/end would
    // render enable='between(t,undefined,undefined)', which ffmpeg rejects as an
    // "Invalid argument" — and that surfaces as the confusing "Error reinitializing
    // filters / Failed to inject frame into filter network" rather than as a clear
    // parse error, so it is worth excluding rather than trusting Whisper's output.
    const usable = chunks.filter(c =>
      (c.text || '').trim().length > 0 && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start
    );
    if (!usable.length) throw new Error('No usable caption chunks (missing text or word timings)');

    // text is passed via textfile= rather than inline text=, which removes filter-string
    // escaping as a failure mode entirely — apostrophes, colons, percent signs and
    // backslashes in a transcript can no longer break the graph.
    const drawFilters = usable.map((c, i) => {
      const f = path.join(tmpDir, `cap_${i}.txt`);
      fs.writeFileSync(f, c.text, 'utf8');
      return `drawtext=fontfile='${CAPTION_FONT_PATH}':textfile='${f}':expansion=none:fontsize=${fontSize}:fontcolor=white${captionEdgeArgs(fontSize, req.body && req.body.edge)}:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'`;
    });

    // Pin frame size and pixel format BEFORE the drawtext chain. "Error reinitializing
    // filters!" is ffmpeg rebuilding the graph because incoming frame properties changed
    // mid-stream; pinning them means it never has to.
    const filters = [`scale=${safeW}:${safeH}`, 'format=yuv420p', ...drawFilters];

    if (!drawFilters.length) throw new Error('No caption chunks generated');

    // 5. Burn the captions onto the video
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(videoPath)
        .outputOptions(['-vf', filters.join(','), '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-c:a', 'copy'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', (e) => {
          console.error('[burn-captions] ffmpeg failed. chunks=%d fontSize=%d dims=%dx%d', usable.length, fontSize, safeW, safeH);
          console.error('[burn-captions] filter chain:', filters.join(',').slice(0, 1500));
          reject(e);
        });
      if (SYSTEM_FFMPEG) cmd.setFfmpegPath(SYSTEM_FFMPEG);
      cmd.run();
    });

    if (!fs.existsSync(outputPath)) throw new Error('Caption burn-in produced no output file');

    // Reuse the existing temp-video serving infrastructure (same Map/route
    // already used to hand fal.ai a fetchable URL) instead of building a
    // second mechanism.
    tempVideos.set(token, { filePath: outputPath, createdAt: Date.now() });
    const publicUrl = `${req.protocol}://${req.get('host')}/api/temp-video/${token}`;
    res.json({ success: true, videoUrl: publicUrl, token, chunkCount: chunks.length });
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    console.error('[burn-captions] error:', message);
    res.status(500).json({ success: false, error: message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─────────────────────────────────────────
// CLIP SEQUENCING — stitch multiple generated clips into one longer video.
// Downloads each clip, normalizes it (1080x1920 / 24fps / h264, audio stripped —
// no-music rule + avoids audio-concat mismatch), then concats via the demuxer.
// Re-encode-then-copy is the reliable path: the concat demuxer breaks on clips
// with differing codec/fps/SAR, which generated clips often have. (2026-07-11)
// ─────────────────────────────────────────
app.post('/api/stitch', async (req, res) => {
  const { videoUrls, width, height } = req.body;
  if (!Array.isArray(videoUrls) || videoUrls.length < 2) {
    return res.status(400).json({ success: false, error: 'Need at least 2 video URLs to stitch' });
  }
  const urls = videoUrls.filter(u => typeof u === 'string' && u.trim()).slice(0, 6); // cap at 6 (~90s)
  if (urls.length < 2) return res.status(400).json({ success: false, error: 'Need at least 2 valid video URLs' });

  // Output canvas. Defaults to 1080x1920 — Sequence Clips' original hardcoded
  // behaviour, kept so that flow does not regress.
  // Hook swap passes the SOURCE clip's real dimensions instead: normalising a
  // 480p body up to 1080p would undo the deliberately low-fi look the AUTHENTIC
  // lane depends on, and re-encoding an upscale adds nothing but file size.
  // h264 requires even dimensions, hence the rounding.
  const even = n => Math.max(2, Math.round(n / 2) * 2);
  let outW = 1080, outH = 1920;
  const rw = Number(width), rh = Number(height);
  if (Number.isFinite(rw) && Number.isFinite(rh) && rw > 0 && rh > 0) {
    const w = even(rw), h = even(rh);
    // Bounds keep a bad request from asking ffmpeg for an absurd canvas.
    if (w >= 128 && w <= 2160 && h >= 128 && h <= 3840) { outW = w; outH = h; }
  }

  const token = `seq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-'));
  const outputPath = path.join(os.tmpdir(), `tempvid_${token}.mp4`);
  try {
    // 1. Download + normalize each clip sequentially (low RAM on Hobby plan)
    const normPaths = [];
    for (let i = 0; i < urls.length; i++) {
      const raw = path.join(tmpDir, `raw_${i}.mp4`);
      const norm = path.join(tmpDir, `norm_${i}.mp4`);
      const dl = await axios.get(urls[i], { responseType: 'arraybuffer', timeout: 60000 });
      fs.writeFileSync(raw, Buffer.from(dl.data));
      await new Promise((resolve, reject) => {
        ffmpeg(raw)
          .videoFilters(`scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1`)
          .outputOptions(['-r 24', '-c:v libx264', '-crf', '18', '-preset veryfast', '-pix_fmt yuv420p', '-an', '-threads 1'])
          .output(norm).on('end', resolve).on('error', reject).run();
      });
      normPaths.push(norm);
    }
    // 2. Concat the normalized clips (all identical specs now → safe -c copy)
    const listPath = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listPath, normPaths.map(p => `file '${p}'`).join('\n'));
    await new Promise((resolve, reject) => {
      ffmpeg().input(listPath).inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy', '-threads 1'])
        .output(outputPath).on('end', resolve).on('error', reject).run();
    });
    tempVideos.set(token, { filePath: outputPath, createdAt: Date.now() });
    const publicUrl = `${req.protocol}://${req.get('host')}/api/temp-video/${token}`;
    console.log(`[stitch:${token}] stitched ${normPaths.length} clips at ${outW}x${outH}`);
    res.json({ success: true, videoUrl: publicUrl, token, clipCount: normPaths.length, width: outW, height: outH });
  } catch (err) {
    console.error(`[stitch:${token}] error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─────────────────────────────────────────
// DEVICE STAMP — REMOVED 2026-08-25 (Mike's call, see KRYFEX-VIRAL-DECLINE-
// RAPPORT.md §3 in the Website folder). Fabricated iPhone capture metadata was
// pure added risk: platforms read pixels and know the real posting device, so
// every fabricated field is a checkable contradiction. /api/stamp-video,
// STAMP_KEYS, sanitiseMetaValue and the variants route's metadata injection
// are all gone. Do NOT reintroduce.
// ─────────────────────────────────────────

// ─────────────────────────────────────────
// TRIAL LAB — MODE A: re-serve variants of your OWN winning video.
//
// PURPOSE (different from the creative mode): take a video that already
// performed, and produce N mechanically-distinct copies so it can be re-served
// to fresh non-follower audiences via Trial Reels. The viewer has never seen it,
// so it is new content to them; the tweaks exist to stop it being matched
// against the account's own earlier post.
//
// HONEST CAVEAT, kept here so it isn't lost: Meta's near-duplicate models
// (SimSearchNet et al.) are trained with AugLy, whose augmentation list IS
// crop/brightness/contrast/noise/rotation. These transforms are therefore
// exactly what those models are built to see through, and a perceptual match
// against the original is likely regardless. The strategy may still work —
// detection is not the same as suppression, and re-serving to non-followers is
// legitimate for your own content — but do not assume the tweaks are what makes
// it work. See METADATA-DUPLICATE-DETECTION-RAPPORT.md.
//
// Unlike the device stamp this MUST re-encode (the point is to change pixels),
// so it is not lossless. CRF 18 keeps that visually negligible.
// ─────────────────────────────────────────

const VARIANT_MAX = 10;

// Deterministic per-variant RNG so a given seed reproduces the same set —
// needed to say what a posted file actually was.
function variantRng(seed, index) {
  let s = 0;
  const str = `${seed}::${index}`;
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
  // Avalanche the seed, then warm up. Without this a plain LCG returns nearly
  // identical FIRST outputs for near-identical seeds ("run::0", "run::1", ...),
  // and the first draw is the rotation — measured live as -0.15/-0.14/-0.14
  // across three variants, i.e. effectively constant where it should vary.
  s ^= s >>> 16; s = Math.imul(s, 2246822507) >>> 0;
  s ^= s >>> 13; s = Math.imul(s, 3266489909) >>> 0;
  s ^= s >>> 16;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/**
 * Build one variant's filter chain + human-readable label.
 *
 * The rotation/zoom coupling is load-bearing: rotating a W*H frame by θ leaves
 * black corners unless it is first scaled by at least
 *   max((W·cosθ + H·sinθ)/W , (H·cosθ + W·sinθ)/H)
 * At 1080x1920 and θ=0.8° that is 1.025 — so a naive "zoom 1–4%, rotate up to
 * 0.8°" would produce black wedges whenever a low zoom drew alongside a high
 * rotation. The required scale is computed from θ and the zoom is raised to
 * meet it.
 */
// ── Variation tiers ──────────────────────────────────────────────────────────
// [MEASURED 2026-08-18] on a real 480x854 clip, 64-bit DCT pHash, 8 frames.
// Controls: identical=0.00, unrelated clip=30.25.
//
//   tier      pHash dist   crop loss   use
//   quality      ~17.3        5.7%     MAIN accounts — re-serving a proven
//                                      winner; framing must survive
//   balanced     ~19          ~8%      middle ground
//   max          ~21         ~11%      BURNER accounts — displacement first,
//                                      "not visibly broken" is the only bar
//
// Rotation is 0 on quality/balanced. Measured three separate ways it adds
// ~0.00-0.50 pHash distance while forcing a larger zoom (it needs wedge
// clearance), i.e. it spends crop budget for nothing. A small rotation is kept
// on `max` ONLY as transform diversity against detectors we cannot measure —
// not because it helps the metric.
const VARIANT_TIERS = {
  quality:  { rotMax: 0.0, maxShift: 0.029, zoomFloor: 1.060, satR: 0.030, conR: 0.020, briR: 0.015, gamR: 0.020, speedR: 0.015 },
  balanced: { rotMax: 0.0, maxShift: 0.040, zoomFloor: 1.090, satR: 0.050, conR: 0.035, briR: 0.025, gamR: 0.035, speedR: 0.025 },
  max:      { rotMax: 0.6, maxShift: 0.048, zoomFloor: 1.130, satR: 0.090, conR: 0.070, briR: 0.040, gamR: 0.060, speedR: 0.040 },
};
// Back-compat with the old two-value API.
const TIER_ALIASES = { subtle: 'quality', medium: 'max' };
function resolveTier(intensity) {
  const key = TIER_ALIASES[intensity] || intensity;
  return VARIANT_TIERS[key] ? key : 'quality';
}

function buildVariant(rng, W, H, intensity, opts = {}) {
  const lerp = (a, b) => a + rng() * (b - a);
  const tierName = resolveTier(intensity);
  const T = VARIANT_TIERS[tierName];
  const strong = tierName === 'max';   // retained for the few remaining uses

  // Rotation deliberately NOT raised. [MEASURED] it adds only ~+0.50 on top of
  // the framing shift, while 3deg demands zoom >= 1.09 on 480x854 BEFORE the
  // shift budget (~1.17 total) — spending 5% more crop to buy ~0.5 distance.
  // The zoom budget is better spent on shift, which is the real lever.
  const rotDeg = T.rotMax ? lerp(-1, 1) * T.rotMax : 0;
  const rad = Math.abs(rotDeg) * Math.PI / 180;
  const needW = (W * Math.cos(rad) + H * Math.sin(rad)) / W;
  const needH = (H * Math.cos(rad) + W * Math.sin(rad)) / H;
  const needed = Math.max(needW, needH);

  // ASYMMETRIC CROP. A centered crop only ever undoes the zoom; shifting the
  // crop window off-centre moves the whole spatial layout, which displaces far
  // more pixels than a centered zoom of the same magnitude.
  //
  // It costs clearance though: shifting toward an edge eats the margin the
  // rotation wedge needs on that side. Margin per side is (z-1)/2, so a shift
  // of fraction f requires z >= needed + 2f. That term is added below — do not
  // remove it or the crop will walk into the black wedge.
  // [MEASURED 2026-08-18, real 480x854 Kryfex clip, 64-bit DCT pHash, 8 frames]
  // Lever isolation — controls: self=0.00, unrelated clip=30.25:
  //     noise grain ........  0.00   (and 28x the file size)
  //     colour grade .......  3.00
  //     rotation (3deg) .... 10.75
  //     zoom + off-centre crop ... 19.75   <-- the ONLY lever that matters
  //     L3 framing + MAX grade + MAX rotation ... 20.25  (i.e. +0.50 over framing alone)
  //     minimal framing + MAX grade + MAX rotation ... 12.00
  // So appearance cannot buy distance: the framing displacement is the mechanism.
  // WHY: pHash is a 32x32 GRAYSCALE DCT. Downsampling averages grain away and
  // grayscale discards colour, so noise/saturation are invisible to it — but an
  // off-centre crop changes which pixels land in which cell, which survives.
  //
  // The old values (0.012/0.020) scored only 4.75 / 10.75 against the 30.25
  // unrelated-clip baseline — i.e. "would still match". These reach ~22.
  // Do NOT raise further without re-running the border-ring scan on a BRIGHT
  // clip: on dark footage that check is dominated by content, not wedges.
  const maxShift = T.maxShift;
  // Random SIGN but a substantial MAGNITUDE. `lerp(-1,1)*maxShift` could draw
  // near zero, which produced weak variants by luck — [MEASURED 2026-08-18] the
  // per-seed spread was 10.25-17.75 pHash distance purely from that. For a
  // variation tool every output must clear the bar, not just the average.
  const mag = () => (0.60 + rng() * 0.40) * (rng() < 0.5 ? -1 : 1);
  const shiftX = mag() * maxShift;
  const shiftY = mag() * maxShift;
  const shiftCost = 2 * Math.max(Math.abs(shiftX), Math.abs(shiftY));

  // Safety factor 1.2% -> 3.0% on 2026-08-18: DEFENCE-IN-DEPTH, not a bug fix.
  // The 1.2% was derived empirically at the old maxShift (0.020); maxShift is now
  // 0.048, so the constant it was tuned against no longer applies and a wider
  // margin is cheap insurance (~1.8% extra crop).
  //
  // ⚠️ READ THIS BEFORE "FIXING" WEDGES — I chased a phantom three times.
  // A bright-clip border scan reports 5 black pixels (value 0) on ~2 of 30
  // variants. Those are NOT rotation wedges. They are the `vignette` filter
  // below, which darkens the extreme corners by design (added 2026-08-04 as part
  // of the camera-realism layer). PROVEN by control: the identical 30 variants
  // with the vignette stripped score 0/30, with it 2/30. The dark pixels sit at
  // output (0,0),(1,0),(479,0) — output corners — even when the crop origin is
  // 53px inside the margin, which no rotation wedge could reach.
  // On real footage a vignette is a look, not a defect. Do not "fix" it.
  // Floor raised to match the new shift budget. The `needed + shiftCost` term
  // still governs and still guarantees wedge clearance — this only stops a low
  // random draw from wasting the displacement the shift is there to create.
  // Safety factor only matters when there IS a rotation wedge to clear. With
  // rotDeg == 0 the rotate filter is a no-op, so 0.5% (rounding) is plenty and
  // the quality tier keeps its framing instead of paying for a phantom margin.
  const safety = rotDeg === 0 ? 1.005 : 1.030;
  const zoom = Math.max(T.zoomFloor, needed + shiftCost) * safety;

  const sat = lerp(1 - T.satR, 1 + T.satR);
  const con = lerp(1 - T.conR, 1 + T.conR);
  const bri = lerp(-T.briR, T.briR);
  const gam = lerp(1 - T.gamR, 1 + T.gamR);
  // [MEASURED 2026-08-18] grain contributes EXACTLY 0.00 pHash distance while
  // inflating the file 28x (identical L3 variant: 45.5MB with, 1.6MB without —
  // smaller than the 7.4MB source). It is invisible to a 32x32 grayscale DCT.
  // Kept as a parameter so it can be re-enabled for a non-pHash reason, but the
  // filter is no longer emitted. Do not re-add it for "uniqueness" — it does nothing.
  const noise = 0;
  const vig = lerp(Math.PI / 9, Math.PI / 6);
  const speed = lerp(1 - T.speedR, 1 + T.speedR);

  // Even dimensions are required by h264.
  const even = (n) => { const v = Math.round(n); return v % 2 ? v + 1 : v; };
  const sw = even(W * zoom), sh = even(H * zoom);

  // Off-centre crop origin. The old clamp was [0, sw-W], which allowed the crop to
  // sit flush against the scaled frame's edge — where a rotation wedge would live.
  // No wedge was ever actually observed there (see the vignette note above), so
  // this is DEFENCE-IN-DEPTH rather than a fix: rotating an sw*sh frame by θ insets
  // its content from each edge by at most max(sw,sh)*sin|θ|, and clamping into that
  // region is a principled bound that self-adjusts with θ instead of relying on a
  // global multiplier tuned for one parameter set. +1px covers rounding.
  // Kept because maxShift is now 2.4x larger and the crop runs much closer to the
  // edge than when the original margins were validated.
  const wedge = Math.ceil(Math.max(sw, sh) * Math.sin(rad)) + 1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // If the margin is too tight to honour the inset on both sides, fall back to a
  // centred crop: losing shift costs some pHash distance, a wedge is a visible defect.
  const okX = (sw - W) >= 2 * wedge, okY = (sh - H) >= 2 * wedge;
  const cx = okX ? clamp(Math.round((sw - W) / 2 + shiftX * W), wedge, sw - W - wedge)
                 : Math.round((sw - W) / 2);
  const cy = okY ? clamp(Math.round((sh - H) / 2 + shiftY * H), wedge, sh - H - wedge)
                 : Math.round((sh - H) / 2);

  const vf = [
    `scale=${sw}:${sh}`,
    `rotate=${(rotDeg * Math.PI / 180).toFixed(6)}:ow=${sw}:oh=${sh}`,
    `crop=${W}:${H}:${cx}:${cy}`,
    // Mirror is OPT-IN only. It displaces more pixels than anything else here,
    // but it reverses on-screen text and logos, mirrors the influencer's face,
    // and moves every tattoo to the wrong arm — which for identity-consistent
    // personas (Tatthex, Axel) is a visible break, not a subtle tweak.
    ...(opts.flip ? ['hflip'] : []),
    `eq=saturation=${sat.toFixed(3)}:contrast=${con.toFixed(3)}:brightness=${bri.toFixed(3)}:gamma=${gam.toFixed(3)}`,
    `vignette=a=${vig.toFixed(4)}`,
    `setpts=${(1 / speed).toFixed(5)}*PTS`,
  ].join(',');

  // atempo is only valid in [0.5, 2.0]; our range is well inside it.
  const af = `atempo=${speed.toFixed(5)},volume=${lerp(0.97, 1.03).toFixed(3)}`;

  const shiftPx = `${Math.round(shiftX * W)},${Math.round(shiftY * H)}px`;
  return {
    vf, af,
    label: `zoom ${((zoom - 1) * 100).toFixed(1)}% · rot ${rotDeg.toFixed(2)}° · shift ${shiftPx}${opts.flip ? ' · mirrored' : ''} · sat ${sat.toFixed(2)} · ${speed.toFixed(3)}x`,
    tier: tierName,
    params: {
      tier: tierName,
      zoom: +zoom.toFixed(4), rotDeg: +rotDeg.toFixed(3),
      cropX: cx, cropY: cy, shiftX: +shiftX.toFixed(4), shiftY: +shiftY.toFixed(4),
      flip: !!opts.flip,
      sat: +sat.toFixed(3), con: +con.toFixed(3), bri: +bri.toFixed(3), gam: +gam.toFixed(3),
      noise, speed: +speed.toFixed(4),
    },
  };
}

// ─────────────────────────────────────────
// PERCEPTUAL HASH — does a variant still look like the original to a
// fingerprinting system?
//
// This is deliberately NOT SSIM. SSIM measures raw pixel difference, so after a
// crop and a colour grade it always reports a big change — a metric that can
// only ever say "it worked". A DCT perceptual hash is what near-duplicate
// systems actually compute, so its distance answers the question that matters:
// is this variant still going to be matched against the original?
//
// HONEST SCOPE: this is standard 64-bit pHash. It is the same FAMILY as Meta's
// PDQ (both DCT-based) but it is not PDQ, and the thresholds below are the
// common convention, not Meta's. Read it as a strong indicator, not a verdict.
// ─────────────────────────────────────────

const PHASH_N = 32;   // DCT input size
const PHASH_K = 8;    // low-frequency block kept

// cos((2x+1) * u * pi / 2N), precomputed once.
const DCT_COS = (() => {
  const t = [];
  for (let u = 0; u < PHASH_K; u++) {
    t[u] = new Float64Array(PHASH_N);
    for (let x = 0; x < PHASH_N; x++) {
      t[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_N));
    }
  }
  return t;
})();

/** 32x32 grayscale bytes -> 64-bit hash as a Buffer(8). */
function pHashFromGray(bytes) {
  // Separable 2D DCT-II, only the KxK low-frequency corner.
  const rows = [];
  for (let y = 0; y < PHASH_N; y++) {
    const r = new Float64Array(PHASH_K);
    for (let u = 0; u < PHASH_K; u++) {
      let s = 0;
      for (let x = 0; x < PHASH_N; x++) s += bytes[y * PHASH_N + x] * DCT_COS[u][x];
      r[u] = s;
    }
    rows.push(r);
  }
  const coeffs = new Float64Array(PHASH_K * PHASH_K);
  for (let u = 0; u < PHASH_K; u++) {
    for (let v = 0; v < PHASH_K; v++) {
      let s = 0;
      for (let y = 0; y < PHASH_N; y++) s += rows[y][v] * DCT_COS[u][y];
      coeffs[u * PHASH_K + v] = s;
    }
  }
  // Median over the block EXCLUDING the DC term — DC encodes overall
  // brightness, so including it makes the hash react to a brightness tweak,
  // which is exactly the kind of change a perceptual hash should ignore.
  const ac = Array.from(coeffs).slice(1).sort((a, b) => a - b);
  const median = (ac[Math.floor(ac.length / 2) - 1] + ac[Math.floor(ac.length / 2)]) / 2;

  const out = Buffer.alloc(8);
  for (let i = 0; i < 64; i++) {
    if (coeffs[i] > median) out[i >> 3] |= (1 << (7 - (i & 7)));
  }
  return out;
}

const POPCOUNT = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1]; return t; })();
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 8; i++) d += POPCOUNT[a[i] ^ b[i]];
  return d;
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => resolve(err ? 0 : (meta?.format?.duration || 0)));
  });
}

/**
 * Sample `count` EVENLY SPACED frames as 32x32 gray and hash each.
 *
 * Sampling is duration-relative (fps = count/duration) rather than "the first N
 * frames" — otherwise every comparison would only ever look at the opening
 * moment. Because it is proportional, a variant with a slight speed change
 * still samples the same relative positions as the original, which is what
 * makes the two hash sequences comparable.
 *
 * Frames go to a temp file rather than a pipe: piping raw video introduces
 * flush-timing subtleties between ffmpeg's 'end' and the stream draining, and
 * this is not performance-critical.
 */
async function hashVideo(filePath, count) {
  const dur = await probeDuration(filePath);
  const rate = dur > 0.1 ? (count / dur) : 1;
  const rawPath = `${filePath}.gray`;

  await new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions([
        '-vf', `fps=${rate.toFixed(6)},scale=${PHASH_N}:${PHASH_N},format=gray`,
        '-frames:v', String(count),
        '-f', 'rawvideo', '-pix_fmt', 'gray',
      ])
      .output(rawPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const buf = fs.readFileSync(rawPath);
  try { fs.unlinkSync(rawPath); } catch (_) {}
  const size = PHASH_N * PHASH_N;
  const hashes = [];
  for (let i = 0; i + size <= buf.length; i += size) {
    hashes.push(pHashFromGray(buf.subarray(i, i + size)));
  }
  if (!hashes.length) throw new Error('No frames hashed');
  return hashes;
}

function verdictFor(distance) {
  // Conventional 64-bit pHash bands. Stated as guidance, not as Meta's rule.
  if (distance <= 10) return { verdict: 'would still match', detail: 'A dedup system would very likely treat this as the same video.' };
  if (distance <= 20) return { verdict: 'borderline', detail: 'Close enough that a match is plausible.' };
  return { verdict: 'likely distinct', detail: 'Far enough apart that a perceptual match is unlikely.' };
}

// POST /api/extract-frames  { videoUrl, count }
// Returns N evenly-spaced frames as base64 JPEGs so the Vercel side can run output QC on a
// finished video. Vercel has no ffmpeg, and all ffmpeg work lives here by convention.
// Deliberately returns base64 rather than hosting: the frames are consumed once, immediately,
// by a Claude vision call — hosting them would mean a second lifecycle to manage and clean up.
// POST /api/extract-audio  { videoUrl, maxSeconds }
// Pulls a clean mono MP3 out of a video so it can be used to CLONE a voice. Accepts an
// Instagram or TikTok link (reusing the same download paths as /api/clone) or a direct
// video URL. Returns base64 — the Vercel side re-hosts it to Blob, which is the only host
// /api/voice/clone will accept.
// Capped at 60s by default: voice cloning needs roughly 10-60s of clean speech, and an
// uncapped extract on a long video would balloon the response for no gain.
// POST /api/assemble-reel
//   { shots: [{url, type:'still'|'video', seconds}], audioUrl?, width?, height? }
// Cuts a finished reel out of the First Week shot list. A deliberate SIBLING of /api/stitch
// rather than an extension of it: stitch is a working feature (Sequence Clips) that caps at
// 6 clips, takes video only, keeps whole clips and strips audio with -an. Every one of those
// is wrong here, and making it polymorphic would risk the feature that already works.
// Stills become clips with a slow Ken Burns push, every shot is cut to its exact timecode,

// Burn a list of {text,start,end} cues onto a video. Shared by the reel assembler and the
// Whisper-driven caption endpoint, so the look and the escaping rules cannot drift apart.
// How the text is separated from the picture behind it.
// ⚠️ Both caption paths used to hard-code a heavy outline (borderw ~12-14% of the font size),
// which at ~34px draws a ~5px black line around every letter — Mike, 2026-09-02: "creates a thick
// black line around the captions, I don't like that". A soft drop shadow keeps the text readable
// over a bright frame without the outlined look, so it is the default. 'outline' restores the old
// heavy edge; 'none' is plain text and is only safe over consistently dark footage.
function captionEdgeArgs(fontSize, edge) {
  const e = String(edge || 'shadow').toLowerCase();
  if (e === 'none') return '';
  if (e === 'outline') return `:borderw=${Math.round(fontSize * 0.14)}:bordercolor=black@0.85`;
  const off = Math.max(1, Math.round(fontSize * 0.05));
  return `:shadowcolor=black@0.55:shadowx=${off}:shadowy=${off}`;
}

// One drawtext per cue, each visible only in its own window. Text goes through a FILE
// (textfile=) not inline, which removes filter-string escaping — apostrophes, colons, %
// and backslashes — as a failure mode entirely.
async function burnCueList(inPath, outPath, cues, opts = {}) {
  const fontPath = captionFontPath(opts.font);
  const ratio = CAPTION_SIZES[String(opts.size || 'medium').toLowerCase()] || CAPTION_SIZES.medium;
  const dims = await probeDims(inPath);
  const safeW = dims.width || 1080, safeH = dims.height || 1920;

  const usable = cues
    .map(c => ({ text: String(c.text || '').trim(), start: Number(c.start), end: Number(c.end) }))
    .filter(c => c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  if (!usable.length) return false;

  // drawtext cannot wrap, so the size is capped by the WIDEST cue. ~0.62em average advance is
  // close enough for these faces; without this the text ran off both edges (measured 2026-08-14).
  const widest = Math.max(...usable.map(c => c.text.length));
  const widthLimited = Math.floor((safeW * 0.92) / (widest * 0.62));
  let fontSize = Math.max(16, Math.min(Math.round(safeH * ratio), widthLimited));
  if (!Number.isFinite(fontSize) || fontSize < 12) fontSize = Math.round(safeH * ratio) || 34;

  // Reels captions sit low-centre by default so they clear the face and the UI chrome.
  const pos = String(opts.position || 'lower').toLowerCase();
  const y = pos === 'middle' ? '(h-text_h)/2'
          : pos === 'bottom' ? 'h-text_h-(h*0.14)'
          : 'h-text_h-(h*0.26)';

  const filters = [`scale=${safeW}:${safeH}`, 'format=yuv420p'];
  usable.forEach((c, i) => {
    const f = path.join(path.dirname(outPath), `cue_${i}.txt`);
    fs.writeFileSync(f, c.text, 'utf8');
    filters.push(
      `drawtext=fontfile='${fontPath}':textfile='${f}':expansion=none:fontsize=${fontSize}` +
      `:fontcolor=${opts.color || 'white'}${captionEdgeArgs(fontSize, opts.edge)}` +
      `:x=(w-text_w)/2:y=${y}:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'`
    );
  });

  // ⚠️ MUST use the SYSTEM ffmpeg, never ffmpeg-static. The static build ships WITHOUT libfreetype,
  // so `drawtext` does not exist in it and every burn dies with the cryptic "Filter not found"
  // (exit code 8). That was fixed for the Whisper caption routes on 2026-08-14 and never applied
  // to THIS function — so First Week reel captions failed on every single build from the day the
  // feature shipped (08-28) until 2026-09-01, and the error was invisible because the response
  // never carried captionError. Same bug class, sibling function, one line apart in effect.
  if (!SYSTEM_FFMPEG) throw new Error('no system ffmpeg with drawtext available (ffmpeg-static has no libfreetype, so captions cannot be burned)');
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(inPath);
    cmd.setFfmpegPath(SYSTEM_FFMPEG);
    cmd
      .videoFilters(filters)
      .outputOptions(['-c:v libx264', '-crf', '18', '-preset veryfast', '-pix_fmt yuv420p', '-an', '-threads 1'])
      .output(outPath)
      .on('error', err => {
        console.error('[captions] ffmpeg failed. cues=%d size=%d dims=%dx%d font=%s',
          usable.length, fontSize, safeW, safeH, fontPath);
        console.error('[captions] chain:', filters.join(',').slice(0, 1200));
        reject(err);
      })
      .on('end', resolve).run();
  });
  return fs.existsSync(outPath);
}

async function probeDims(file) {
  return new Promise(resolve => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return resolve({ width: 0, height: 0 });
      const v = (data.streams || []).find(x => x.codec_type === 'video') || {};
      resolve({ width: Number(v.width) || 0, height: Number(v.height) || 0 });
    });
  });
}


// and the voiceover is muxed over the finished cut.
app.post('/api/assemble-reel', async (req, res) => {
  // Cap 80: a 30s every-beat Beat Edit at 128 BPM is ~64 cuts (was 40).
  const shots = Array.isArray(req.body?.shots) ? req.body.shots.filter(x => x && x.url).slice(0, 80) : [];
  const audioUrl = req.body?.audioUrl || '';
  // Beat Edit flags — all default OFF so the First Week reel caller's ffmpeg
  // command lines stay byte-identical.
  // strict: a failed shot fails the WHOLE request immediately. A silently
  //   skipped shot shifts every later cut off-beat, which is worse than an
  //   error — nobody should pay 3 minutes to learn the edit is garbage.
  // exactLen: segments are cut with -frames:v + tpad clone so a segment can
  //   NEVER come out short (a short segment desyncs everything after it; a
  //   <=300ms freeze inside a 0.5s cut is invisible). Also switches to a
  //   normalize-once-per-URL intermediate so 80 cuts from 5 clips don't decode
  //   the sources 80 times.
  // audioFadeOutSec: fade the soundtrack out over the last N seconds instead
  //   of the hard -shortest chop.
  const strict = req.body?.strict === true;
  const exactLen = req.body?.exactLen === true;
  const audioFadeOutSec = Math.max(0, Math.min(3, Number(req.body?.audioFadeOutSec) || 0));
  // The reel can open with silent shots (the cold open), so the voiceover must not start at 0:00
  // or every spoken noun lands on the wrong picture — "eleven followers" would play over the
  // bed shot instead of the profile screenshot, and the whole reel runs offset from there.
  const audioDelaySec = Math.max(0, Math.min(15, Number(req.body?.audioDelaySec) || 0));
  // Captions come from the plan's OWN text and timecodes — already written, already timed, and
  // already chunked to <=3 words by the caller. No transcription step, so nothing to mis-hear.
  const cues = Array.isArray(req.body?.captions) ? req.body.captions.slice(0, 200) : [];
  const capStyle = req.body?.captionStyle || {};
  const outW = Math.max(2, Math.round((Number(req.body?.width) || 1080) / 2) * 2);
  const outH = Math.max(2, Math.round((Number(req.body?.height) || 1920) / 2) * 2);
  if (shots.length < 2) return res.status(400).json({ success: false, error: 'Need at least 2 shots to assemble.' });

  const token = `reel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  const outputPath = path.join(os.tmpdir(), `tempvid_${token}.mp4`);
  try {
    const normPaths = [];
    // Beat edits reference the same source clip for many segments — download
    // each unique URL once. Failures are cached too, or a dead URL would eat
    // two 90s timeouts PER SHOT that references it.
    const dlCache = new Map();   // url -> local source path
    const dlFailed = new Map();  // url -> error message
    const normCache = new Map(); // url -> whole-clip normalized intermediate (exactLen mode)
    const encodeOpts = ['-r 24', '-c:v libx264', '-crf', '18', '-preset veryfast', '-pix_fmt yuv420p', '-an', '-threads 1'];
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i];
      const secs = Math.min(10, Math.max(0.3, Number(sh.seconds) || 1));
      // Which second of the source clip to use. Without this the reel always took the FIRST
      // `secs` of a 5s generation — usually the weakest part, because the model eases into the
      // motion. startAt lets the operator pick the good moment instead.
      const startAt = Math.max(0, Math.min(60, Number(sh.startAt) || 0));
      const outPath = path.join(tmpDir, `n${i}.mp4`);
      let srcPath = dlCache.get(sh.url);
      if (!srcPath) {
        if (dlFailed.has(sh.url)) {
          if (strict) return res.status(422).json({ success: false, error: `Shot ${i + 1} uses a clip that could not be downloaded — ${dlFailed.get(sh.url)}`, failedShot: i });
          continue;
        }
        srcPath = path.join(tmpDir, `src${i}`);
        let dlErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const dl = await axios.get(sh.url, { responseType: 'arraybuffer', timeout: 90000 });
            fs.writeFileSync(srcPath, Buffer.from(dl.data));
            dlErr = null; break;
          } catch (e) {
            dlErr = e;
            // Retry only what can heal — a 4xx (deleted/forbidden) won't.
            const st = e.response?.status;
            if (st && st >= 400 && st < 500) break;
            await new Promise(r => setTimeout(r, 800));
          }
        }
        if (dlErr) {
          const msg = String(dlErr.message || dlErr).slice(0, 120);
          dlFailed.set(sh.url, msg);
          console.warn(`[reel:${token}] shot ${i + 1} download failed: ${msg}`);
          if (strict) return res.status(422).json({ success: false, error: `Shot ${i + 1} could not be downloaded — ${msg}`, failedShot: i });
          continue;
        }
        dlCache.set(sh.url, srcPath);
      }
      const pad = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      try {
        if (exactLen && sh.type === 'video') {
          // Normalize the WHOLE clip once per unique URL, then cut every
          // segment from the small intermediate — bounds the work at
          // O(unique clip durations + N cheap cuts) instead of decoding the
          // source once per segment, and incidentally removes the nonzero
          // start_time seek edge case some phone files have.
          let normSrc = normCache.get(sh.url);
          if (!normSrc) {
            normSrc = path.join(tmpDir, `full${i}.mp4`);
            await new Promise((resolve, reject) => {
              ffmpeg().input(srcPath).videoFilters(pad)
                .outputOptions(encodeOpts)
                .output(normSrc).on('end', resolve).on('error', reject).run();
            });
            normCache.set(sh.url, normSrc);
          }
          // -frames:v = the exact frame count (secs arrives quantized to the
          // 24fps grid), tpad clones the last frame forever so a clip that
          // runs out can never yield a SHORT segment — a short segment would
          // desync every later cut from the beat.
          const frames = Math.max(1, Math.round(secs * 24));
          await new Promise((resolve, reject) => {
            ffmpeg().input(normSrc).inputOptions(startAt > 0 ? ['-ss', String(startAt)] : [])
              .videoFilters('tpad=stop=-1:stop_mode=clone')
              .outputOptions([`-frames:v ${frames}`, ...encodeOpts])
              .output(outPath).on('end', resolve).on('error', reject).run();
          });
        } else {
          await new Promise((resolve, reject) => {
            const cmd = ffmpeg();
            if (sh.type === 'video') {
              // Take the FIRST `secs` of the generated clip — shots are cut to a timecode,
              // and a generated clip is 5s regardless of how long the cut needs to be.
              // -ss BEFORE the input is the fast, keyframe-accurate seek; -t after it bounds the
              // duration from that point.
              cmd.input(srcPath).inputOptions(startAt > 0 ? ['-ss', String(startAt)] : []).outputOptions([`-t ${secs}`]).videoFilters(pad);
            } else {
              // Ken Burns: a still with a slow push reads as filmed at a 1s cut. Zoom is
              // computed per shot so the push speed is constant regardless of duration.
              const frames = Math.max(2, Math.round(secs * 24));
              const zoom = `zoompan=z='min(zoom+0.0015,1.10)':d=${frames}:s=${outW}x${outH}:fps=24`;
              cmd.input(srcPath).inputOptions(['-loop 1']).outputOptions([`-t ${secs}`]).videoFilters(`${pad},${zoom}`);
            }
            cmd.outputOptions(encodeOpts)
               .output(outPath).on('end', resolve).on('error', reject).run();
          });
        }
        if (fs.existsSync(outPath)) normPaths.push(outPath);
        else if (strict) return res.status(422).json({ success: false, error: `Shot ${i + 1} produced no output.`, failedShot: i });
      } catch (e) {
        console.warn(`[reel:${token}] shot ${i + 1} normalise failed: ${e.message}`);
        if (strict) return res.status(422).json({ success: false, error: `Shot ${i + 1} failed to process — ${String(e.message || e).slice(0, 120)}`, failedShot: i });
      }
    }
    if (normPaths.length < 2) {
      return res.status(400).json({ success: false, error: 'Could not prepare enough shots — check the generated files.' });
    }

    const silentPath = path.join(tmpDir, 'silent.mp4');
    const listPath = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listPath, normPaths.map(f => `file '${f}'`).join('\n'));
    await new Promise((resolve, reject) => {
      ffmpeg().input(listPath).inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy']).output(silentPath)
        .on('end', resolve).on('error', reject).run();
    });

    // Burn onto the silent picture, before the audio mux — drawtext needs a re-encode, and doing
    // it here keeps the mux on `-c:v copy` so the video is encoded exactly once either way.
    let pictPath = silentPath;
    let captionsBurned = false, captionError = '';
    if (cues.length) {
      try {
        const capPath = path.join(tmpDir, 'captioned.mp4');
        if (await burnCueList(silentPath, capPath, cues, capStyle)) { pictPath = capPath; captionsBurned = true; }
        else captionError = 'no usable cues';
      } catch (e) {
        // Fail OPEN: a caption problem must never cost the reel itself. But REPORT it — a silent
        // fail-open is indistinguishable from "captions are off", which is how a broken burn goes
        // unnoticed for weeks.
        captionError = String(e.message || e).slice(0, 200);
        console.warn(`[reel:${token}] captions failed, continuing without: ${captionError}`);
      }
    }

    if (audioUrl) {
      const aPath = path.join(tmpDir, 'vo.mp3');
      const dl = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 90000 });
      fs.writeFileSync(aPath, Buffer.from(dl.data));
      // The picture's own length is the target both ways. MEASURED 2026-08-18 with real
      // ffmpeg: a bare `-shortest` cuts the reel down to a SHORT voiceover (a 2s VO on a 6s
      // picture produced a 2.02s file, silently dropping the closing shots), while a bare
      // `-af apad` HANGS forever on a stream-copied video because nothing ever ends the
      // infinite pad. `apad=whole_dur=<picture length>` is the form that works: it pads a
      // short VO with silence to exactly the picture's length, and -shortest still trims a
      // long VO at the last frame so it cannot end on a freeze. Do not drop whole_dur.
      const picSecs = await probeDuration(pictPath);
      await new Promise((resolve, reject) => {
        // -c:v copy: the picture is already correct, so muxing must never re-encode it.
        const delay = audioDelaySec > 0 ? `adelay=${Math.round(audioDelaySec * 1000)}:all=1,` : '';
        // Optional fade-out over the last audioFadeOutSec so a soundtrack longer than the
        // picture ends musically instead of the hard -shortest chop. After apad on purpose:
        // apad is a no-op when the audio outruns the picture, and the fade must sit at the
        // end of the PICTURE either way.
        const fadeSec = audioFadeOutSec > 0 && Number(picSecs) > 0 ? Math.min(audioFadeOutSec, Number(picSecs) / 2) : 0;
        const fade = fadeSec > 0 ? `,afade=t=out:st=${Math.max(0, Number(picSecs) - fadeSec).toFixed(3)}:d=${fadeSec.toFixed(3)}` : '';
        const pad = delay + (Number(picSecs) > 0 ? `apad=whole_dur=${Number(picSecs).toFixed(3)}` : 'apad=whole_dur=600') + fade;
        ffmpeg().input(pictPath).input(aPath)
          .outputOptions(['-c:v copy', '-c:a aac', '-b:a 192k', '-map 0:v:0', '-map 1:a:0', '-af', pad, '-shortest'])
          .output(outputPath).on('end', resolve).on('error', reject).run();
      });
    } else {
      // pictPath, not silentPath — a reel with no voiceover must still keep its captions.
      fs.copyFileSync(pictPath, outputPath);
    }

    const seconds = await probeDuration(outputPath);
    tempVideos.set(token, { filePath: outputPath, createdAt: Date.now() });
    const publicUrl = `${req.protocol}://${req.get('host')}/api/temp-video/${token}`;
    console.log(`[reel:${token}] assembled ${normPaths.length}/${shots.length} shots, ${seconds}s at ${outW}x${outH}`);
    // ⚠️ captionsBurned / captionError were COMPUTED (see the burn block above) and never returned
    // — so a burn that silently did nothing was indistinguishable from captions being switched off,
    // which is exactly how First Week captions went unnoticed. The 2026-08-25 fix removed these two
    // fields from /api/temp-video (where they were an out-of-scope ReferenceError) but never added
    // them to THIS response, which is the one that owns them. Found 2026-09-01.
    res.json({ success: true, videoUrl: publicUrl, token, shotCount: normPaths.length,
               requested: shots.length, seconds, width: outW, height: outH, hasAudio: !!audioUrl,
               audioDelaySec, captionsRequested: cues.length, captionsBurned, captionError });
  } catch (err) {
    console.error(`[reel:${token}] error:`, err.message);
    res.status(500).json({ success: false, error: String(err.message || err).slice(0, 200) });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BEAT DETECTION (Beat Edit) — pure JS on mono Float32 PCM, zero dependencies.
// Written for strong-beat music (hardcore / hip-hop / electronic). Pipeline:
// two-band log-compressed frame energy (low band <150Hz weighted 2x — kicks
// dominate, hi-hats must not) -> novelty (positive first difference, moving-
// average normalised WITH a global-mean floor in the denominator, or near-
// silence amplifies its own noise) -> tempo by scoring a fractional-lag comb
// over 60-200 BPM (sub-frame resolution, no integer-lag quantisation) ->
// best phase -> beats tracked PREDICTIVELY from the last snapped beat
// (next = lastSnapped + lag, snap +-3 frames) so snapping corrects drift and
// survives real tracks' ~1% tempo wobble. Autocorrelation is inherently
// ambiguous DOWNWARD (every integer multiple of the true period aligns
// perfectly), so the truth is the FASTEST strong candidate, with extra
// confidence required to leave the 90-180 window.
// Validated 2026-08-28 against a synthetic harness (kick+hat+noise tracks at
// 70-190 BPM, silent intros, +-1% tempo ramps, 3dB SNR) and a real tech house
// mix: precision 90-100%, median beat error 5-9ms. Do not "simplify" the
// normalisation floor or the consecutive-snap intro trim — each closed a
// measured failure.
const BEAT_HOP = 512;
const BEAT_WIN = 1024;

function beatNovelty(pcm, sr) {
  const nFrames = Math.max(0, Math.floor((pcm.length - BEAT_WIN) / BEAT_HOP) + 1);
  if (nFrames < 8) return null;
  // One-pole low-pass at ~150Hz over the whole signal (kick band).
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  const low = new Float32Array(pcm.length);
  let y = 0;
  for (let i = 0; i < pcm.length; i++) { y += a * (pcm[i] - y); low[i] = y; }

  const logAll = new Float32Array(nFrames);
  const logLow = new Float32Array(nFrames);
  for (let n = 0; n < nFrames; n++) {
    const s = n * BEAT_HOP;
    let eA = 0, eL = 0;
    for (let i = s; i < s + BEAT_WIN; i++) { eA += pcm[i] * pcm[i]; eL += low[i] * low[i]; }
    logAll[n] = Math.log(1 + 1000 * eA);
    logLow[n] = Math.log(1 + 1000 * eL);
  }
  const nov = new Float32Array(nFrames);
  for (let n = 1; n < nFrames; n++) {
    nov[n] = 2 * Math.max(0, logLow[n] - logLow[n - 1]) + Math.max(0, logAll[n] - logAll[n - 1]);
  }
  let gSum = 0;
  for (let n = 0; n < nFrames; n++) gSum += nov[n];
  const gMean = gSum / nFrames;
  const half = Math.round((0.5 * sr) / BEAT_HOP);
  const out = new Float32Array(nFrames);
  let acc = 0;
  const win = 2 * half + 1;
  for (let n = 0; n < Math.min(nFrames, win); n++) acc += nov[n];
  for (let n = 0; n < nFrames; n++) {
    if (n - half - 1 >= 0) acc -= nov[n - half - 1];
    if (n + half < nFrames && n + half >= win) acc += nov[n + half];
    const lo = Math.max(0, n - half), hi = Math.min(nFrames - 1, n + half);
    let mean;
    if (lo === n - half && hi === n + half) mean = acc / win;
    else { let s2 = 0; for (let i = lo; i <= hi; i++) s2 += nov[i]; mean = s2 / (hi - lo + 1); }
    out[n] = nov[n] / (mean + 0.25 * gMean + 1e-6);
  }
  // Loudness envelope (for section-aware cut pacing): the same log energy,
  // smoothed over ~1s and normalised to 0..1 by its 95th percentile so one
  // transient cannot flatten the whole curve. This is what tells the planner
  // "this is the quiet intro" vs "this is the drop".
  const eHalf = Math.round((0.5 * sr) / BEAT_HOP);
  const energy = new Float32Array(nFrames);
  for (let n = 0; n < nFrames; n++) {
    const lo = Math.max(0, n - eHalf), hi = Math.min(nFrames - 1, n + eHalf);
    let s = 0;
    for (let i = lo; i <= hi; i++) s += logAll[i];
    energy[n] = s / (hi - lo + 1);
  }
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let n = 0; n < nFrames; n++) energy[n] = Math.max(0, Math.min(1, energy[n] / (p95 || 1)));
  return { nov: out, energy };
}

// Linear-interpolated read of the novelty curve at a fractional frame index.
function novAt(nov, t) {
  if (t < 0 || t > nov.length - 1) return 0;
  const i = Math.floor(t), f = t - i;
  return i + 1 < nov.length ? nov[i] * (1 - f) + nov[i + 1] * f : nov[i];
}

// Fractional-lag autocorrelation of the novelty at one candidate beat period,
// measured only from `from` onward (so a quiet intro cannot pollute it).
function periodScore(nov, period, from) {
  let s = 0, c = 0;
  const nMax = nov.length - Math.ceil(period) - 1;
  for (let n = Math.max(0, from | 0); n < nMax; n++) { s += nov[n] * novAt(nov, n + period); c++; }
  return c > 0 ? s / c : 0;
}

// First frame where the track is actually PLAYING — defined by TRANSIENTS, not
// loudness. MEASURED 2026-08-28: a track with an ambient/noise intro has the
// same loudness in the intro as it does BETWEEN kicks once the beat starts
// (RMS median 0.293 vs 0.307) — only the peaks differ (0.33 vs 1.16). So a
// loudness threshold cannot find the downbeat entry, and an energy-based
// version of this function measurably did nothing. A novelty bar can: the
// first real hit is the first frame clearing 60% of the track's peak novelty.
// Why it matters: estimating tempo and phase across an intro mis-phased a
// 5s-intro track in 6 of 12 seeded runs (precision as low as 56%), and a
// 10s intro failed 12/12. Do not swap this back to energy.
// ⚠️ The bar is a PERCENTILE, not the max, and the anchor is capped to the
// first quarter of the track. Both are load-bearing: keying off the max let a
// single loud noise transient raise the bar so high that the anchor landed deep
// into the track, leaving the phase search too few samples — that regressed a
// 3dB-SNR case from 96% to 0% precision (a clean half-beat offbeat lock).
function musicStartFrame(nov, novPeak) {
  // Bar is 60% of the track's PEAK novelty — a percentile bar was measured too
  // low (noise clears it, and both intro cases regressed straight back to
  // 40-56% precision). The positional cap is the separate guard: without it a
  // single loud transient late in a noisy track anchored the analysis deep into
  // the file, starving the phase search and flipping a 3dB case to a half-beat
  // offbeat lock (96% -> 0%). Music that has not started in the first quarter
  // is treated as starting at 0.
  const bar = 0.6 * novPeak;
  const cap = Math.floor(nov.length * 0.25);
  for (let n = 0; n < cap; n++) if (nov[n] >= bar) return n;
  return 0;
}

// Returns { beats, bpm, strengths, energy } on success, or { reason, stats } on
// failure. ⚠️ It must ALWAYS say WHY: this returned a bare null for three very
// different causes (unreadable audio, flat/silent novelty, no stable pulse) and
// the route reported all three as "no clear beats", which sent a real
// investigation chasing the tempo logic when the track was fine. Never collapse
// these back into one message.
function detectBeats(pcm, sr) {
  const secs = pcm.length / sr;
  const nv = beatNovelty(pcm, sr);
  if (!nv) return { reason: 'audio_too_short', stats: { seconds: +secs.toFixed(2) } };
  const nov = nv.nov, energyCurve = nv.energy;
  const fps = sr / BEAT_HOP;
  const nFrames = nov.length;

  // Reject silence / DC: novelty must have real structure.
  let novPeak = 0, novSum = 0;
  for (let n = 0; n < nFrames; n++) { if (nov[n] > novPeak) novPeak = nov[n]; novSum += nov[n]; }
  let peakAbs = 0;
  for (let i = 0; i < pcm.length; i++) { const a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > peakAbs) peakAbs = a; }
  const stats = { seconds: +secs.toFixed(2), novPeak: +novPeak.toFixed(2),
                  novMean: +(novSum / nFrames).toFixed(3), peakAmplitude: +peakAbs.toFixed(4) };
  if (peakAbs < 0.001) return { reason: 'silent_audio', stats };
  if (novPeak < 1.5 || novSum < nFrames * 0.05) return { reason: 'no_structure', stats };

  // Anchor tempo + phase to where the music actually starts.
  const startFrame = musicStartFrame(nov, novPeak);
  const scores = [];
  const scoreOfBpm = (bpm) => periodScore(nov, (fps * 60) / bpm, startFrame);
  let sMax = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.25) {
    const s = scoreOfBpm(bpm);
    scores.push([bpm, s]);
    if (s > sMax) sMax = s;
  }
  // Local maxima within 15% of the best score are tempo candidates; prefer the
  // FASTEST (sub-harmonics score as high as the truth), but leaving the 90-180
  // window needs >=95% of the best in-window candidate's score.
  const cands = [];
  for (let i = 1; i < scores.length - 1; i++) {
    const [b, s] = scores[i];
    if (s >= 0.85 * sMax && s >= scores[i - 1][1] && s >= scores[i + 1][1]) {
      if (!cands.length || b - cands[cands.length - 1][0] > 3) cands.push([b, s]);
      else if (s > cands[cands.length - 1][1]) cands[cands.length - 1] = [b, s];
    }
  }
  if (!cands.length) cands.push(scores.reduce((a, c) => (c[1] > a[1] ? c : a)));
  const inWin = cands.filter(([b]) => b >= 90 && b <= 180);
  let bpm = 0;
  for (let i = cands.length - 1; i >= 0; i--) {
    const [b, s] = cands[i];
    const ok = (b >= 90 && b <= 180) || !inWin.length || s >= 0.95 * Math.max(...inWin.map(x => x[1]));
    if (ok) { bpm = b; break; }
  }
  if (!bpm) bpm = cands[cands.length - 1][0];
  const lag = (fps * 60) / bpm;

  // Phase: search [0, lag) in quarter-frame steps, triangular +-1 frame kernel.
  let bestPhase = startFrame, bestPhaseScore = -1;
  for (let p = 0; p < lag; p += 0.25) {
    let s = 0;
    for (let t = startFrame + p; t < nFrames - 1; t += lag) {
      s += 0.5 * novAt(nov, t - 1) + novAt(nov, t) + 0.5 * novAt(nov, t + 1);
    }
    if (s > bestPhaseScore) { bestPhaseScore = s; bestPhase = startFrame + p; }
  }

  // Predictive tracking; quiet passages keep the predicted position (coast).
  const SNAP = 3;
  // Energy windows start rising ~1.4 frames BEFORE the true onset — measured
  // as a consistent -32ms bias in the harness, corrected here.
  const ONSET_OFFSET = 1.4;
  const trackGrid = (snapFloor) => {
    const out = [];
    let t = bestPhase;
    while (t < nFrames - 1) {
      let biIdx = Math.round(t), biVal = -1;
      const lo = Math.max(0, Math.round(t) - SNAP), hi = Math.min(nFrames - 1, Math.round(t) + SNAP);
      for (let i = lo; i <= hi; i++) { if (nov[i] > biVal) { biVal = nov[i]; biIdx = i; } }
      const didSnap = biVal >= snapFloor;
      const snapped = didSnap ? biIdx : t;
      const fi = Math.max(0, Math.min(nFrames - 1, Math.round(snapped)));
      out.push({
        t: (snapped + ONSET_OFFSET) * BEAT_HOP / sr,
        snapped: didSnap,
        // How hard THIS beat hits (0..1) — used to find the downbeat when cutting
        // every 2nd/4th beat, and to drive "strong beats only" pacing.
        s: Math.max(0, Math.min(1, nov[fi] / (novPeak || 1))),
        // How loud this part of the TRACK is (0..1) — drives section-aware pacing.
        e: energyCurve[fi],
      });
      t = snapped + lag;
    }
    return out;
  };

  // ⚠️ Keep the snap bar STRICT. A percentile bar was tried and measurably
  // broke the noisy-intro case: a 10s noise lead-in cleared the lower bar,
  // "snapped" twice in a row and defeated the intro trim (precision 100% -> 48%).
  // Noise failing to snap CONSISTENTLY is exactly what makes this rule work.
  // Dense-percussion tracks that barely snap are handled by degrading below,
  // not by lowering this bar.
  const snapFloor = 0.35 * novPeak / 2;
  const raw = trackGrid(snapFloor);
  // Drop everything before the first TWO CONSECUTIVE snapped beats — beats
  // "detected" over a quiet intro are noise-snaps or grid extrapolation.
  let firstReal = -1;
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i].snapped && raw[i + 1].snapped) { firstReal = i; break; }
  }
  let keep = firstReal < 0 ? [] : raw.slice(firstReal);
  // ⚠️ Degrade, do not fail. The intro-trim above is a REFINEMENT, and turning
  // it into a hard gate is what made a perfectly good 30s track return "no
  // beats": dense/irregular onsets never produced two consecutive confident
  // snaps, so a usable tempo grid was thrown away entirely. The phase search
  // already starts at the music, so the untrimmed grid is a reasonable edit —
  // far better than nothing. Only give up when there is no real grid at all.
  if (keep.length < 4 && raw.length >= 8) keep = raw;
  if (keep.length < 4) {
    const snapped = raw.filter(b => b.snapped).length;
    return { reason: 'no_stable_pulse',
             stats: { ...stats, bpmGuess: Math.round(bpm * 10) / 10, gridBeats: raw.length,
                      snappedBeats: snapped, snapFloor: +snapFloor.toFixed(2), kept: keep.length } };
  }

  // Refine pass: now that the intro is decided, nudge each kept beat onto the
  // nearest real onset using a LOWER bar than the trim used. The two bars do
  // different jobs and must stay separate — the strict bar is what stops a
  // noise intro faking a pulse (a blanket lower bar dropped a noisy-intro case
  // from 100% to 48% precision), while the trim decision is already made by the
  // time we get here, so refinement is safe. MEASURED in the harness: median
  // distance from a beat to a real onset 56.1ms -> 36.4ms on a real
  // tech-house track, with the intro trim and all synthetic cases unchanged.
  // Bounded to +-2 frames (~46ms) so it can only nudge, never re-time the grid.
  {
    const nz = Array.from(nov).filter(v => v > 0).sort((a, b) => a - b);
    const refineBar = nz.length ? nz[Math.floor(nz.length * 0.85)] : 0;
    if (refineBar > 0 && refineBar < snapFloor) {
      const R = 2;
      for (const b of keep) {
        const c = Math.round((b.t * sr / BEAT_HOP) - ONSET_OFFSET);
        let bi = -1, bv = refineBar;
        for (let i = Math.max(0, c - R); i <= Math.min(nFrames - 1, c + R); i++) {
          if (nov[i] > bv) { bv = nov[i]; bi = i; }
        }
        if (bi >= 0) {
          b.t = (bi + ONSET_OFFSET) * BEAT_HOP / sr;
          b.s = Math.max(0, Math.min(1, nov[bi] / (novPeak || 1)));
          b.e = energyCurve[bi];
        }
      }
      keep.sort((a, b) => a.t - b.t);
    }
  }
  return {
    bpm: Math.round(bpm * 10) / 10,
    beats: keep.map(b => b.t),
    strengths: keep.map(b => Math.round(b.s * 1000) / 1000),
    energy: keep.map(b => Math.round(b.e * 1000) / 1000),
  };
}

// Motion curve for ONE clip — the "which moment of this clip" signal.
// 16x16 gray at 8fps -> mean absolute frame-to-frame difference, normalised by
// the clip's own 95th percentile. Deliberately the same shape as hashVideo
// (temp file, never a pipe — see the rationale above it). No AI, ~1s per clip.
async function clipMotionCurve(filePath, maxSeconds) {
  const dur = await probeDuration(filePath);
  const rawPath = `${filePath}.mgray`;
  const FPS = 8, N = 16;
  await new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions(['-vf', `fps=${FPS},scale=${N}:${N},format=gray`, '-t', String(maxSeconds),
                      '-f', 'rawvideo', '-pix_fmt', 'gray'])
      .output(rawPath).on('end', resolve).on('error', reject).run();
  });
  const buf = fs.readFileSync(rawPath);
  try { fs.unlinkSync(rawPath); } catch (_) {}
  const size = N * N;
  const nF = Math.floor(buf.length / size);
  if (nF < 3) return null;
  const motion = new Array(nF).fill(0);
  for (let i = 1; i < nF; i++) {
    let s = 0;
    for (let p = 0; p < size; p++) s += Math.abs(buf[i * size + p] - buf[(i - 1) * size + p]);
    motion[i] = s / size;
  }
  motion[0] = motion[1];
  const sorted = [...motion].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  return { dur, fps: FPS, motion: motion.map(m => Math.round(Math.min(1, m / (p95 || 1)) * 1000) / 1000) };
}

// POST /api/clip-motion  { clipUrls: [...], maxSeconds }
// Returns a per-clip motion curve so the cut planner can pick WHICH MOMENT of a
// clip to use instead of walking a blind cursor — the thing every comparable
// tool does (GoPro Quik, Beatleap, BeatSync-Engine) and v1 did not.
// Per-clip failures are non-fatal: a null curve makes the planner fall back to
// the cursor for that clip, so one dead URL can never block an edit.
app.post('/api/clip-motion', async (req, res) => {
  const urls = Array.isArray(req.body?.clipUrls) ? req.body.clipUrls.filter(u => /^https?:\/\//i.test(u)).slice(0, 12) : [];
  const maxSeconds = Math.min(120, Math.max(2, parseInt(req.body?.maxSeconds) || 60));
  if (!urls.length) return res.status(400).json({ success: false, error: 'Missing clipUrls' });
  const token = `motion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
  try {
    const clips = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const p = path.join(tmpDir, `c${i}`);
        const dl = await axios.get(urls[i], { responseType: 'arraybuffer', timeout: 90000, maxContentLength: 320 * 1024 * 1024 });
        fs.writeFileSync(p, Buffer.from(dl.data));
        const curve = await clipMotionCurve(p, maxSeconds);
        clips.push(curve ? { url: urls[i], ...curve } : { url: urls[i], error: 'too short to analyse' });
        try { fs.unlinkSync(p); } catch (_) {}
      } catch (e) {
        console.warn(`[motion:${token}] clip ${i + 1} failed: ${e.message}`);
        clips.push({ url: urls[i], error: String(e.message || e).slice(0, 120) });
      }
    }
    console.log(`[motion:${token}] analysed ${clips.filter(c => c.motion).length}/${urls.length} clips`);
    res.json({ success: true, clips });
  } catch (err) {
    console.error(`[motion:${token}] error:`, err.message);
    res.status(500).json({ success: false, error: String(err.message || err).slice(0, 200) });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// POST /api/beat-detect  { audioUrl, maxSeconds }
// Analyses a soundtrack for the Beat Edit feature: returns the BPM and the
// beat timestamps (seconds) of the first `maxSeconds`, plus the full track
// length. Decode goes to a TEMP FILE, never a pipe (same rationale as
// hashVideo above). Pure ffmpeg + JS — no per-run cost, no new deps.
app.post('/api/beat-detect', async (req, res) => {
  const audioUrl = req.body?.audioUrl || '';
  const maxSeconds = Math.min(120, Math.max(10, parseInt(req.body?.maxSeconds) || 90));
  if (!/^https?:\/\//i.test(audioUrl)) return res.status(400).json({ success: false, error: 'Missing or invalid audioUrl' });

  const token = `beat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'));
  try {
    const inputPath = path.join(tmpDir, 'in.audio');
    const dl = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 90000, maxContentLength: 80 * 1024 * 1024 });
    fs.writeFileSync(inputPath, Buffer.from(dl.data));
    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size < 1000) {
      return res.status(400).json({ success: false, error: 'Audio file was empty or could not be downloaded' });
    }
    const rawPath = path.join(tmpDir, 'a.f32');
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(['-vn', '-ac', '1', '-ar', '22050', '-t', String(maxSeconds), '-f', 'f32le'])
        .output(rawPath).on('end', resolve).on('error', reject).run();
    });
    const buf = fs.readFileSync(rawPath);
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    // ffmpeg can exit 0 having written nothing usable (wrong/partial container,
    // a file with no real audio stream). That is NOT "no beats" — reporting it
    // as such is what made a decode problem look like a detection problem.
    if (pcm.length < 22050) {
      console.error(`[beat:${token}] decode produced ${pcm.length} samples from ${fs.statSync(inputPath).size}B`);
      return res.status(422).json({ success: false, error: 'Could not read any audio from that file — try exporting it as a normal MP3.' });
    }
    const result = detectBeats(pcm, 22050);
    if (result.reason) {
      console.error(`[beat:${token}] ${result.reason} ${JSON.stringify(result.stats)}`);
      const msg = {
        audio_too_short: 'That clip is too short to find a beat in — use at least a few seconds of audio.',
        silent_audio: 'That file decoded to silence — check it plays, and try exporting it as a normal MP3.',
        no_structure: 'No clear beats found in this track — try a song with a stronger beat.',
        no_stable_pulse: 'Found the audio but could not lock onto a steady pulse — try a track with a steadier beat, or a different section of it.',
      }[result.reason] || 'No clear beats found in this track.';
      return res.status(422).json({ success: false, error: msg, reason: result.reason, stats: result.stats });
    }
    const audioSeconds = await probeDuration(inputPath);
    console.log(`[beat:${token}] ${result.bpm} BPM, ${result.beats.length} beats in ${(pcm.length / 22050).toFixed(1)}s analysed (track ${audioSeconds}s)`);
    res.json({ success: true, bpm: result.bpm, beats: result.beats.map(b => Math.round(b * 1000) / 1000),
               strengths: result.strengths, energy: result.energy,
               audioSeconds, analysedSeconds: pcm.length / 22050 });
  } catch (err) {
    console.error(`[beat:${token}] error:`, err.message);
    res.status(500).json({ success: false, error: String(err.message || err).slice(0, 200) });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

app.post('/api/extract-audio', async (req, res) => {
  const { videoUrl } = req.body || {};
  const maxSeconds = Math.min(120, Math.max(5, parseInt(req.body?.maxSeconds) || 60));
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
  const inputPath = path.join(tmpDir, 'in.mp4');
  const outPath = path.join(tmpDir, 'out.mp3');
  try {
    const isInstagram = /instagram\.com\/(p|reel|reels)\//.test(videoUrl);
    const isTikTok = /tiktok\.com\/@[^/]+\/video\/|tiktok\.com\/t\//.test(videoUrl);

    if (isInstagram) {
      await downloadInstagramViaApify(videoUrl, inputPath);
    } else if (isTikTok) {
      await downloadTikTok(videoUrl, inputPath, async () => {
        execSync(`yt-dlp -f "best[ext=mp4]/best" -o "${inputPath}" "${videoUrl}"`, { stdio: 'pipe', timeout: 180000 });
      });
    } else {
      const dl = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000, maxContentLength: 300 * 1024 * 1024 });
      fs.writeFileSync(inputPath, Buffer.from(dl.data));
    }
    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size < 1000) {
      return res.status(400).json({ success: false, error: 'Could not download that video — the post may be private, or the link may have expired.' });
    }

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(['-vn', '-ac', '1', '-ar', '44100', '-b:a', '192k', '-t', String(maxSeconds)])
        .audioCodec('libmp3lame')
        .output(outPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 2000) {
      return res.status(400).json({ success: false, error: 'That video has no usable audio track.' });
    }
    const seconds = await probeDuration(outPath);
    res.json({ success: true, seconds, b64: fs.readFileSync(outPath).toString('base64') });
  } catch (err) {
    console.error('[extract-audio] error', err.message);
    res.status(500).json({ success: false, error: String(err.message || err).slice(0, 200) });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

app.post('/api/extract-frames', async (req, res) => {
  const { videoUrl } = req.body || {};
  const count = Math.min(5, Math.max(1, parseInt(req.body?.count) || 3));
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'));
  const inputPath = path.join(tmpDir, 'in.mp4');
  try {
    const dl = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 200 * 1024 * 1024 });
    fs.writeFileSync(inputPath, Buffer.from(dl.data));

    const dur = await probeDuration(inputPath);
    // Sample strictly INSIDE the clip: the first and last frames of a first-frame-anchored
    // video are the least informative (frame 1 is the anchor we already checked).
    const stamps = [];
    for (let i = 0; i < count; i++) {
      const frac = (i + 1) / (count + 1);
      stamps.push(Math.max(0.05, (dur > 0.2 ? dur : 1) * frac));
    }

    const frames = [];
    for (let i = 0; i < stamps.length; i++) {
      const outPath = path.join(tmpDir, `f${i}.jpg`);
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .seekInput(stamps[i].toFixed(3))
            .outputOptions(['-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '4'])
            .output(outPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        if (fs.existsSync(outPath)) {
          frames.push({ ts: Number(stamps[i].toFixed(2)), b64: fs.readFileSync(outPath).toString('base64') });
        }
      } catch (e) {
        console.warn('[extract-frames] frame ' + i + ' failed: ' + e.message);
      }
    }
    if (!frames.length) return res.status(500).json({ success: false, error: 'Could not extract any frames' });
    res.json({ success: true, duration: dur, frames });
  } catch (err) {
    console.error('[extract-frames] error', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

app.post('/api/phash-compare', async (req, res) => {
  const { videoUrl, compareUrls, frames } = req.body || {};
  if (!videoUrl || !Array.isArray(compareUrls) || !compareUrls.length) {
    return res.status(400).json({ success: false, error: 'Need videoUrl and a non-empty compareUrls array' });
  }
  const n = Math.max(3, Math.min(12, parseInt(frames, 10) || 6));
  const urls = compareUrls.slice(0, 10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phash-'));

  try {
    const grab = async (u, name) => {
      const p = path.join(tmpDir, name);
      const r = await axios.get(u, { responseType: 'arraybuffer', timeout: 120000 });
      fs.writeFileSync(p, Buffer.from(r.data));
      return p;
    };

    const baseHashes = await hashVideo(await grab(videoUrl, 'base.mp4'), n);

    const results = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const h = await hashVideo(await grab(urls[i], `cmp${i}.mp4`), n);
        const pairs = Math.min(baseHashes.length, h.length);
        if (!pairs) throw new Error('No comparable frames');
        let total = 0, max = 0;
        for (let f = 0; f < pairs; f++) {
          const d = hamming(baseHashes[f], h[f]);
          total += d; if (d > max) max = d;
        }
        const avg = total / pairs;
        results.push({ index: i + 1, url: urls[i], framesCompared: pairs,
          avgDistance: +avg.toFixed(2), maxDistance: max, ...verdictFor(avg) });
      } catch (e) {
        results.push({ index: i + 1, url: urls[i], error: e.message });
      }
    }
    res.json({ success: true, frames: n, bits: 64, baseFrames: baseHashes.length, results });
  } catch (err) {
    console.error('[phash] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

app.post('/api/variants', async (req, res) => {
  const { videoUrl, count, seed, intensity, flip } = req.body || {};
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });
  const n = Math.max(1, Math.min(VARIANT_MAX, parseInt(count, 10) || 3));
  const runSeed = String(seed || Date.now());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'variants-'));
  const inputPath = path.join(tmpDir, 'input.mp4');

  try {
    const dl = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
    fs.writeFileSync(inputPath, Buffer.from(dl.data));
    const { width, height } = await getVideoDimensions(inputPath);
    if (!width || !height) throw new Error('Could not read video dimensions');

    const out = [];
    for (let i = 0; i < n; i++) {
      const v = buildVariant(variantRng(runSeed, i), width, height, intensity, { flip: !!flip });
      const token = `var_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const outPath = path.join(os.tmpdir(), `tempvid_${token}.mp4`);

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(inputPath)
          .outputOptions([
            '-vf', v.vf,
            '-af', v.af,
            // CRF 18 = visually transparent for this purpose. A re-encode is
            // unavoidable here (changing pixels is the whole point), so the
            // job is to make the loss negligible rather than pretend it away.
            '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-fflags', '+bitexact',
          ]);
        cmd.output(outPath).on('end', resolve).on('error', reject).run();
      });

      if (!fs.existsSync(outPath)) throw new Error(`Variant ${i + 1} produced no file`);
      tempVideos.set(token, { filePath: outPath, createdAt: Date.now() });
      out.push({
        index: i + 1,
        variantId: `${runSeed}-${i + 1}`,
        url: `${req.protocol}://${req.get('host')}/api/temp-video/${token}`,
        label: v.label,
        params: v.params,
        bytes: fs.statSync(outPath).size,
      });
      console.log(`[variants:${runSeed}] ${i + 1}/${n} ${v.label}`);
    }

    res.json({ success: true, seed: runSeed, count: out.length, dimensions: { width, height }, variants: out });
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    console.error(`[variants:${runSeed}] error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`InfluencerFounder Video Analyser running on port ${PORT}`);
});

module.exports = app;
