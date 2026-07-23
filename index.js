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
    throw new Error('Could not find this Instagram post — it may be private, deleted, or the link is invalid.');
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
// Full deconstruction: virality scorecard, hook, blueprint, Wan 2.6 prompt
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
    const { videoUrl, locationId, kieApiKey } = req.body;
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
        return res.status(400).json({ success: false, error: e.message });
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
      ? `These ${frameBase64s.length} frames were extracted from the viral video. Transcript: "${transcript}"\n\nCreate the Wan 2.6 prompt.`
      : `These ${frameBase64s.length} frames were extracted from the viral video (no audio). Create the Wan 2.6 prompt.`;

    const systemPrompt = `You are a Seedance 2.0 prompt engineer. Study the frames and transcript carefully and follow these four steps exactly.

STEP 1 — CLASSIFY THE SOURCE as exactly one of TWO lanes:
- AUTHENTIC: phone-shot / creator-made — handheld or propped phone, casual real-world setting, available or simple lighting, unpolished. The huge majority of viral short-form lives here.
- HIGH-END: professionally produced — cinema or commercial camera work, deliberate composition, controlled lighting, graded color.

This classification is INTERNAL — it only decides which realism layer Step 3 appends. Never print a lane name anywhere in the output. When genuinely torn, choose AUTHENTIC — polished-looking creator content is still phone-made far more often than it looks.

STEP 2 — BUILD THE BASE PROMPT using this structure: Shot scaffold + Subject + Action + Environment + Camera + Lighting + Style. Rules:
- Open with a short capture-style scaffold as the very first clause — plain language matching the Step 1 lane, but never the lane word itself and never aspect ratio or duration (the tool sets 9:16 and clip length separately). E.g. "Handheld phone selfie capture:" or "Cinema camera capture:". Never bury this mid-prompt
- Use [INFLUENCER] as the person placeholder — do NOT describe physical appearance (no hair color, eye color, skin tone, height, build — reference photos handle that)
- Describe outfit, action, environment, mood, shot progression
- Use ONE camera movement only — never combine (e.g. "slow dolly in" OR "static locked shot" — never "dolly in while panning left")
- Name specific lighting direction and quality, and make it slightly imperfect — real light is uneven ("warm window light from the left, slightly hot on one cheek, soft shadow falloff to the right" beats "natural lighting")
- Ground the scene in a lived-in world: one or two ordinary specific details (a half-empty glass on the counter, a jacket over the chair, a slightly crooked picture frame) beat a clean empty backdrop — real rooms are never perfectly tidy or symmetric
- If any beat shows hands touching an object (phone, cup, product, fabric), anchor the hand explicitly to it (e.g. "fingers grip the phone case") — free-floating hand descriptions are the most common cause of hand artifacts
- Use timestamp beats for shot progression: [0-2s]: opening beat. [2-5s]: main action. Keep each beat to 1-2 sentences. Weave natural involuntary human motion through the beats: a soft slightly-uneven blink (never metronomic), a visible breath with gentle shoulder rise, a glance at something specific then back (gaze always has a destination — a locked dead-center stare renders as frozen and glassy), a small weight shift or self-adjustment (brushing a strand of hair back, tugging a sleeve). Different body parts move on slightly different timing — overlapping, never synchronized
- If the person walks in any beat, describe real gait mechanics: heel-to-toe footsteps with weight shifting onto each leg, arms swinging opposite the legs, head staying level — never a gliding or floating walk
- Target 60-100 words total for the base prompt. Never exceed 150 words — Seedance ignores details beyond that.

STEP 3 — APPEND the matching realism layer (one block, added verbatim after the base prompt):

IF AUTHENTIC: "Filmed on a smartphone: handheld with real hand tremor and small framing corrections, slightly off-center imperfect framing, mild lens softness, faint digital sensor noise and mild compression artifacts, small exposure shifts as the camera auto-adjusts, mixed uneven ambient lighting with natural shadow falloff, authentic skin with visible pores, tiny blemishes and subtle under-eye shadows — no smoothing, no beauty filter — a few stray hair flyaways, natural facial asymmetry, ordinary lived-in surroundings, the unedited spontaneous look of a real social media snapshot, 30fps."

IF HIGH-END: "Shot on a professional cinema camera with real glass character: subtle lens vignetting, gentle highlight halation, fine organic film grain, one smooth deliberate camera movement, precisely controlled lighting that still behaves physically with soft natural falloff and true shadows, photorealistic skin keeping pores and micro-texture under the key light, restrained filmic color grade — rich but never over-processed — performers moving with natural weight and breath, never posed stillness, 24fps."

STEP 4 — APPEND this suffix at the very end of every prompt regardless of lane:
"No warping or morphing, no extra fingers, no bent limbs, no flickering, no ghosting, avoid plastic over-smooth skin and artificial symmetry. No music — natural ambient background sound only."

(Note: never demand "sharp clarity" or "stable picture" — those instructions cancel the handheld and lens-character realism above and push the output back toward the sterile AI look.)

Return ONLY the final combined prompt text. No JSON, no explanation, no lane label.`;

    // Kie.ai's Claude endpoint is native Anthropic Messages format (verified
    // 2026-07-17 with real base64 frames — identical request shape, model
    // string and auth header are the only differences), so the same
    // system/messages body serves both branches.
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
        model: 'claude-sonnet-5', max_tokens: 1000, system: systemPrompt,
        messages: [{ role: 'user', content: [...subset, { type: 'text', text: userText + note }] }]
      }, { headers: { 'Authorization': `Bearer ${kieApiKey}`, 'Content-Type': 'application/json' }, timeout: 80000 });
    } else {
      claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6', max_tokens: 1000, system: systemPrompt,
        messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: userText }] }]
      }, { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    }

    const clonePrompt = claudeResponse.data?.content?.[0]?.text?.trim() || '';
    if (!clonePrompt) return res.status(500).json({ success: false, error: 'Empty response from Claude' });

    res.json({
      success: true,
      frames: frameDataUrls,
      frameTimestamps,
      hookFrames,
      durationSec: Math.round(duration * 10) / 10,
      firstFrameUrl: firstFrameUrl || frameDataUrls[0] || '',
      transcript,
      transcriptError: transcriptError || undefined,
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
    res.json({ success: true, videoUrl: publicUrl, token });
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

app.post('/api/burn-captions', async (req, res) => {
  const { videoUrl, scriptText } = req.body;
  if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return res.status(500).json({ success: false, error: 'OPENAI_API_KEY not configured' });

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
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    if (scriptText) form.append('prompt', String(scriptText).slice(0, 500));

    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
      timeout: 60000
    });

    const words = whisperRes.data?.words || [];
    if (!words.length) throw new Error('Whisper returned no word-level timestamps — cannot build captions');

    const chunks = groupWordsIntoChunks(words, 3);

    // 4. Build one drawtext filter per chunk, each only visible during its
    // own time window — centered, bold white, dark outline (Instagram's
    // basic auto-caption look). Static per-chunk display, no karaoke animation.
    const fontSize = Math.round(height * 0.07);
    const filters = chunks.map(c =>
      `drawtext=fontfile='${CAPTION_FONT_PATH}':text='${escapeDrawtext(c.text)}':fontsize=${fontSize}:fontcolor=white:borderw=${Math.round(fontSize * 0.12)}:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${c.start},${c.end})'`
    );

    if (!filters.length) throw new Error('No caption chunks generated');

    // 5. Burn the captions onto the video
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions(['-vf', filters.join(','), '-c:a', 'copy'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
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
  const { videoUrls } = req.body;
  if (!Array.isArray(videoUrls) || videoUrls.length < 2) {
    return res.status(400).json({ success: false, error: 'Need at least 2 video URLs to stitch' });
  }
  const urls = videoUrls.filter(u => typeof u === 'string' && u.trim()).slice(0, 6); // cap at 6 (~90s)
  if (urls.length < 2) return res.status(400).json({ success: false, error: 'Need at least 2 valid video URLs' });

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
          .videoFilters('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1')
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
    console.log(`[stitch:${token}] stitched ${normPaths.length} clips`);
    res.json({ success: true, videoUrl: publicUrl, token, clipCount: normPaths.length });
  } catch (err) {
    console.error(`[stitch:${token}] error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
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
