#!/usr/bin/env python3
"""hookmotion.py — how much each part of the frame MOVES in the hook, with the camera's own move removed.

Why (2026-10-01): the FIFA source's knees bounce steadily through the first second (measured: the
bottom of the frame moves ~4x more than the head), but frame-to-frame it is a few pixels, so the
vision writer — looking at stills, even 0.15 s apart — never named it, and no recreate had it.
This measures it so the writer is TOLD.

Method: dense optical flow (Farneback) between frames 0.1 s apart at 360x640 grey; the camera's
move (push-in, pan, shake) is fitted as one similarity transform over the whole frame (RANSAC) and
subtracted; the residual is people moving. Mean residual per band, px per 0.1 s.

usage: hookmotion.py <video> <seconds>   ->   {"head": x, "middle": y, "bottom": z, "seconds": s}
"""
import sys, json
import cv2
import numpy as np

W, H = 360, 640
path, secs = sys.argv[1], max(0.5, min(float(sys.argv[2]), 3.0))
cap = cv2.VideoCapture(path)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
frames = []
while True:
    ok, f = cap.read()
    if not ok or len(frames) / fps > secs:
        break
    frames.append(cv2.cvtColor(cv2.resize(f, (W, H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY))
step = max(1, int(round(fps / 10)))
ys, xs = np.mgrid[8:H:16, 8:W:16]
src = np.stack([xs.ravel(), ys.ravel()], 1).astype(np.float32)
gx, gy = np.meshgrid(np.arange(W), np.arange(H))
bands = {'head': [], 'middle': [], 'bottom': []}
for k in range(0, len(frames) - step, step):
    fl = cv2.calcOpticalFlowFarneback(frames[k], frames[k + step], None, 0.5, 4, 21, 3, 5, 1.1, 0)
    dst = src + fl[ys.ravel(), xs.ravel()]
    M, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=1.5)
    if M is None:
        continue
    pred = np.stack([M[0, 0] * gx + M[0, 1] * gy + M[0, 2] - gx, M[1, 0] * gx + M[1, 1] * gy + M[1, 2] - gy], -1)
    r = np.linalg.norm(fl - pred, axis=2)
    x0, x1 = int(W * .15), int(W * .85)
    bands['head'].append(float(r[int(H * .05):int(H * .35), int(W * .3):int(W * .7)].mean()))
    bands['middle'].append(float(r[int(H * .35):int(H * .75), x0:x1].mean()))
    bands['bottom'].append(float(r[int(H * .75):, x0:x1].mean()))
out = {k: (round(float(np.mean(v)), 3) if v else None) for k, v in bands.items()}
out['seconds'] = round(secs, 2)
print(json.dumps(out))
