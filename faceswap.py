#!/usr/bin/env python3
"""
Frame-by-frame face swap using InsightFace + inswapper_128.
Usage: python3 faceswap.py <face_image_path> <frames_dir> <output_dir>
Writes swapped frames to output_dir, prints progress to stderr.
Exits 0 on success, 1 on error.
"""
import sys, os, cv2

def main():
    if len(sys.argv) < 4:
        print("Usage: faceswap.py <face_img> <frames_dir> <output_dir>", file=sys.stderr)
        sys.exit(1)

    face_path  = sys.argv[1]
    frames_dir = sys.argv[2]
    output_dir = sys.argv[3]

    import insightface
    from insightface.app import FaceAnalysis

    print("[faceswap] loading models...", file=sys.stderr, flush=True)
    app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
    app.prepare(ctx_id=0, det_size=(640, 640))
    swapper = insightface.model_zoo.get_model(
        'inswapper_128.onnx', download=True, download_zip=True
    )
    print("[faceswap] models ready", file=sys.stderr, flush=True)

    # Load source face
    src_img = cv2.imread(face_path)
    if src_img is None:
        print(f"ERROR: cannot read face image {face_path}", file=sys.stderr)
        sys.exit(1)
    src_faces = app.get(src_img)
    if not src_faces:
        print("ERROR: no face detected in source image", file=sys.stderr)
        sys.exit(1)
    src_face = sorted(src_faces,
                      key=lambda f: (f.bbox[2]-f.bbox[0]) * (f.bbox[3]-f.bbox[1]),
                      reverse=True)[0]
    print(f"[faceswap] source face bbox: {src_face.bbox}", file=sys.stderr, flush=True)

    os.makedirs(output_dir, exist_ok=True)
    frames = sorted(
        f for f in os.listdir(frames_dir)
        if f.lower().endswith(('.jpg', '.jpeg', '.png'))
    )
    total = len(frames)
    print(f"[faceswap] processing {total} frames...", file=sys.stderr, flush=True)

    swapped = 0
    for i, fname in enumerate(frames):
        src_path = os.path.join(frames_dir, fname)
        dst_path = os.path.join(output_dir, fname)
        frame = cv2.imread(src_path)
        if frame is None:
            # Copy original if unreadable
            import shutil; shutil.copy2(src_path, dst_path)
            continue

        faces = app.get(frame)
        if faces:
            # Swap the largest detected face
            target = sorted(faces,
                            key=lambda f: (f.bbox[2]-f.bbox[0]) * (f.bbox[3]-f.bbox[1]),
                            reverse=True)[0]
            frame = swapper.get(frame, target, src_face, paste_back=True)
            swapped += 1

        cv2.imwrite(dst_path, frame)

        if (i + 1) % 20 == 0 or (i + 1) == total:
            print(f"[faceswap] {i+1}/{total} frames", file=sys.stderr, flush=True)

    print(f"[faceswap] done — swapped faces in {swapped}/{total} frames", flush=True)

if __name__ == '__main__':
    main()
