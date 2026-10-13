#!/usr/bin/env python3
"""focusshift.py — when the phone camera's AUTOFOCUS loses focus and finds it again in the source.

Why (2026-10-13, Mike: "it looks so real because you see the camera focus and out of focussing"):
on the @arsenalisoltanov grandmother reel the image goes soft three times — at the start, when a
passer-by's head crosses close to the lens (1.5-2.1 s, sharpness down to ~7 % of normal) and while
the camera walks up to her (4.4-4.9 s). The recreate was evenly razor-sharp in every frame, which is
exactly what makes AI video read as AI. The writer cannot see this from stills, so it is MEASURED
and told, like the cuts and the camera (hookmotion.py / v2/cameramotion.py).

Method: frames 0.1 s apart at 360x640 grey (decoded by ffmpeg, numpy only). Sharpness = variance of the Laplacian over the
centre half of the frame (where the subject is). Reference = the median sharpness of the surrounding 2 s. A FOCUS SHIFT is a run of at least
0.2 s where sharpness is below 50 % of that reference, with the camera NOT moving fast (global shift
from phase correlation under 40 px per 0.1 s — a whip pan blurs too, and that is motion blur, not
focus; someone passing close to the lens IS the phone moment we want, so slower movement counts). Runs within 0.15 s of a measured cut are skipped (a cut changes the picture, not the focus).

usage: focusshift.py <video> [cut,cut,...]
  -> {"events":[{"from":1.5,"to":2.1,"low":0.07}], "frames": n}
     low = the deepest sharpness in the run as a fraction of the reference (0.07 = 7 %).
"""
import sys, json, subprocess, os
import numpy as np

W, H = 360, 640
MAX_SECS, DROP, MIN_RUN, MAX_SHIFT, CUT_GUARD = 60.0, 0.5, 0.2, 40.0, 0.15
FFMPEG = os.environ.get('FFMPEG_BIN', 'ffmpeg')

path = sys.argv[1]
cuts = sorted(float(c) for c in (sys.argv[2].split(',') if len(sys.argv) > 2 and sys.argv[2] else []))

# Frames 0.1 s apart as raw grey bytes straight from ffmpeg — no OpenCV needed, so the same script
# runs on the server and on a laptop.
# Frames are decoded and measured ONE AT A TIME (reviewer, 2026-10-13: holding the whole clip as float64
# peaked at 769 MB for 30 s and ~1.5 GB at the 60 s cap). Only the previous frame is kept, as float32.
proc = subprocess.Popen([FFMPEG, '-v', 'error', '-t', str(MAX_SECS), '-i', path, '-vf', f'fps=10,scale={W}:{H},format=gray',
                         '-f', 'rawvideo', '-'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

def lap_var(g):
    l = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(l.var())

WIN = np.outer(np.hanning(H), np.hanning(W)).astype(np.float32)
def phase_shift(a, b):
    # Global translation between two frames (phase correlation): how far the whole picture slid.
    fa, fb = np.fft.fft2(a * WIN), np.fft.fft2(b * WIN)
    r = fa * np.conj(fb); r /= np.maximum(np.abs(r), 1e-9)
    c = np.abs(np.fft.ifft2(r))
    y, x = np.unravel_index(np.argmax(c), c.shape)
    if y > H // 2: y -= H
    if x > W // 2: x -= W
    return float((x * x + y * y) ** 0.5)

sharp, shift, prev = [], [], None
while True:
    buf = proc.stdout.read(W * H)
    if len(buf) < W * H:
        break
    g = np.frombuffer(buf, dtype=np.uint8).reshape(H, W).astype(np.float32)
    # The CENTRE half of the frame: where the subject is, so where autofocus is judged. Measured on the
    # grandmother reel: the whole frame caught only the 1.6-2.1 s pull; the centre also catches the soft
    # start and the hunt while walking up to her (4.4-4.9 s).
    sharp.append(lap_var(g[H // 4: 3 * H // 4, W // 4: 3 * W // 4]))
    shift.append(0.0 if prev is None else phase_shift(prev, g))
    prev = g
proc.wait(timeout=30)
times = [round(k / 10, 2) for k in range(len(sharp))]

events = []
n = len(sharp)
if n >= 5:
    s = np.array(sharp)
    half = 10   # +-1 s of samples at 0.1 s
    # The reference is the LOCAL sharpness (+-1 s) but never below 80 % of the clip's own median: a long
    # soft stretch (1.1 s on the church test, 2026-10-13) dragged the local median down with it and the
    # dip measured itself as normal.
    glob = float(np.median(s))
    ref = np.array([max(np.median(s[max(0, k - half):min(n, k + half + 1)]), 0.8 * glob) for k in range(n)])
    low = s < DROP * np.maximum(ref, 1e-6)
    k = 0
    while k < n:
        if not low[k]:
            k += 1
            continue
        j = k
        while j + 1 < n and low[j + 1]:
            j += 1
        a, b = times[k], times[j] + 0.1
        near_cut = any(c - CUT_GUARD <= t <= c + CUT_GUARD for c in cuts for t in (a, b))
        moving = float(np.median(shift[k:j + 1])) > MAX_SHIFT
        if (b - a) >= MIN_RUN - 1e-9 and not near_cut and not moving:
            depth = float(np.min(s[k:j + 1] / np.maximum(ref[k:j + 1], 1e-6)))
            events.append({"from": round(a, 1), "to": round(b, 1), "low": round(depth, 2)})
        k = j + 1

print(json.dumps({"events": events, "frames": n}))
