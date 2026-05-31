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
    const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 200 * 1024 * 1024 });
    fs.writeFileSync(videoPath, Buffer.from(videoRes.data));

    // 2. Probe duration
    const duration = await new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, meta) => resolve(err ? 15 : (meta?.format?.duration || 15)));
    });

    // 3. Extract 6 frames evenly distributed
    const framesDir = path.join(tmpDir, 'frames');
    fs.mkdirSync(framesDir);
    const timestamps = Array.from({ length: 6 }, (_, i) => Math.max(0.1, (duration / 7) * (i + 1)));

    await Promise.all(timestamps.map((ts, i) =>
      new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(ts)
          .outputOptions(['-vframes 1', '-q:v 3'])
          .output(path.join(framesDir, `frame-${i}.jpg`))
          .on('end', resolve)
          .on('error', reject)
          .run();
      })
    ));

    const frameFiles = fs.readdirSync(framesDir).sort();
    const frameDataUrls = frameFiles.map(f => {
      const b64 = fs.readFileSync(path.join(framesDir, f)).toString('base64');
      return `data:image/jpeg;base64,${b64}`;
    });
    const frameBase64s = frameFiles.map(f => fs.readFileSync(path.join(framesDir, f)).toString('base64'));

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
      system: 'You are a video director. Study these frames and transcript carefully and create a Wan 2.6 prompt that recreates this EXACT video 1:1 — same scene, camera angle, lighting, composition, energy, movement, clothing style. Replace the original creator with [INFLUENCER]. Return only the Wan 2.6 prompt text, no JSON, no explanation.',
      messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: userText }] }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

    const clonePrompt = claudeResponse.data?.content?.[0]?.text?.trim() || '';
    if (!clonePrompt) return res.status(500).json({ success: false, error: 'Empty response from Claude' });

    res.json({
      success: true,
      frames: frameDataUrls,
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
