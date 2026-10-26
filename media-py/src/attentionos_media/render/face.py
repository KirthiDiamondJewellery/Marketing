"""Face-aware framing. OpenCV is an optional extra (`vision`): with it, faces are found with YuNet (when the model is
downloaded with `models download face-yunet`, part of the default set) or, on OpenCV 4 builds, the bundled Haar
cascade; otherwise framing is centred. Framing is static per layout
segment (the median face over sampled frames), so it never jitters."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..ffmpeg import ffmpeg_bin
from ..models import artifact_path, installed


@dataclass(frozen=True)
class Focus:
    x: float  # 0..1 of the source width (face centre)
    y: float  # 0..1 of the source height (eye line)
    found: bool
    method: str


CENTER = Focus(0.5, 0.38, False, "center")


def _grab(path: str, t: float, w: int, h: int) -> np.ndarray | None:
    raw = subprocess.run(
        [
            ffmpeg_bin(),
            "-v",
            "error",
            "-nostdin",
            "-ss",
            f"{max(0.0, t):.3f}",
            "-i",
            path,
            "-frames:v",
            "1",
            "-vf",
            f"scale={w}:{h}",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-",
        ],
        capture_output=True,
    ).stdout
    if len(raw) < w * h * 3:
        return None
    return np.frombuffer(raw[: w * h * 3], np.uint8).reshape(h, w, 3)


def detect_focus(path: str, times: list[float], src_w: int, src_h: int) -> Focus:
    try:
        import cv2  # type: ignore[import-not-found]
    except ImportError:
        return CENTER
    scale = 640 / max(src_w, src_h)
    w, h = max(2, int(src_w * scale) // 2 * 2), max(2, int(src_h * scale) // 2 * 2)
    yunet = None
    if installed("face-yunet"):
        try:
            yunet = cv2.FaceDetectorYN.create(str(artifact_path("face-yunet")), "", (w, h), 0.7, 0.3, 50)
        except Exception:  # an OpenCV build without the DNN module
            yunet = None
    haar = None
    if yunet is None and hasattr(cv2, "CascadeClassifier") and hasattr(cv2, "data"):
        # OpenCV 4 bundles Haar cascades; OpenCV 5 dropped them from the main module.
        cascade = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        if cascade.exists():
            haar = cv2.CascadeClassifier(str(cascade))
    if yunet is None and haar is None:
        return CENTER
    xs, ys = [], []
    for t in times:
        frame = _grab(path, t, w, h)
        if frame is None:
            continue
        if yunet is not None:
            _, faces = yunet.detect(frame)
            if faces is None or len(faces) == 0:
                continue
            f = max(faces, key=lambda r: r[2] * r[3])
            # landmarks: right eye (4,5), left eye (6,7)
            xs.append((f[0] + f[2] / 2) / w)
            ys.append(((f[5] + f[7]) / 2) / h)
        else:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = haar.detectMultiScale(gray, 1.1, 5, minSize=(max(24, w // 12), max(24, w // 12)))
            if len(faces) == 0:
                continue
            fx, fy, fw, fh = max(faces, key=lambda r: r[2] * r[3])
            xs.append((fx + fw / 2) / w)
            ys.append((fy + fh * 0.4) / h)
    if not xs:
        return Focus(0.5, 0.38, False, "yunet" if yunet is not None else "haar")
    return Focus(float(np.median(xs)), float(np.median(ys)), True, "yunet" if yunet is not None else "haar")


def crop_window(
    src_w: int, src_h: int, box_w: int, box_h: int, focus: Focus, eye_at: float = 0.40, zoom: float = 1.0
) -> tuple[int, int, int, int]:
    """Region (x, y, w, h) of the source that covers a box_w×box_h target, keeping the face's eye line at `eye_at`
    of the box height and the face centred horizontally where the source allows."""
    target_ar = box_w / box_h
    if src_w / src_h > target_ar:
        ch = src_h / zoom
        cw = ch * target_ar
    else:
        cw = src_w / zoom
        ch = cw / target_ar
    cx = focus.x * src_w - cw / 2
    cy = focus.y * src_h - ch * eye_at
    cx = min(max(0.0, cx), src_w - cw)
    cy = min(max(0.0, cy), src_h - ch)
    cw_i, ch_i = int(cw) // 2 * 2, int(ch) // 2 * 2
    return int(cx) // 2 * 2, int(cy) // 2 * 2, max(2, cw_i), max(2, ch_i)
