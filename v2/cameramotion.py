#!/usr/bin/env python3
"""cameramotion.py — which way the CAMERA moves through the whole source, in screen directions.

Why (2026-10-04): on the G63 source the camera pans LEFT to the G-Wagon at 1-7 s, but 4 of 5
written prompts said "pans/drifts right" — the writer reads direction from stills and guesses.
Wan then pans into space the prompt never described and invents it (a palm-tree forecourt).
Same cure as hookmotion.py: measure it, tell the writer.

Method: the camera fit from hookmotion.py — dense optical flow (Farneback) between frames 0.1 s
apart at 360x640 grey, one similarity transform (RANSAC) over the OUTER BAND of the frame only
(the middle is usually the subject), read at the frame CENTRE = the camera's move. Steps that straddle a measured cut are skipped (a cut is not a camera move). Per window of
up to 1 s (windows restart at every cut) the median move is labelled:
  pan   — the content slides sideways: content moving RIGHT on screen = camera turning LEFT
  tilt  — content moving DOWN on screen = camera tilting UP
  zoom  — content growing = camera pushing IN (or a dolly forward; same thing on screen)
Thresholds are per second at 360 px width (validated on G63 / lobby / FIFA, 2026-10-04):
pan/tilt >= 20 px/s (~5% of the width; 12-17 px/s readings on G63 12-14 s were noise), zoom >= 2.5 %/s. Consecutive equal labels merge.

usage: cameramotion.py <video> [cut,cut,...]  ->  {"segments":[{"from":0,"to":1.2,"pan":"left","tilt":null,"zoom":"in"}...]}
"""
import sys, json
import cv2
import numpy as np

W, H = 360, 640
PAN_PX, ZOOM_PCT, MAX_SECS = 20.0, 2.5, 60.0

path = sys.argv[1]
cuts = sorted(float(c) for c in (sys.argv[2].split(',') if len(sys.argv) > 2 and sys.argv[2] else []))
cap = cv2.VideoCapture(path)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
frames = []
while True:
    ok, f = cap.read()
    if not ok or len(frames) / fps > MAX_SECS:
        break
    frames.append(cv2.cvtColor(cv2.resize(f, (W, H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY))
dur = len(frames) / fps
step = max(1, int(round(fps / 10)))
ys, xs = np.mgrid[8:H:16, 8:W:16]
# Only the outer band of the frame: in a close-up the face fills the middle and its own move
# would be read as the camera's (FIFA 7-9 s: a head turn measured as a 60 px/s "pan").
border = (xs < W * 0.22) | (xs > W * 0.78) | (ys < H * 0.15) | (ys > H * 0.85)
ys, xs = ys[border], xs[border]
src = np.stack([xs.ravel(), ys.ravel()], 1).astype(np.float32)
CX, CY = W / 2.0, H / 2.0

bounds = [0.0] + [c for c in cuts if 0 < c < dur] + [dur]
def window_of(t):
    """(start, end) of the <=1 s window holding t; windows restart at every cut."""
    for a, b in zip(bounds, bounds[1:]):
        if a <= t < b:
            k = int((t - a) // 1.0)
            return (round(a + k, 2), round(min(b, a + k + 1.0), 2))
    return None

per = {}
for k in range(0, len(frames) - step, step):
    t0, t1 = k / fps, (k + step) / fps
    if any(t0 - 0.05 <= c <= t1 + 0.05 for c in cuts):
        continue
    fl = cv2.calcOpticalFlowFarneback(frames[k], frames[k + step], None, 0.5, 4, 21, 3, 5, 1.1, 0)
    dst = src + fl[ys.ravel(), xs.ravel()]
    M, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=1.5)
    if M is None:
        continue
    w = window_of(t0)
    if w:
        # The move of the frame CENTRE, not of the (0,0) corner: a pure push-in about the centre
        # has translation -(s-1)*CX at the corner, which read as a 36 px/s "pan right" on FIFA.
        cdx = M[0, 0] * CX + M[0, 1] * CY + M[0, 2] - CX
        cdy = M[1, 0] * CX + M[1, 1] * CY + M[1, 2] - CY
        per.setdefault(w, []).append((cdx, cdy, float(np.hypot(M[0, 0], M[1, 0]))))

rate = fps / step   # steps per second
rows = []
for (a, b) in sorted(per):
    v = np.array(per[(a, b)])
    if len(v) < 3:   # under ~0.3 s of usable flow: too little to call a direction
        continue
    dx, dy = np.median(v[:, 0]) * rate, np.median(v[:, 1]) * rate
    zoom = (np.median(v[:, 2]) ** rate - 1) * 100
    # Content moving right (dx > 0) means the camera turned LEFT, and vice versa.
    pan = 'left' if dx >= PAN_PX else ('right' if dx <= -PAN_PX else None)
    tilt = 'up' if dy >= PAN_PX else ('down' if dy <= -PAN_PX else None)
    zm = 'in' if zoom >= ZOOM_PCT else ('out' if zoom <= -ZOOM_PCT else None)
    if zm:
        # A push-in toward a point that is NOT the frame centre also shifts the centre, which
        # reads as a pan/tilt (FIFA: a push-in on a face above centre measured as "tilt up").
        # The zoom's fixed point is -t/(s-1) from the centre; inside the frame = a plain
        # push-in/pull-out, so no turn is reported. Outside = the camera really turns as well.
        sc = np.median(v[:, 2]) - 1.0
        fx, fy = -np.median(v[:, 0]) / sc, -np.median(v[:, 1]) / sc
        if abs(fx) < W / 2 and abs(fy) < H / 2:
            pan = tilt = None
    rows.append({'from': a, 'to': b, 'pan': pan, 'tilt': tilt, 'zoom': zm})

segs = []
for r in rows:
    last = segs[-1] if segs else None
    # Merge only CONTIGUOUS equal labels that do not cross a cut.
    if last and last['to'] == r['from'] and (last['pan'], last['tilt'], last['zoom']) == (r['pan'], r['tilt'], r['zoom']) \
            and not any(last['from'] < c <= r['from'] for c in cuts):
        last['to'] = r['to']
    else:
        segs.append(dict(r))
print(json.dumps({'segments': segs, 'seconds': round(dur, 2)}))
