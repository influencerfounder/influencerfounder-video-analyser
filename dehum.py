#!/usr/bin/env python3
# 🔇 HUM DETECTOR (VQL 2026-11-17-04). Wan lays a steady low tone under many takes (43-151 Hz, present in 75-100 %
# of frames). This finds those tones in a finished video's audio so dehum.js can notch exactly them.
# Usage: dehum.py <video> <ffmpeg-bin>  ->  JSON {"hum":[{"hz","prom","persist"}], "flux", "seconds"}
# Same measure as the case (frozen-bed/hum test): 4096-pt Hann frames, hop 2048, mono 44.1 kHz; a tone counts when
# it stands >= 12 dB above its +-40-bin neighbourhood in the mean spectrum AND > 8 dB above it in >= 85 % of frames.
import sys, json, subprocess
import numpy as np
SR = 44100
def main():
    video, ff = sys.argv[1], sys.argv[2]
    raw = subprocess.run([ff, '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, timeout=120).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    if len(x) < SR:
        print(json.dumps({"hum": [], "flux": None, "seconds": len(x) / SR, "reason": "no or too little audio"})); return
    n, hop, k = 4096, 2048, 40
    fr = np.lib.stride_tricks.sliding_window_view(x, n)[::hop] * np.hanning(n)
    S = np.abs(np.fft.rfft(fr, axis=1)) ** 2
    f = np.fft.rfftfreq(n, 1 / SR)
    mean = 10 * np.log10(S.mean(0) + 1e-20)
    Sdb = 10 * np.log10(S + 1e-20)
    hum = []
    for i in range(3, int(250 / f[1]) + 1):
        if f[i] < 35 or mean[i] < mean[i - 1] or mean[i] < mean[i + 1]: continue
        lo, hi = max(0, i - k), i + k
        prom = mean[i] - np.median(mean[lo:hi])
        if prom < 12: continue
        persist = float(np.mean(Sdb[:, i] - np.median(Sdb[:, lo:hi], axis=1) > 8))
        if persist >= 0.85:
            # Bins are 10.8 Hz wide: place the tone between bins (parabolic fit on the dB peak) so the notch hits it.
            a, b2, c = mean[i - 1], mean[i], mean[i + 1]
            den = a - 2 * b2 + c
            off = 0.5 * (a - c) / den if den != 0 else 0.0
            hz = float(f[i] + max(-0.5, min(0.5, off)) * f[1])
            hum.append({"hz": round(hz, 1), "prom": round(float(prom), 1), "persist": round(persist, 2)})
    L = np.log10(S[:, (f > 100) & (f < 8000)] + 1e-12)
    flux = float(np.mean(np.abs(np.diff(L, axis=0))))
    print(json.dumps({"hum": hum, "flux": round(flux, 3), "seconds": round(len(x) / SR, 2)}))
main()
