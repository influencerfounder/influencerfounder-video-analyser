#!/usr/bin/env python3
"""cutflow.py VIDEO T1,T2,... -> JSON {"ratios": {t: ratio}}

MOTION IS NOT A CUT (2026-10-09). For each candidate cut, take the frame just before and the frame
at the candidate, compute dense optical flow between them, warp the first onto the second and measure
how much of the difference the motion CANNOT explain (residual / raw). A camera move or a fast fall is
the same picture shifted: flow explains most of it (low ratio). Across a real cut nothing shifted into
anything: the residual stays near the raw difference (ratio ~1), even between two shots of one place.
Measured 10-09 on 21 candidates: fake cuts (window-cleaning fall + zoom-out) 0.32-0.64, real hard cuts
0.69-0.98. The threshold lives in cloneV2.js (CUT_FLOW_RATIO).
"""
import sys, json
import cv2
import numpy as np

def pair(cap, fps, t):
    i = int(round(t * fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, i - 1))
    ok1, a = cap.read(); ok2, b = cap.read()
    if not (ok1 and ok2): return None, None
    g = lambda x: cv2.cvtColor(cv2.resize(x, (180, 320)), cv2.COLOR_BGR2GRAY)
    return g(a), g(b)

def main():
    path, ts = sys.argv[1], [float(x) for x in sys.argv[2].split(',') if x]
    cap = cv2.VideoCapture(path); fps = cap.get(cv2.CAP_PROP_FPS) or 30
    out = {}
    for t in ts:
        a, b = pair(cap, fps, t)
        if a is None: continue
        flow = cv2.calcOpticalFlowFarneback(b, a, None, 0.5, 4, 21, 3, 7, 1.5, 0)
        h, w = a.shape; gx, gy = np.meshgrid(np.arange(w), np.arange(h))
        warped = cv2.remap(a.astype(np.float32), (gx + flow[..., 0]).astype(np.float32), (gy + flow[..., 1]).astype(np.float32), cv2.INTER_LINEAR)
        af, bf = a.astype(np.float32), b.astype(np.float32)
        raw = float(np.mean(np.abs(af - bf))); res = float(np.mean(np.abs(warped - bf)))
        out[str(t)] = round(res / max(raw, 1e-6), 3)
    cap.release()
    print(json.dumps({"ratios": out}))

if __name__ == '__main__':
    main()
