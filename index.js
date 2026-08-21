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
}

const app = express();
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
  res.json({ status: 'ok', service: 'InfluencerFounder Video Analyser', version: '2.1.0', timestamp: new Date().toISOString() });
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

app.post('/api/clone', async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));

  try {
    // mode 'bgswap' reuses this endpoint's ENTIRE download + frame-extraction path
    // (Apify for Instagram, yt-dlp for TikTok, axios for a direct URL, then ffmpeg)
    // and only swaps the system prompt and response shape. A separate endpoint would
    // have duplicated all of that — the duplication class this codebase keeps paying
    // for. Default '' keeps every existing caller byte-identical.
    const { videoUrl, locationId, kieApiKey, mode, bgBrief } = req.body;
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

    if (isInstagram) {
      try {
        await downloadInstagramViaApify(videoUrl, videoPath);
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

      await new Promise((resolve, reject) => {
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
      });
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

    const extractFrame = (ts, outPath) => new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(ts)
        .outputOptions([
          '-vframes 1',
          '-q:v 5',           // slightly lower quality = smaller file, less memory
          '-vf scale=640:-1', // cap width at 640px — Claude vision doesn't need full res
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
    const frameDataUrls = pickerFiles.map(f => {
      const b64 = fs.readFileSync(path.join(framesDir, f)).toString('base64');
      return `data:image/jpeg;base64,${b64}`;
    });

    // ── Scorecard v2 (2026-07-10) ──
    // Timestamps for the picker frames (fps-based extraction: frame n ≈ n/fps seconds)
    const frameTimestamps = pickerFiles.map(pf => Math.round((frameFiles.indexOf(pf) / fps) * 10) / 10);
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
      await extractFrame(0.1, firstFramePath);
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

    const userText = transcript
      ? `These ${frameBase64s.length} frames were extracted from the viral video. Transcript: "${transcript}"\n\nCreate the Seedance prompt.`
      : `These ${frameBase64s.length} frames were extracted from the viral video (no audio). Create the Seedance prompt.`;

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
(3) The output contains absolutely NO audio of any kind — no voiceover, no music, no ambient sound, no sound effects. The final video is completely silent.

[X] seconds total, vertical 9:16. Ultra-realistic iPhone UGC look throughout, completely silent output with zero text.

LOCKED RULES — apply to every prompt without exception:
1. OWNERSHIP CLAUSE: always open with the "recreation of my own original... I own @video_1 and all rights to it" line. It clarifies legitimacy and passes classifier safety checks.
2. FULL REFERENCE FRAMING: always state "@video_1 is the full reference for everything in the output". Trust the reference; never re-describe the shots in granular beat-sheet detail.
3. "ONLY change" FRAMING: always isolate the delta as a numbered list. (1) is always the environment/element swap, (2) is always the text strip, (3) is always the audio strip. This three-point structure is mandatory.
4. TRIPLE-LOCK TEXT STRIP: always include the explicit no-text line, worded as in the template.
5. TRIPLE-LOCK AUDIO STRIP: always include the explicit no-audio line, worded as in the template.
6. DURATION: state it at the top and again at the bottom. Use the exact duration given to you below — do not estimate it from the frames.
7. ASPECT RATIO: always specify "vertical 9:16".
8. REALISM CLOSE: always close with "Ultra-realistic iPhone UGC look throughout, completely silent output with zero text".
9. FOREGROUND INVENTORY: when describing what to keep, briefly list the ACTUAL elements visible in the frames — clothing, product, hand jewellery, surface props. Do not invent. Do not describe shots beat by beat.
10. ENVIRONMENT DENSITY: for the swap, be specific and visually rich — materials, colours, lighting tone, props, atmosphere. Never lazy ("luxurious room"). Write like "deep walnut wood panelled wall with brass accents, low-profile platform bed with cream linen, warm ambient pendant light, Persian rug on travertine floor". Density of specific visual elements produces better output.

DEFENSIVE FRAMING — if the source is a potentially sensitive context (bathroom + water, intimate-coded setting) and a classifier might block generation, layer these in: "styled product showcase set" instead of "real bathroom"; "clothed reviewer's hand" instead of "a hand"; "well-lit ambient product display lighting" instead of "moody dim lighting"; "no person present in the set" where applicable. Drop romantic/intimate/spa/sensual vocabulary. The ownership clause already helps; these push it further.

MULTI-SCENE EDGE CASE — if the source has distinct scenes needing different backgrounds, you may specify per scene within the single prompt: "For scenes where [foreground cue X] is visible, replace the background with [environment A]. For scenes where [foreground cue Y] is visible, replace the background with [environment B]." Say in the ANALYSIS that this is a stretch case and Seedance may mix the swaps, and recommend the fallback: split the source in CapCut, generate each scene as its own prompt, recombine in post.

TWO-VERSION RULE — if the creative direction has interpretive room ("make it luxurious", "Star Wars themed", "a cool nighttime spot"), deliver PROMPT A and PROMPT B with meaningfully DIFFERENT aesthetic directions, not minor tweaks, each with a short vibe label. If the brief is already highly specific ("matte black walls + brass fixtures + travertine floor"), deliver PROMPT A only — do not pad with a near-identical variant.

CRITICAL DON'TS — never use the heavy 3-block CRITICAL KEEP / CRITICAL CHANGE / DO NOT structure here. Never re-describe the source shot by shot. Never deliver partial blocks or "insert this here" instructions; every prompt must be complete and copy-pasteable. Never skip the text strip, the audio strip, or the ANALYSIS section. Never add disclaimers, caveats or filler.`;

    const systemPrompt = `You are a Seedance 2.5 prompt engineer. Study the frames and transcript carefully and follow these four steps exactly.

STEP 1 — CLASSIFY THE SOURCE as exactly one of TWO lanes:
- AUTHENTIC: phone-shot / creator-made — handheld or propped phone, casual real-world setting, available or simple lighting, unpolished. The huge majority of viral short-form lives here.
- HIGH-END: professionally produced — cinema or commercial camera work, deliberate composition, controlled lighting, graded color.

This classification is INTERNAL — it only decides which realism layer Step 3 appends. Never print a lane name anywhere in the output. When genuinely torn, choose AUTHENTIC — polished-looking creator content is still phone-made far more often than it looks.

STEP 2 — BUILD THE BASE PROMPT using this structure: Shot scaffold + Subject + Action + Environment + Camera + Lighting + Style. Rules:
- Open with a short capture-style scaffold as the very first clause — plain language matching the Step 1 lane, but never the lane word itself and never aspect ratio or duration (the tool sets 9:16 and clip length separately). E.g. "Handheld phone selfie capture:" or "Cinema camera capture:". Never bury this mid-prompt
- Use [INFLUENCER] as the person placeholder — do NOT describe physical appearance (no hair color, eye color, skin tone, height, build — reference photos handle that)
- Describe outfit, action, environment, mood, shot progression
- Use ONE primary camera movement, chosen from Seedance's own vocabulary: push-in, pull-out, pan, tracking/follow, orbit, handheld, fixed. A compound move must be sequential ("slow push-in then subtle rise") — never simultaneous ("dolly in while panning left")
- Keep camera movement and subject movement in SEPARATE clauses — mixing them in one clause is Seedance's most common documented failure mode
- Name specific lighting direction and quality, and make it slightly imperfect — real light is uneven ("warm window light from the left, slightly hot on one cheek, soft shadow falloff to the right" beats "natural lighting")
- Ground the scene in a lived-in world: one or two ordinary specific details (a half-empty glass on the counter, a jacket over the chair, a slightly crooked picture frame) beat a clean empty backdrop — real rooms are never perfectly tidy or symmetric
- If any beat shows hands touching an object (phone, cup, product, fabric), anchor the hand explicitly to it (e.g. "fingers grip the phone case") — free-floating hand descriptions are the most common cause of hand artifacts
- Use timestamp beats for shot progression: [0-2s]: opening beat. [2-5s]: main action. Keep each beat to 1-2 sentences. Weave natural involuntary human motion through the beats: a soft slightly-uneven blink (never metronomic), a visible breath with gentle shoulder rise, a glance at something specific then back (gaze always has a destination — a locked dead-center stare renders as frozen and glassy), a small weight shift or self-adjustment (brushing a strand of hair back, tugging a sleeve). Different body parts move on slightly different timing — overlapping, never synchronized
- If the person walks in any beat, describe real gait mechanics: heel-to-toe footsteps with weight shifting onto each leg, arms swinging opposite the legs, head staying level — never a gliding or floating walk
- Target 60-100 words total for the base prompt. Never exceed 150 words — Seedance ignores details beyond that.

STEP 3 — DO NOT append any realism layer, camera-quality block, fps mention, or avoid-list yourself. The server appends the lane's realism layer and the negative suffix in code (so the user can switch lanes afterwards). Your base prompt must not duplicate that content — never write sensor noise / film grain / "avoid ..." lines, and never demand "sharp clarity" or "stable picture".

OUTPUT FORMAT — exactly this, nothing else:
Line 1: "LANE: AUTHENTIC" or "LANE: HIGH-END" (stripped by the server and shown to the user as a switchable choice — it is the ONLY place the lane may appear).
Line 2: "TALKING: YES" or "TALKING: NO" — YES only if the video is a TALKING-HEAD: a person on camera actually SPEAKING/narrating to the viewer with lip-synced spoken words (a monologue, piece-to-camera, vlog talk, interview answer). NO for everything else — music videos / lip-syncing to a song / singing, dance, product b-roll, montage, voiceover-over-visuals with no on-camera speaker, or no speech at all. When unsure, answer NO.
Then a blank line, then ONLY the Step 2 base prompt text. No JSON, no explanation, and never a lane word inside the prompt itself.`;

    // Lane realism layers + negative suffix are appended in CODE (not by Claude) so
    // they are verbatim-stable — the frontend holds both layers and can swap them
    // exactly when the user overrides the detected lane before generating.
    const LANE_LAYERS = {
      'AUTHENTIC': 'Filmed on a smartphone: natural hand tremor with small framing corrections, slightly off-center framing, mild lens softness, faint sensor noise, mild compression artifacts, small auto-exposure shifts, uneven ambient lighting with natural shadow falloff, real skin with visible pores and tiny blemishes, no beauty filter, stray hair flyaways, natural facial asymmetry, lived-in surroundings, unedited social-media snapshot look, 30fps.',
      'HIGH-END': 'Shot on a cinema camera: subtle lens vignetting, gentle highlight halation, fine organic film grain, controlled lighting with soft physical falloff and true shadows, photorealistic skin keeping pores and micro-texture under the key light, restrained filmic color grade, performers with natural body weight and visible breath, never posed stillness, 24fps.',
    };
    // Footwear is stated explicitly because the influencer's own full-body
    // reference photo is a plain studio shot and is very often BAREFOOT (it is
    // generated for ink/proportion capture, not wardrobe). Seedance faithfully
    // reproduces that reference, so without this line the persona walks out of a
    // car or down a street with no shoes on. Phrased as a setting rule rather
    // than "always wear shoes" so beach/pool/at-home scenes stay correct.
    const LANE_SUFFIX = 'Footwear fits the setting: the person wears shoes anywhere a real person would — street, car, shop, gym, office, any public indoor space — and is barefoot only where that is genuinely natural, such as a beach, pool or inside their own home. Avoid jitter, bent limbs, temporal flicker, warping or morphing, and extra fingers. No music — natural ambient background sound only.';

    // Kie.ai's Claude endpoint is native Anthropic Messages format (verified
    // 2026-07-17 with real base64 frames — identical request shape, model
    // string and auth header are the only differences), so the same
    // system/messages body serves both branches.
    // bgswap needs the real measured duration (rule 6 forbids estimating it) and a
    // far larger token budget: analysis + up to two full templated prompts.
    const sysFinal = isBgSwap ? BG_SWAP_SYSTEM : systemPrompt;
    const userFinal = isBgSwap
      ? `These ${frameBase64s.length} frames were extracted from my own source video. `
        + `Its exact duration is ${Math.round(duration * 10) / 10} seconds — use this figure, do not estimate.\n\n`
        + `The background change I want: ${String(bgBrief || '').trim() || '(none specified — ask one clarifying question in the ANALYSIS instead of guessing)'}`
      : userText;
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
      const KIE_SAFE_FRAME_COUNT = 20;
      const n = Math.min(KIE_SAFE_FRAME_COUNT, imageContent.length);
      const subset = n === imageContent.length
        ? imageContent
        : Array.from({ length: n }, (_, i) => imageContent[Math.round(i * (imageContent.length - 1) / (n - 1))]);
      const note = n < imageContent.length ? ` (${n} representative frames shown, evenly sampled from the full clip.)` : '';
      claudeResponse = await axios.post('https://api.kie.ai/claude/v1/messages', {
        model: 'claude-sonnet-5', max_tokens: maxTok, system: sysFinal,
        messages: [{ role: 'user', content: [...subset, { type: 'text', text: userFinal + note }] }]
      }, { headers: { 'Authorization': `Bearer ${kieApiKey}`, 'Content-Type': 'application/json' }, timeout: 80000 });
    } else {
      claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6', max_tokens: maxTok, system: sysFinal,
        messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: userFinal }] }]
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
    const clonePrompt = `${basePrompt} ${LANE_LAYERS[lane]} ${LANE_SUFFIX}`;

    res.json({
      success: true,
      frames: frameDataUrls,
      frameTimestamps,
      hookFrames,
      durationSec: Math.round(duration * 10) / 10,
      firstFrameUrl: firstFrameUrl || frameDataUrls[0] || '',
      transcript,
      transcriptError: transcriptError || undefined,
      talkingHead,
      lane,
      laneLayers: LANE_LAYERS,
      metadata: { duration: Math.round(duration) + 's', frameCount: frameBase64s.length, hasAudio: !!transcript },
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

function cleanOldTempVideos() {
  const cutoff = Date.now() - 30 * 60 * 1000; // 30 min TTL
  for (const [token, v] of tempVideos) {
    if (v.createdAt < cutoff) {
      try { fs.unlinkSync(v.filePath); } catch (_) {}
      tempVideos.delete(token);
    }
  }
}

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
      await execFileAsync(ytDlpPath, [
        '--no-playlist', '-f', 'mp4/best[height<=720]', '--merge-output-format', 'mp4',
        '-o', outputPath, videoUrl,
      ], { timeout: 120000 });
    }

    if (!fs.existsSync(outputPath)) throw new Error('Download produced no output file');
    const stat = fs.statSync(outputPath);
    console.log(`[tempvid:${token}] downloaded: ${Math.round(stat.size / 1024)}KB`);

    tempVideos.set(token, { filePath: outputPath, createdAt: Date.now() });
    const publicUrl = `${req.protocol}://${req.get('host')}/api/temp-video/${token}`;
    res.json({ captionsBurned, captionError, captionCues: cues.length, success: true, videoUrl: publicUrl, token });
  } catch (err) {
    try { fs.unlinkSync(outputPath); } catch (_) {}
    console.error(`[tempvid:${token}] error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/temp-video/:token — serve the downloaded video
app.get('/api/temp-video/:token', (req, res) => {
  const v = tempVideos.get(req.params.token);
  if (!v || !fs.existsSync(v.filePath)) return res.status(404).json({ error: 'Video not found or expired' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(v.filePath).pipe(res);
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
      return `drawtext=fontfile='${CAPTION_FONT_PATH}':textfile='${f}':expansion=none:fontsize=${fontSize}:fontcolor=white:borderw=${Math.round(fontSize * 0.12)}:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'`;
    });

    // Pin frame size and pixel format BEFORE the drawtext chain. "Error reinitializing
    // filters!" is ffmpeg rebuilding the graph because incoming frame properties changed
    // mid-stream; pinning them means it never has to.
    const filters = [`scale=${safeW}:${safeH}`, 'format=yuv420p', ...drawFilters];

    if (!drawFilters.length) throw new Error('No caption chunks generated');

    // 5. Burn the captions onto the video
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(videoPath)
        .outputOptions(['-vf', filters.join(','), '-c:a', 'copy'])
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
          .outputOptions(['-r 24', '-c:v libx264', '-preset veryfast', '-pix_fmt yuv420p', '-an', '-threads 1'])
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
// DEVICE STAMP — write Apple-shaped QuickTime metadata into a video.
// OWNER-ONLY EXPERIMENT (gated upstream on Vercel, never exposed to students).
//
// Remux only: `-c copy` on both streams, so the bitstream is never re-encoded
// and there is zero quality loss. Adding atoms shifts byte offsets, which is
// exactly what would break `stco` if we edited in place — remuxing sidesteps
// that because ffmpeg rebuilds the offset tables correctly.
//
// SECURITY: this accepts a PROFILE OBJECT, never ffmpeg arguments. Raw args
// over HTTP would let any caller drive ffmpeg. Keys come from a fixed
// whitelist below; only values are taken from the request, and they are
// sanitised (control chars stripped, length capped) before use.
// ─────────────────────────────────────────

// Only these metadata keys may ever be written. Adding to this list is a
// deliberate act; the request cannot introduce a new key.
// NOTE: a generic `location` key is deliberately absent. ffmpeg's mov muxer
// rewrites it into `location` + `location-eng` with a 6-decimal altitude,
// which then sits in the file contradicting the correctly-padded ISO6709 key.
const STAMP_KEYS = [
  'com.apple.quicktime.make',
  'com.apple.quicktime.model',
  'com.apple.quicktime.software',
  'com.apple.quicktime.creationdate',
  'com.apple.quicktime.location.ISO6709',
  'com.apple.quicktime.location.accuracy.horizontal',
  'make',
  'model',
  'creation_time',
];

// Fixed output flags, hardcoded here rather than accepted from the request.
// Combination established by measurement (see deviceStamp.js for the full note):
//   -fflags +bitexact     removes ffmpeg's own `encoder: Lavf<ver>` signature
//   -map_metadata:s:* -1  drops inherited stream tags such as the generator's
//                         `encoder: Lavc.. libx264`. Using `-metadata:s:v
//                         encoder=` instead makes ffmpeg write `vendor_id:
//                         FFMP`, which is a worse tell — do not "simplify" to it.
//   -map 0 -ignore_unknown  ffmpeg's DEFAULT stream selection keeps only the
//                         single "best" video + "best" audio and silently drops
//                         everything else. Measured on a 4-stream test file:
//                         788,493 -> 587,054 bytes, having thrown away a second
//                         audio track and a data track with no error. -map 0
//                         preserves every stream; -ignore_unknown skips the ones
//                         mp4 genuinely cannot hold instead of failing the run.
const STAMP_FIXED_ARGS = [
  '-map', '0',
  '-ignore_unknown',
  '-fflags', '+bitexact',
  '-map_metadata:s:v', '-1',
  '-map_metadata:s:a', '-1',
];

function sanitiseMetaValue(v) {
  if (v === null || v === undefined) return null;
  // Strip control characters and newlines (which would corrupt the atom),
  // collapse whitespace, cap length.
  const s = String(v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 256);
  return s.length ? s : null;
}

app.post('/api/stamp-video', async (req, res) => {
  const { videoUrl, metadata } = req.body || {};
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });
  if (!metadata || typeof metadata !== 'object') {
    return res.status(400).json({ success: false, error: 'Missing metadata object' });
  }

  // Build args from the whitelist, not from whatever the caller sent.
  const args = ['-movflags', 'use_metadata_tags', ...STAMP_FIXED_ARGS];
  const written = {};
  for (const key of STAMP_KEYS) {
    const val = sanitiseMetaValue(metadata[key]);
    if (val === null) continue;
    written[key] = val;
  }
  if (!Object.keys(written).length) {
    return res.status(400).json({ success: false, error: 'No recognised metadata keys supplied' });
  }

  const token = `stamp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  const inputPath = path.join(tmpDir, 'input.mp4');
  const outputPath = path.join(os.tmpdir(), `tempvid_${token}.mp4`);

  try {
    const dl = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
    fs.writeFileSync(inputPath, Buffer.from(dl.data));
    const inBytes = fs.statSync(inputPath).size;

    await new Promise((resolve, reject) => {
      // -c copy on BOTH streams: container rewrite only, pixels and audio
      // are bit-for-bit identical to the input.
      const cmd = ffmpeg(inputPath).outputOptions(['-c', 'copy', ...args]);
      // ⚠️ Each -metadata pair MUST go in as varargs, never as a 2-element
      // array. fluent-ffmpeg splits an array element containing exactly two
      // space-separated tokens into option+value, so
      //   ['-metadata', 'com.apple.quicktime.model=iPhone 14']
      // became  ... 'model=iPhone', '14'  and ffmpeg then treated '14' as an
      // output filename ("Error opening output file 14"). Measured: a
      // two-token value splits, a three-or-more-token value does not — which
      // is why 'iPhone 13 mini' and 'iPhone 14 Pro Max' worked while
      // 'iPhone 13/14/15' failed. Varargs are never split.
      for (const [key, val] of Object.entries(written)) {
        cmd.outputOptions('-metadata', `${key}=${val}`);
      }
      cmd.output(outputPath).on('end', resolve).on('error', reject).run();
    });

    if (!fs.existsSync(outputPath)) throw new Error('Stamp produced no output file');
    const outBytes = fs.statSync(outputPath).size;

    tempVideos.set(token, { filePath: outputPath, createdAt: Date.now() });
    const publicUrl = `${req.protocol}://${req.get('host')}/api/temp-video/${token}`;
    console.log(`[stamp:${token}] ${inBytes} -> ${outBytes} bytes, ${Object.keys(written).length} keys`);
    res.json({ success: true, videoUrl: publicUrl, token, written, inBytes, outBytes });
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    console.error(`[stamp:${token}] error:`, message);
    res.status(500).json({ success: false, error: message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

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
      `:fontcolor=${opts.color || 'white'}:borderw=${Math.round(fontSize * 0.14)}:bordercolor=black@0.85` +
      `:x=(w-text_w)/2:y=${y}:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'`
    );
  });

  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .videoFilters(filters)
      .outputOptions(['-c:v libx264', '-preset veryfast', '-pix_fmt yuv420p', '-an', '-threads 1'])
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
  const shots = Array.isArray(req.body?.shots) ? req.body.shots.filter(x => x && x.url).slice(0, 40) : [];
  const audioUrl = req.body?.audioUrl || '';
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
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i];
      const secs = Math.min(10, Math.max(0.3, Number(sh.seconds) || 1));
      // Which second of the source clip to use. Without this the reel always took the FIRST
      // `secs` of a 5s generation — usually the weakest part, because the model eases into the
      // motion. startAt lets the operator pick the good moment instead.
      const startAt = Math.max(0, Math.min(60, Number(sh.startAt) || 0));
      const srcPath = path.join(tmpDir, `src${i}`);
      const outPath = path.join(tmpDir, `n${i}.mp4`);
      try {
        const dl = await axios.get(sh.url, { responseType: 'arraybuffer', timeout: 90000 });
        fs.writeFileSync(srcPath, Buffer.from(dl.data));
      } catch (e) {
        console.warn(`[reel:${token}] shot ${i + 1} download failed: ${e.message}`);
        continue;
      }
      const pad = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      try {
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
          cmd.outputOptions(['-r 24', '-c:v libx264', '-preset veryfast', '-pix_fmt yuv420p', '-an', '-threads 1'])
             .output(outPath).on('end', resolve).on('error', reject).run();
        });
        if (fs.existsSync(outPath)) normPaths.push(outPath);
      } catch (e) {
        console.warn(`[reel:${token}] shot ${i + 1} normalise failed: ${e.message}`);
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
        const pad = delay + (Number(picSecs) > 0 ? `apad=whole_dur=${Number(picSecs).toFixed(3)}` : 'apad=whole_dur=600');
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
    res.json({ success: true, videoUrl: publicUrl, token, shotCount: normPaths.length,
               requested: shots.length, seconds, width: outW, height: outH, hasAudio: !!audioUrl,
               audioDelaySec });
  } catch (err) {
    console.error(`[reel:${token}] error:`, err.message);
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
      execSync(`yt-dlp -f "best[ext=mp4]/best" -o "${inputPath}" "${videoUrl}"`, { stdio: 'pipe', timeout: 180000 });
    } else {
      const dl = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000, maxContentLength: 300 * 1024 * 1024 });
      fs.writeFileSync(inputPath, Buffer.from(dl.data));
    }
    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size < 1000) {
      return res.status(400).json({ success: false, error: 'Could not download that video — the post may be private, or the link may have expired.' });
    }

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(['-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', '-t', String(maxSeconds)])
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
  const { videoUrl, count, seed, intensity, metadata, flip } = req.body || {};
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });
  const n = Math.max(1, Math.min(VARIANT_MAX, parseInt(count, 10) || 3));
  const runSeed = String(seed || Date.now());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'variants-'));
  const inputPath = path.join(tmpDir, 'input.mp4');

  // Optional device stamp per variant, reusing the stamp whitelist so a
  // re-served file also carries fresh capture metadata.
  // Collected as PAIRS, applied via varargs below — never as array elements.
  // See the note in /api/stamp-video: fluent-ffmpeg splits a two-token array
  // element into option+value, which corrupts values like "iPhone 14".
  const metaPairs = [];
  if (metadata && typeof metadata === 'object') {
    for (const key of STAMP_KEYS) {
      const val = sanitiseMetaValue(metadata[key]);
      if (val !== null) metaPairs.push([key, val]);
    }
  }
  const metaArgs = metaPairs.length ? ['-movflags', 'use_metadata_tags'] : [];

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
            ...metaArgs,
          ]);
        for (const [k, val] of metaPairs) cmd.outputOptions('-metadata', `${k}=${val}`);
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
