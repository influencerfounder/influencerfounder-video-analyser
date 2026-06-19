FROM node:22-slim

# System deps: ffmpeg, curl, python3, opencv runtime libs
RUN apt-get update && apt-get install -y \
    ffmpeg curl \
    python3 python3-pip python3-venv python3-dev \
    libglib2.0-0 libsm6 libxext6 libxrender1 libgl1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Python venv for InsightFace (avoids Debian externally-managed-environment block)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --upgrade pip && \
    pip install insightface==0.7.3 onnxruntime==1.16.3 opencv-python-headless numpy

# Pre-download InsightFace detection model (buffalo_l) and inswapper at build time
# so the first real request isn't slow. || true = don't fail build if CDN is down.
RUN python3 -c "\
import insightface; \
from insightface.app import FaceAnalysis; \
app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider']); \
app.prepare(ctx_id=0); \
insightface.model_zoo.get_model('inswapper_128.onnx', download=True, download_zip=True)" || true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
