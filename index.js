const express = require('express');
const axios = require('axios');

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
  res.json({ status: 'ok', service: 'InfluencerFounder Video Analyser', version: '2.0.1', timestamp: new Date().toISOString() });
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
// Analyses a video URL and returns a Wan 2.6 clone prompt
// ─────────────────────────────────────────

app.post('/api/clone', async (req, res) => {
  try {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ success: false, error: 'Missing videoUrl' });

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });

    const systemPrompt = `You are an expert AI video director specialising in replicating viral short-form videos with AI-generated influencer characters.
Analyse a viral video and produce a single detailed Wan 2.6 text-to-video prompt that clones the exact visual style, scene, camera work, lighting, and energy — with [INFLUENCER] as the subject.
Always respond with valid JSON only. No markdown, no explanation outside the JSON.`;

    const userPrompt = `Analyse this viral video URL and clone it: ${videoUrl}

Return a JSON object with exactly these fields:
{
  "transcript": "verbatim transcript if speech present, otherwise describe the visual narrative beat by beat",
  "metadata": {
    "duration": "estimated duration as a string e.g. '15s'",
    "frameCount": 0,
    "hasAudio": true
  },
  "scene_analysis": {
    "setting": "precise environment — indoors/outdoors, location type, background details",
    "lighting": "lighting type, direction, quality, colour temperature",
    "camera": "shot type, angle, movement, framing",
    "subject_action": "what the subject is doing — movement, gestures, energy level",
    "colour_grade": "colour palette and mood",
    "editing_style": "pacing — fast cuts/slow/single take, notable transitions"
  },
  "clone_prompt": "A single complete ready-to-use Wan 2.6 video generation prompt that clones every visual element of the original — setting, lighting, camera angle and movement, colour grade, energy — but replaces the original subject with [INFLUENCER]. Must be detailed enough to generate immediately. Use present tense. Start with the shot type and camera movement."
}`;

    const claudeResponse = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

    const rawText = claudeResponse.data?.content?.[0]?.text || '';
    if (!rawText) return res.status(500).json({ success: false, error: 'Empty response from Claude' });

    let parsed;
    try {
      let jsonStr = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const m = jsonStr.match(/\{[\s\S]*\}/);
      if (m) jsonStr = m[0];
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({ success: false, error: 'Failed to parse response: ' + e.message });
    }

    res.json({
      success: true,
      frames: [],
      transcript: parsed.transcript || '',
      metadata: parsed.metadata || { duration: '~15s', frameCount: 0, hasAudio: false },
      clonePrompt: parsed.clone_prompt || ''
    });

  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`InfluencerFounder Video Analyser running on port ${PORT}`);
});

module.exports = app;
