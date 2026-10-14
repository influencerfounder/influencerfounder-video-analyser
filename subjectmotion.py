#!/usr/bin/env python3
"""subjectmotion.py — how much the PEOPLE move, every 0.1 s, with the camera's own move removed.

Why (2026-10-14): the focus blur goes in a calm stretch, never on the action (focusblur.js). Plain
frame difference measured the wrong thing — on the angry-grandmother take the handheld sway of the
filming car dominated and the outburst (small in frame) read as "calm", so the blur landed on her
finger-jabbing. Same method as hookmotion.py: dense optical flow 0.1 s apart at 360x640 grey, the
camera fitted as one similarity transform (RANSAC) and subtracted; the residual is people moving.
Here the 95th percentile of the residual is kept rather than the mean, so a hand moving in a small
part of the frame still counts.

usage: subjectmotion.py <video> <seconds>  ->  {"step": 0.1, "motion": [m0, m1, ...]}   (sample i ≈ t = i*0.1)
"""
import sys, json
import cv2
import numpy as np

W, H = 360, 640
path, secs = sys.argv[1], max(1.0, min(float(sys.argv[2]), 12.0))
cap = cv2.VideoCapture(path)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
step = max(1, int(round(fps / 10)))
ys, xs = np.mgrid[8:H:16, 8:W:16]
src = np.stack([xs.ravel(), ys.ravel()], 1).astype(np.float32)
gx, gy = np.meshgrid(np.arange(W), np.arange(H))
out, prev, i = [], None, 0
while True:
    ok, f = cap.read()
    if not ok or i / fps > secs:
        break
    if i % step == 0:
        g = cv2.cvtColor(cv2.resize(f, (W, H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        if prev is not None:
            fl = cv2.calcOpticalFlowFarneback(prev, g, None, 0.5, 4, 21, 3, 5, 1.1, 0)
            dst = src + fl[ys.ravel(), xs.ravel()]
            M, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=1.5)
            if M is None:
                out.append(None)
            else:
                pred = np.stack([M[0, 0] * gx + M[0, 1] * gy + M[0, 2] - gx, M[1, 0] * gx + M[1, 1] * gy + M[1, 2] - gy], -1)
                res = np.linalg.norm(fl - pred, axis=-1)
                out.append(round(float(np.percentile(res, 95)), 3))
        prev = g
    i += 1
# Sample k compares frames at (k) and (k+1) * 0.1 s; prepend a null so index i ≈ t = i*0.1 like the caller expects.
print(json.dumps({"step": 0.1, "motion": [None] + out}))
