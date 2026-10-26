"""`probe`: what a media file is (duration, streams, display size after rotation, colour)."""

from __future__ import annotations

from pathlib import Path

from .ffmpeg import ffprobe_json
from .schemas import Wire


class ProbeInput(Wire):
    path: str


def _fps(rate: str | None) -> float | None:
    if not rate or rate in ("0/0", "0"):
        return None
    if "/" in rate:
        n, d = rate.split("/", 1)
        try:
            return round(float(n) / float(d), 4) if float(d) else None
        except ValueError:
            return None
    try:
        return float(rate)
    except ValueError:
        return None


def _rotation(stream: dict) -> int:
    for sd in stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            try:
                return round(float(sd["rotation"])) % 360
            except (TypeError, ValueError):
                pass
    tag = (stream.get("tags") or {}).get("rotate")
    try:
        return int(tag) % 360 if tag is not None else 0
    except ValueError:
        return 0


def probe_file(path: str | Path) -> dict:
    data = ffprobe_json(path)
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    v = next(
        (s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")),
        None,
    )
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    out: dict = {
        "path": str(path),
        "durationS": round(float(fmt.get("duration") or (v or a or {}).get("duration") or 0.0), 4),
        "sizeBytes": int(fmt.get("size") or Path(path).stat().st_size),
        "formatName": fmt.get("format_name"),
        "bitRate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        "video": None,
        "audio": None,
    }
    if v:
        rot = _rotation(v)
        w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        dw, dh = (h, w) if rot in (90, 270) else (w, h)
        out["video"] = {
            "codec": v.get("codec_name"),
            "profile": v.get("profile"),
            "width": w,
            "height": h,
            "displayWidth": dw,
            "displayHeight": dh,
            "rotation": rot,
            "fps": _fps(v.get("avg_frame_rate")) or _fps(v.get("r_frame_rate")),
            "frames": int(v["nb_frames"]) if str(v.get("nb_frames", "")).isdigit() else None,
            "pixFmt": v.get("pix_fmt"),
            "colorTransfer": v.get("color_transfer"),
            "colorPrimaries": v.get("color_primaries"),
            "colorSpace": v.get("color_space"),
            "isImage": v.get("codec_name") in ("png", "mjpeg", "webp", "bmp", "tiff")
            and float(fmt.get("duration") or 0) < 0.1,
        }
    if a:
        out["audio"] = {
            "codec": a.get("codec_name"),
            "sampleRate": int(a.get("sample_rate") or 0),
            "channels": int(a.get("channels") or 0),
            "bitRate": int(a["bit_rate"]) if a.get("bit_rate") else None,
        }
    return out


def probe(payload: dict) -> dict:
    return probe_file(ProbeInput.model_validate(payload).path)
