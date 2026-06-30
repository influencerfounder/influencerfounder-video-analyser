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
// yt-dlp cookie auth — Instagram increasingly returns "empty media response"
// for unauthenticated scrapes, even on public posts, and tells you to pass
// cookies. INSTAGRAM_COOKIES_B64 is a base64-encoded Netscape-format
// cookies.txt exported from a logged-in browser session. Written to a temp
// file once and reused — yt-dlp needs a real file path, not stdin.
// ─────────────────────────────────────────
let _cookiesFilePath = null;
function getCookieArgs() {
  if (_cookiesFilePath) return ['--cookies', _cookiesFilePath];
  const b64 = process.env.INSTAGRAM_COOKIES_B64;
  if (!b64) return [];
  try {
    const txt = Buffer.from(b64, 'base64').toString('utf8');
    const filePath = path.join(os.tmpdir(), 'instagram_cookies.txt');
    fs.writeFileSync(filePath, txt);
    _cookiesFilePath = filePath;
    return ['--cookies', filePath];
  } catch (e) {
    console.error('[yt-dlp] Failed to write cookies file from INSTAGRAM_COOKIES_B64:', e.message);
    return [];
  }
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

async function handleViralAnalyse(req, res) {
  try {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });

    const systemPrompt = `You are an expert viral content analyst and AI influencer video strategist.
Your job is to deconstruct viral social media videos and produce actionable recreation blueprints.
Always respond in valid JSON format only. No markdown, no explanation outside the JSON.`;

    const userPrompt = `Analyse this viral video: ${videoUrl}

Return a JSON object with exactly these fields:
{
  "metadata": { "duration": "estimated duration", "format": "9:16 or 16:9", "platform": "TikTok/Instagram/YouTube", "content_type": "talking head/lifestyle/walk/tutorial/etc" },
  "virality_scorecard": {
    "curiosity": { "score": 0-10, "reason": "why" },
    "novelty": { "score": 0-10, "reason": "why" },
    "emotional_trigger": { "score": 0-10, "emotion": "what emotion", "reason": "why" },
    "relatability": { "score": 0-10, "reason": "why" },
    "visual_interest": { "score": 0-10, "reason": "why" },
    "shareability": { "score": 0-10, "reason": "why" },
    "rewatch_potential": { "score": 0-10, "reason": "why" },
    "overall_score": 0-10,
    "verdict": "one line verdict"
  },
  "hook_analysis": { "type": "hook type", "formula": "hook formula", "first_3_seconds": "what happens", "why_it_works": "psychological reason" },
  "retention_analysis": { "first_retention_spike": "timestamp", "pattern_interrupts": ["list"], "curiosity_loops": ["list"], "payoff_timing": "when", "completion_driver": "why" },
  "story_framework": { "structure": "structure type", "core_idea": "one sentence", "unique_angle": "what makes it different", "viewer_transformation": "before/after" },
  "script_transcription": "full verbatim transcript with timestamps",
  "content_identity": { "creator_archetype": "archetype", "energy_level": 0-10, "tone": "tone", "editing_style": "style", "delivery_style": "style" },
  "hook_variations": [
    {"type": "curiosity gap", "hook": "variation"},
    {"type": "social proof", "hook": "variation"},
    {"type": "problem solution", "hook": "variation"},
    {"type": "contrarian", "hook": "variation"},
    {"type": "identity shift", "hook": "variation"},
    {"type": "transformation", "hook": "variation"},
    {"type": "urgency", "hook": "variation"},
    {"type": "simplicity", "hook": "variation"},
    {"type": "time specific", "hook": "variation"},
    {"type": "future pacing", "hook": "variation"}
  ],
  "recreation_blueprint": {
    "concept": "what to recreate and why it works",
    "script": "full adapted script for make money online / AI influencer niche. Replace [INFLUENCER] where the character speaks or appears.",
    "shot_list": [{"scene": 1, "duration": "Xs", "shot_type": "close-up/mid/full body", "angle": "eye level/above/below", "movement": "static/handheld/push-in", "description": "what happens"}],
    "setting": "environment description for Wan 2.6",
    "lighting": "lighting description for Wan 2.6",
    "camera": "camera movement and framing for Wan 2.6",
    "editing_rhythm": "cut timing and pacing notes",
    "audio": "music mood and sound design notes",
    "wan_prompt": "Complete ready-to-use Wan 2.6 prompt. Use [INFLUENCER] as placeholder."
  }
}`;

    const claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

    const rawText = claudeResponse.data?.content?.[0]?.text || '';
    if (!rawText) return res.status(500).json({ success: false, error: 'Empty response from Claude' });

    let analysis;
    try {
      let jsonStr = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const m = jsonStr.match(/\{[\s\S]*\}/);
      if (m) jsonStr = m[0];
      analysis = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({ success: false, error: 'Failed to parse analysis: ' + e.message, raw: rawText.substring(0, 2000) });
    }

    res.json({ success: true, analysis });

  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
}

app.post('/api/viral/analyse', handleViralAnalyse);
app.post('/api/analyse', handleViralAnalyse);

// ─────────────────────────────────────────
// CLONE — Copy Viral Video tab
// Downloads video → extracts frames → transcribes audio → Claude vision
// ─────────────────────────────────────────

app.post('/api/clone', async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));

  try {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });

    // 1. Download video
    const videoPath = path.join(tmpDir, 'video.mp4');

    const isPermalink = /instagram\.com\/(p|reel|reels)\/|tiktok\.com\/@[^/]+\/video\/|tiktok\.com\/t\//.test(videoUrl);

    if (isPermalink) {
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
          ...getCookieArgs(),
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

    // 3b. Extract the TRUE opening frame (t≈0) separately — sequential, same low-mem options
    let firstFrameUrl = '';
    try {
      const firstFramePath = path.join(framesDir, 'frame-opening.jpg');
      await extractFrame(0.1, firstFramePath);
      const openingB64 = fs.readFileSync(firstFramePath).toString('base64');
      firstFrameUrl = `data:image/jpeg;base64,${openingB64}`;
    } catch (_) { /* fall back to frames[0] on the client if this fails */ }

    // 4. Transcribe audio with Whisper (skip gracefully if no key)
    let transcript = '';
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (OPENAI_API_KEY) {
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
          form.append('model', 'whisper-1');
          const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
            timeout: 60000
          });
          transcript = whisperRes.data?.text || '';
        }
      } catch (_) { /* transcription optional */ }
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

STEP 2 — BUILD THE BASE PROMPT using this structure: Shot scaffold + Subject + Action + Environment + Camera + Lighting + Style. Rules:
- Open with the shot scaffold as the very first clause: aspect ratio (9:16 vertical), total duration, and the production style classified in Step 1 (e.g. "Vertical 9:16, 8s, UGC handheld selfie capture:") — never bury this mid-prompt
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
"Sharp clarity, natural colors, stable picture, no blur, no ghosting, no flickering, no jitter, avoid bent limbs."

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
      firstFrameUrl: firstFrameUrl || frameDataUrls[0] || '',
      transcript,
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
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    // Find yt-dlp binary
    let ytDlpPath;
    try { ytDlpPath = (await execFileAsync('which', ['yt-dlp'])).stdout.trim(); } catch (_) { ytDlpPath = '/usr/local/bin/yt-dlp'; }

    console.log(`[tempvid:${token}] downloading: ${videoUrl.slice(0, 60)}`);
    await execFileAsync(ytDlpPath, [
      '--no-playlist', '-f', 'mp4/best[height<=720]', '--merge-output-format', 'mp4',
      ...getCookieArgs(),
      '-o', outputPath, videoUrl,
    ], { timeout: 120000 });

    if (!fs.existsSync(outputPath)) throw new Error('yt-dlp download produced no output file');
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
