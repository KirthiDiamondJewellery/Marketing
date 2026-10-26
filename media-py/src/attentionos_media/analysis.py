"""One-decode video analysis, cached by content fingerprint.

A single ffmpeg decode at a low analysis rate (5 fps, 640 px long side) feeds everything the editor needs from the
picture: face detections for framing, colour statistics for the automatic look, and the contact-sheet frames. The
result is a small JSON document cached under `<cache>/analysis/` (and next to the prep proxy as `analysis.json`), so
renders and revisions never decode the footage for analysis again.

Face detection: YuNet through OpenCV's DNN module (`models download face-yunet`, MIT), else OpenCV 4's bundled Haar
cascade, else none (framing is then centred). Tests can inject any detector with the same signature.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .ffmpeg import ffmpeg_bin, log
from .models import artifact_path, cache_dir, installed

ANALYSIS_VERSION = 2
ANALYSIS_FPS = 5.0
ANALYSIS_LONG_SIDE = 640

# (frame BGR uint8 [h, w, 3]) -> list of (cx, eye_y, face_w, score), all as fractions of the frame
Detector = Callable[[np.ndarray], list[tuple[float, float, float, float]]]


def fingerprint(path: str | Path) -> str:
    """Content fingerprint that is cheap on multi-GB files: size, mtime and the first/last MiB."""
    p = Path(path).resolve()
    st = p.stat()
    h = hashlib.sha256(f"{st.st_size}|{st.st_mtime_ns}".encode())
    with p.open("rb") as f:
        h.update(f.read(1 << 20))
        if st.st_size > 2 << 20:
            f.seek(-(1 << 20), 2)
            h.update(f.read(1 << 20))
    return h.hexdigest()[:24]


@dataclass
class FaceSample:
    t: float  # seconds from the start of the file
    x: float  # face centre, fraction of width
    y: float  # eye line, fraction of height
    w: float  # face width, fraction of width
    score: float


@dataclass
class VideoAnalysis:
    width: int
    height: int
    duration_s: float
    fps: float
    detector: str
    faces: list[FaceSample | None] = field(default_factory=list)  # one entry per analysis frame
    look: dict = field(default_factory=dict)
    sheet_times: list[float] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "version": ANALYSIS_VERSION,
            "width": self.width,
            "height": self.height,
            "durationS": round(self.duration_s, 3),
            "fps": self.fps,
            "detector": self.detector,
            "faces": [
                None if f is None else [round(f.t, 3), round(f.x, 4), round(f.y, 4), round(f.w, 4), round(f.score, 3)]
                for f in self.faces
            ],
            "look": self.look,
        }

    @classmethod
    def from_json(cls, d: dict) -> VideoAnalysis:
        faces = [None if f is None else FaceSample(*f) for f in d.get("faces", [])]
        return cls(
            d["width"], d["height"], d["durationS"], d["fps"], d.get("detector", "none"), faces, d.get("look", {})
        )

    @property
    def found_ratio(self) -> float:
        return sum(1 for f in self.faces if f) / max(1, len(self.faces))


# ---------------------------------------------------------------------------------------------------------------
# detectors
# ---------------------------------------------------------------------------------------------------------------


def default_detector(w: int, h: int) -> tuple[str, Detector | None]:
    try:
        import cv2  # type: ignore[import-not-found]
    except ImportError:
        return "none", None
    if installed("face-yunet"):
        try:
            yn = cv2.FaceDetectorYN.create(str(artifact_path("face-yunet")), "", (w, h), 0.7, 0.3, 50)

            def yunet(frame: np.ndarray) -> list[tuple[float, float, float, float]]:
                _, faces = yn.detect(frame)
                if faces is None:
                    return []
                # landmarks: right eye (4,5), left eye (6,7)
                return [((f[0] + f[2] / 2) / w, ((f[5] + f[7]) / 2) / h, f[2] / w, float(f[14])) for f in faces]

            return "yunet", yunet
        except Exception:  # an OpenCV build without the DNN module
            pass
    if hasattr(cv2, "CascadeClassifier") and hasattr(cv2, "data"):
        cascade = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        if cascade.exists():
            hc = cv2.CascadeClassifier(str(cascade))

            def haar(frame: np.ndarray) -> list[tuple[float, float, float, float]]:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                found = hc.detectMultiScale(gray, 1.1, 5, minSize=(max(24, w // 12), max(24, w // 12)))
                return [((x + fw / 2) / w, (y + fh * 0.4) / h, fw / w, 0.8) for x, y, fw, fh in found]

            return "haar", haar
    return "none", None


# ---------------------------------------------------------------------------------------------------------------
# look statistics
# ---------------------------------------------------------------------------------------------------------------


def _look_stats(samples: np.ndarray) -> dict:
    """Colour statistics from a pile of RGB pixels (uint8 [n, 3], full range), used for automatic levels and white
    balance. Luma is BT.709."""
    if not len(samples):
        return {}
    rgb = samples.astype(np.float32)
    y = 0.2126 * rgb[:, 0] + 0.7152 * rgb[:, 1] + 0.0722 * rgb[:, 2]
    p = np.percentile(y, [0.5, 2, 50, 98, 99.5])
    # Grey-world on mid-tone, low-saturation pixels (skin and saturated props excluded).
    mx, mn = rgb.max(axis=1), rgb.min(axis=1)
    neutral = (y > 40) & (y < 220) & ((mx - mn) < 0.25 * (mx + 1))
    pick = rgb[neutral] if neutral.sum() > 500 else rgb[(y > 30) & (y < 230)]
    means = pick.mean(axis=0) if len(pick) else np.array([128.0, 128.0, 128.0])
    sat = float(np.mean((mx - mn) / (mx + 1)))
    return {
        "lumaP0_5": round(float(p[0]), 2),
        "lumaP2": round(float(p[1]), 2),
        "lumaP50": round(float(p[2]), 2),
        "lumaP98": round(float(p[3]), 2),
        "lumaP99_5": round(float(p[4]), 2),
        "neutralRgb": [round(float(v), 2) for v in means],
        "saturation": round(sat, 4),
    }


# ---------------------------------------------------------------------------------------------------------------
# the pass
# ---------------------------------------------------------------------------------------------------------------


def _cache_file(fp: str) -> Path:
    return cache_dir() / "analysis" / f"{fp}-v{ANALYSIS_VERSION}.json"


def analyze_video(
    path: str | Path,
    width: int,
    height: int,
    duration_s: float,
    *,
    detector: Detector | None = None,
    detector_name: str | None = None,
    sheet_frames: int = 0,
    sheet_sink: list | None = None,
    use_cache: bool = True,
) -> VideoAnalysis:
    """Decodes `path` once at 5 fps (long side 640) and returns faces, look statistics and (into `sheet_sink`)
    contact-sheet thumbnails as (t, RGB ndarray). Cached by content fingerprint unless a custom detector is given."""
    fp = fingerprint(path)
    cpath = _cache_file(fp)
    if use_cache and detector is None and cpath.exists() and not sheet_frames:
        try:
            return VideoAnalysis.from_json(json.loads(cpath.read_text()))
        except (KeyError, TypeError, ValueError):
            pass
    scale = ANALYSIS_LONG_SIDE / max(width, height)
    w, h = max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)
    if detector is None:
        name, det = default_detector(w, h)
    else:
        name, det = detector_name or "custom", detector
    proc = subprocess.Popen(
        [
            ffmpeg_bin(),
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(path),
            "-an",
            "-sn",
            "-vf",
            f"fps={ANALYSIS_FPS},scale={w}:{h}:flags=bilinear",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    assert proc.stdout is not None
    fsize = w * h * 3
    faces: list[FaceSample | None] = []
    pixels: list[np.ndarray] = []
    rng = np.random.default_rng(0)
    n_expected = max(1, round(duration_s * ANALYSIS_FPS))
    sheet_at = (
        {min(n_expected - 1, int(n_expected * (i + 0.5) / sheet_frames)) for i in range(sheet_frames)}
        if sheet_frames
        else set()
    )
    i = 0
    while True:
        raw = proc.stdout.read(fsize)
        if len(raw) < fsize:
            break
        frame = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
        t = i / ANALYSIS_FPS
        best = None
        if det is not None:
            found = [d for d in det(frame) if d[3] >= 0.5]
            if found:
                d = max(found, key=lambda r: r[2])  # the largest face is the speaker
                best = FaceSample(t, float(d[0]), float(d[1]), float(d[2]), float(d[3]))
        faces.append(best)
        if i % 2 == 0:  # look statistics from every other analysis frame, 4k random pixels each
            flat = frame.reshape(-1, 3)
            pixels.append(flat[rng.integers(0, len(flat), 4000)][:, ::-1])
        if sheet_sink is not None and i in sheet_at:
            sheet_sink.append((t, frame[:, :, ::-1].copy()))
        i += 1
    proc.stdout.close()
    proc.wait()
    look = _look_stats(np.concatenate(pixels) if pixels else np.zeros((0, 3), np.uint8))
    res = VideoAnalysis(width, height, duration_s, ANALYSIS_FPS, name, faces, look)
    if detector is None:
        cpath.parent.mkdir(parents=True, exist_ok=True)
        cpath.write_text(json.dumps(res.to_json()))
    log(f"Analysed {i} frames ({name} faces in {res.found_ratio:.0%})")
    return res


def load_or_analyze(path: str | Path, width: int, height: int, duration_s: float) -> VideoAnalysis:
    """Sidecar `analysis.json` (written by prep next to the proxy) → content cache → a fresh analysis pass."""
    p = Path(path)
    side = p.with_name("analysis.json")
    if side.exists():
        try:
            d = json.loads(side.read_text())
            if (
                d.get("version") == ANALYSIS_VERSION
                and d.get("for") in (p.name, str(p.resolve()))
                and abs(d["width"] / max(1, d["height"]) - width / max(1, height)) < 0.01
                and abs(d["durationS"] - duration_s) < 0.5
            ):
                return VideoAnalysis.from_json(d)
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            pass
    return analyze_video(path, width, height, duration_s)


def write_sidecar(analysis: VideoAnalysis, media_path: str | Path) -> Path:
    p = Path(media_path)
    side = p.with_name("analysis.json")
    side.write_text(json.dumps({**analysis.to_json(), "for": p.name}))
    return side
