# InfluencerFounder Video Analyser

Railway server for viral video deconstruction.

## What it does
1. Downloads a video from a public URL
2. Extracts frames using ffmpeg
3. Transcribes audio using Whisper via Kie.ai
4. Sends frames + transcript to Claude for full viral analysis
5. Returns analysis + frame previews

## Deploy to Railway
1. Push this folder to a GitHub repo
2. Connect repo to Railway
3. Add environment variables (see .env.example)
4. Railway auto-deploys with ffmpeg via nixpacks.toml

## Environment Variables
- `ANTHROPIC_API_KEY` — your Anthropic API key
- `KIE_API_KEY` — your Kie.ai API key (for Whisper transcription)
- `PORT` — auto-set by Railway

## Endpoints
- `GET /` — health check
- `POST /api/analyse` — analyse a video
  - Body: `{ "videoUrl": "https://..." }`
  - Returns: `{ success, analysis, metadata, frames, transcript }`
