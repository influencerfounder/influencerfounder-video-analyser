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
    const { videoUrl, locationId } = req.body;
    if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });

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
    const ANALYSIS_FRAME_COUNT =
      duration <= 30  ? Math.max(12, Math.round(duration)) :
      duration <= 60  ? 40 :
      duration <= 180 ? 60 :
      80;
    const fps = Math.min(2.0, ANALYSIS_FRAME_COUNT / Math.max(duration, 0.1));

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
          const whisperRes = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() },
            timeout: 60000
          });
          transcript = whisperRes.data?.text || '';
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

    const claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `You are a Seedance 2.0 prompt engineer. Study the frames and transcript carefully and follow these four steps exactly.

STEP 1 — CLASSIFY PRODUCTION STYLE as exactly one of:
- UGC: handheld selfie/front-camera, casual setting, natural/indoor light, unposed, phone-quality
- SEMIPRO: dedicated camera or gimbal, deliberate framing, mix of natural and controlled lighting
- CINEMATIC: professional camera, intentional composition, controlled/dramatic lighting, high production value

This classification is INTERNAL — it only decides which realism layer to append in Step 3. Never print the label word (UGC / SEMIPRO / CINEMATIC) anywhere in the output. When genuinely torn between UGC and SEMIPRO, default to UGC — most viral short-form is phone-shot.

STEP 2 — BUILD THE BASE PROMPT using this structure: Shot scaffold + Subject + Action + Environment + Camera + Lighting + Style. Rules:
- Open with a short capture-style scaffold as the very first clause — a plain-language phrase describing the shooting style from Step 1, but do NOT write the label word itself and do NOT include aspect ratio or duration (the tool sets 9:16 and the clip length separately, so baking them into the text is redundant and can conflict). E.g. "Handheld selfie capture:" or "Gimbal-stabilized broadcast capture:" — never "Vertical 9:16, 8s, SEMIPRO ...". Never bury this mid-prompt
- Use [INFLUENCER] as the person placeholder — do NOT describe physical appearance (no hair color, eye color, skin tone, height, build — reference photos handle that)
- Describe outfit, action, environment, mood, shot progression
- Use ONE camera movement only — never combine (e.g. "slow dolly in" OR "static locked shot" — never "dolly in while panning left")
- Name specific lighting direction and quality (e.g. "soft key light 45° camera left, warm fill from right window" not just "natural lighting")
- If any beat shows hands touching an object (phone, cup, product, fabric), anchor the hand explicitly to it (e.g. "fingers grip the phone case") — free-floating hand descriptions are the most common cause of hand artifacts
- Use timestamp beats for shot progression: [0-2s]: opening beat. [2-5s]: main action. Keep each beat to 1-2 sentences. In at least one beat, include a natural involuntary micro-movement (a blink, a breath, a glance-and-return, a small weight shift) — without this, close-up/selfie-style beats render as a frozen, glassy stare
- Target 60-100 words total for the base prompt. Never exceed 150 words — Seedance ignores details beyond that.

STEP 3 — APPEND the matching realism layer (one sentence block, added after the base prompt):

IF UGC: "Shot on smartphone front camera, handheld with subtle natural hand tremor, slight autofocus breathing, imperfect slightly off-center framing, visible pores and natural skin micro-imperfections, no smoothing or beauty filter, natural ambient indoor lighting with mixed warm and cool sources, slight overhead shadow under nose and chin, natural blinking rhythm and subtle breathing motion in chest and shoulders, mild compression feel, 30fps."

IF SEMIPRO: "Shot on DSLR or mirrorless, lightly stabilized handheld or gimbal, natural skin texture with realistic pores, gentle background separation with realistic depth of field, controlled non-dramatic lighting, natural posture and motion, slight film grain, 24fps."

IF CINEMATIC: "Shot on professional cinema camera, smooth deliberate single camera movement, sharp cinematic focus with intentional background bokeh, precisely controlled dramatic lighting, photorealistic skin detail with natural texture, rich but not over-processed color, intentional composed motion, 24fps."

STEP 4 — APPEND this quality suffix at the very end of every prompt regardless of style:
"Sharp clarity, natural colors, stable picture, no blur, no ghosting, no flickering, no jitter, avoid bent limbs. No music — natural ambient background sound only."

Return ONLY the final combined prompt text. No JSON, no explanation, no style label.`,
      messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: userText }] }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

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
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
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
// START
// ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`InfluencerFounder Video Analyser running on port ${PORT}`);
});

module.exports = app;
