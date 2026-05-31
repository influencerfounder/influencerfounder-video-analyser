const express = require('express');
const cors = require('cors');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'InfluencerFounder Video Analyser',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────
// ANALYSE VIDEO
// Downloads video, extracts frames + audio,
// transcribes with Whisper, analyses with Claude
// ─────────────────────────────────────────
app.post('/api/analyse', async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ success: false, error: 'Missing videoUrl' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const KIE_API_KEY = process.env.KIE_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Create temp directory for this job
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-'));
  const videoPath = path.join(tmpDir, 'video.mp4');
  const audioPath = path.join(tmpDir, 'audio.mp3');
  const framesDir = path.join(tmpDir, 'frames');
  fs.mkdirSync(framesDir);

  try {
    // ─── STEP 1: Download video ───────────────────────────────────────────
    console.log('Downloading video:', videoUrl);
    const videoRes = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: 200 * 1024 * 1024
    });
    fs.writeFileSync(videoPath, Buffer.from(videoRes.data));
    console.log('Video downloaded:', Math.round(fs.statSync(videoPath).size / 1024), 'KB');

    // ─── STEP 2: Get video metadata ───────────────────────────────────────
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
    const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
    const duration = Math.round(metadata.format.duration || 0);
    const hasAudio = !!audioStream;

    console.log(`Duration: ${duration}s, Has audio: ${hasAudio}`);

    // ─── STEP 3: Extract frames (1 per 2 seconds, max 12 frames) ──────────
    const frameRate = duration > 20 ? '0.5' : '1';
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions([`-vf fps=${frameRate},scale=720:-1`, '-q:v 3'])
        .output(path.join(framesDir, 'frame_%03d.jpg'))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .slice(0, 12); // max 12 frames

    console.log(`Extracted ${frameFiles.length} frames`);

    // Convert frames to base64
    const frames = frameFiles.map(f => ({
      name: f,
      data: fs.readFileSync(path.join(framesDir, f)).toString('base64')
    }));

    // ─── STEP 4: Extract + transcribe audio ───────────────────────────────
    let transcript = '';
    if (hasAudio && KIE_API_KEY) {
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .outputOptions(['-vn', '-acodec libmp3lame', '-ar 16000', '-ac 1', '-q:a 5'])
            .output(audioPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        // Transcribe with Kie.ai Whisper
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', fs.createReadStream(audioPath), {
          filename: 'audio.mp3',
          contentType: 'audio/mp3'
        });
        form.append('model', 'whisper-1');
        form.append('response_format', 'verbose_json');

        const whisperRes = await axios.post('https://api.kie.ai/api/v1/audio/transcriptions', form, {
          headers: {
            'Authorization': `Bearer ${KIE_API_KEY}`,
            ...form.getHeaders()
          },
          timeout: 60000
        });

        transcript = whisperRes.data?.text || whisperRes.data?.transcription || '';
        console.log('Transcript length:', transcript.length);
      } catch (e) {
        console.log('Transcription failed (continuing without):', e.message);
        transcript = '[Audio transcription unavailable]';
      }
    } else if (!hasAudio) {
      transcript = '[Silent video — no audio track]';
    }

    // ─── STEP 5: Send to Claude for analysis ─────────────────────────────
    console.log('Sending to Claude for analysis...');

    const systemPrompt = `You are an expert viral content analyst and AI influencer video strategist.
Your job is to deconstruct viral social media videos and produce actionable recreation blueprints.
You will be given video frames as images and an audio transcript.
Always respond in valid JSON format only. No markdown code fences, no explanation outside the JSON.`;

    // Build message content with frames
    const imageContent = frames.map(f => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: f.data
      }
    }));

    const userContent = [
      ...imageContent,
      {
        type: 'text',
        text: `Video metadata: ${duration} seconds, ${videoStream?.width}x${videoStream?.height}, ${hasAudio ? 'has audio' : 'silent'}.

Audio transcript: ${transcript || 'No transcript available'}

Analyse this viral video from the ${frameFiles.length} frames above and the transcript. Return a JSON object with exactly these fields:

{
  "metadata": {
    "duration": "${duration} seconds",
    "format": "9:16 or 16:9",
    "platform": "TikTok/Instagram/YouTube",
    "content_type": "talking head/lifestyle/walk/tutorial/etc"
  },
  "virality_scorecard": {
    "curiosity": { "score": 1-10, "reason": "why" },
    "novelty": { "score": 1-10, "reason": "why" },
    "emotional_trigger": { "score": 1-10, "emotion": "what emotion", "reason": "why" },
    "relatability": { "score": 1-10, "reason": "why" },
    "visual_interest": { "score": 1-10, "reason": "why" },
    "shareability": { "score": 1-10, "reason": "why" },
    "rewatch_potential": { "score": 1-10, "reason": "why" },
    "overall_score": 1-10,
    "verdict": "one line verdict"
  },
  "hook_analysis": {
    "type": "open loop/curiosity gap/pattern interrupt/visual surprise/emotional trigger/relatability/contrarian/story setup/fast payoff/social proof",
    "formula": "the hook formula in plain language",
    "first_3_seconds": "describe exactly what happens in the opening frames",
    "why_it_works": "the psychological reason"
  },
  "retention_analysis": {
    "first_retention_spike": "timestamp and what caused it",
    "pattern_interrupts": ["list each one with timestamp"],
    "curiosity_loops": ["list open loops and when they close"],
    "payoff_timing": "when the viewer gets their reward",
    "completion_driver": "why they watched to the end"
  },
  "story_framework": {
    "structure": "Problem-Solution/Before-After/Contrarian/Listicle/Day-in-life/Tutorial/Confession/Reaction/Proof Stack",
    "core_idea": "one sentence",
    "unique_angle": "what makes this take different",
    "viewer_transformation": "what viewer thinks/feels after watching"
  },
  "script_transcription": "full verbatim transcript with timestamps. If silent video describe visual narrative beat by beat.",
  "content_identity": {
    "creator_archetype": "expert/peer/entertainer/storyteller/challenger/insider",
    "energy_level": 1-10,
    "tone": "conversational/authoritative/vulnerable/humorous/deadpan/urgent",
    "editing_style": "fast cuts/static/handheld/jump cuts/smooth/raw",
    "delivery_style": "direct to camera/voiceover/silent/narrated/reaction"
  },
  "hook_variations": [
    {"type": "curiosity gap", "hook": "variation adapted for make money online / AI influencer niche"},
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
    "concept": "one paragraph — what to recreate and why it works",
    "script": "full adapted script for make money online / AI influencer niche. Use [INFLUENCER] where the character speaks or appears.",
    "shot_list": [
      {"scene": 1, "duration": "Xs", "shot_type": "close-up/mid/full body", "angle": "eye level/above/below", "movement": "static/handheld/push-in", "description": "what happens"}
    ],
    "setting": "detailed environment description for Wan 2.6",
    "lighting": "lighting description for Wan 2.6",
    "camera": "camera movement and framing for Wan 2.6",
    "editing_rhythm": "cut timing and pacing notes",
    "audio": "music mood and sound design notes",
    "wan_prompt": "Complete ready-to-use Wan 2.6 generation prompt. Use [INFLUENCER] as the character placeholder. Be very specific about setting, lighting, camera, action, mood."
  }
}`
      }
    ];

    const claudeRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });

    const rawText = claudeRes.data?.content?.[0]?.text || '';
    if (!rawText) throw new Error('Empty response from Claude');

    // Parse JSON — strip markdown fences if present
    let analysis;
    try {
      let jsonStr = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/s);
      if (jsonMatch) jsonStr = jsonMatch[0];
      analysis = JSON.parse(jsonStr);
    } catch(e) {
      throw new Error('Failed to parse Claude response: ' + e.message + ' | Raw: ' + rawText.substring(0, 500));
    }

    // Return analysis + frame previews for the UI info panel
    const frameB64Previews = frames.slice(0, 6).map(f => 'data:image/jpeg;base64,' + f.data);

    console.log('Analysis complete');
    res.json({
      success: true,
      analysis,
      metadata: {
        duration,
        hasAudio,
        frameCount: frames.length,
        transcriptLength: transcript.length
      },
      frames: frameB64Previews,
      transcript
    });

  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
  }
});

app.listen(PORT, () => {
  console.log(`InfluencerFounder Video Analyser running on port ${PORT}`);
});
