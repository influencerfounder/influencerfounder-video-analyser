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
      system: `You are a video director and Seedance 2.0 prompt engineer. Study the frames and transcript carefully and follow these three steps:

STEP 1 — ASSESS PRODUCTION STYLE. Classify the video as exactly one of:
- UGC: handheld selfie or front-camera footage, casual setting, natural/indoor light, unposed, phone-quality image quality
- SEMIPRO: dedicated camera or stabilized shot, some deliberate framing, mix of natural and controlled lighting, more polished than a selfie but not a full production
- CINEMATIC: professional camera, intentional composition, dramatically controlled or high-end lighting, high production value, studio or curated location

STEP 2 — BUILD THE BASE PROMPT. Describe what recreates this video 1:1: scene, setting, camera angle and movement, lighting, composition, energy, what [INFLUENCER] is wearing, what they are doing, shot progression, mood. Use [INFLUENCER] as the person placeholder. Do NOT describe physical appearance (no hair color, eye color, skin tone, height, build — reference photos handle that). Be specific and concise.

STEP 3 — APPEND THE MATCHING REALISM LAYER. Add ONLY the layer matching your Step 1 classification to the end of the prompt:

IF UGC: "Shot on smartphone front camera, handheld with subtle constant camera shake from natural hand tremor, slight autofocus breathing, imperfect slightly off-center framing, authentic skin texture with visible pores and natural micro-imperfections, no smoothing or beauty filter, natural indoor ambient lighting with mixed warm and cool sources, slight harsh shadow under nose and chin, natural blinking rhythm and subtle breathing motion visible in chest and shoulders, mild low-bitrate compression feel, 30fps smartphone footage."

IF SEMIPRO: "Shot on DSLR or mirrorless camera, lightly stabilized handheld or gimbal, natural skin texture with realistic pores and subtle imperfections, gentle background separation with realistic depth of field, controlled but non-dramatic lighting, natural posture and motion, slight film grain, 24fps."

IF CINEMATIC: "Shot on professional cinema camera, smooth deliberate camera movement, sharp cinematic focus with intentional bokeh on background, precisely controlled dramatic lighting, photorealistic skin detail with natural texture, rich but not over-processed color, intentional composed motion, 24fps cinematic frame rate."

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
// START
// ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`InfluencerFounder Video Analyser running on port ${PORT}`);
});

module.exports = app;
