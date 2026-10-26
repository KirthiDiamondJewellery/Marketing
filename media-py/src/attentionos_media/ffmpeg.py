"""ffmpeg / ffprobe helpers. Every subprocess call in the sidecar goes through here so tools are invoked
consistently (same flags, same error handling, no shell)."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Sequence
from functools import cache
from pathlib import Path

import numpy as np

from .errors import MediaError, ToolMissing

FFMPEG_FIX = (
    "Install ffmpeg: macOS `brew install ffmpeg`, Ubuntu/Debian `sudo apt install ffmpeg`, "
    "Windows `winget install ffmpeg` (or use WSL). Then run `attentionos doctor`."
)

# Colour tags written on every encode: BT.709 SDR, limited range. Skipping them makes players guess
# (often BT.601), which shifts skin toward yellow/green.
BT709_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]


@cache
def ffmpeg_bin() -> str:
    path = os.environ.get("ATTENTIONOS_FFMPEG") or shutil.which("ffmpeg")
    if not path:
        raise ToolMissing("ffmpeg", FFMPEG_FIX)
    return path


@cache
def ffprobe_bin() -> str:
    path = os.environ.get("ATTENTIONOS_FFPROBE") or shutil.which("ffprobe")
    if not path:
        raise ToolMissing("ffprobe", FFMPEG_FIX)
    return path


@cache
def has_filter(name: str) -> bool:
    out = subprocess.run([ffmpeg_bin(), "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    return re.search(rf"^\s*\S+\s+{re.escape(name)}\s", out, re.M) is not None


@cache
def has_encoder(name: str) -> bool:
    out = subprocess.run([ffmpeg_bin(), "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return re.search(rf"^\s*\S+\s+{re.escape(name)}\s", out, re.M) is not None


def log(msg: str) -> None:
    """Progress goes to stderr as JSON lines (stdout is reserved for the command's JSON result)."""
    sys.stderr.write(json.dumps({"progress": msg}) + "\n")
    sys.stderr.flush()


def run_ffmpeg(args: Sequence[str], *, what: str, timeout: float | None = None, capture: bool = True) -> str:
    """Runs ffmpeg with `-hide_banner -nostdin -y` and returns stderr. Raises MediaError with the tail of
    ffmpeg's own message on failure."""
    cmd = [ffmpeg_bin(), "-hide_banner", "-nostdin", "-y", *args]
    try:
        proc = subprocess.run(cmd, capture_output=capture, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise MediaError(
            "timeout", f"ffmpeg timed out while trying to {what}.", "Try a shorter clip or raise the timeout."
        ) from exc
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-8:])
        raise MediaError("ffmpeg_failed", f"ffmpeg could not {what}.", None, {"stderr": tail, "cmd": cmd[:40]})
    return proc.stderr or ""


def ffmpeg_stderr(args: Sequence[str], *, timeout: float | None = None) -> str:
    """Runs an analysis pass (`-f null -`) and returns stderr even when ffmpeg exits non-zero."""
    cmd = [ffmpeg_bin(), "-hide_banner", "-nostdin", "-nostats", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.stderr or ""


def decode_audio(
    path: str | Path,
    sr: int = 48000,
    *,
    start: float | None = None,
    dur: float | None = None,
    channels: int = 1,
    af: str | None = None,
) -> np.ndarray:
    """Float32 PCM, mono by default ([n]); with channels=2, interleaved stereo reshaped to [n, 2]. Note that ffmpeg's
    stereo→mono downmix sums channels at −3 dB each, so identical channels read 3 dB hotter in mono: measure peaks
    and clipping on the real channels. Returns an empty array for files without audio."""
    args = [ffmpeg_bin(), "-v", "error", "-nostdin"]
    if start is not None:
        args += ["-ss", f"{start:.6f}"]
    args += ["-i", str(path)]
    if dur is not None:
        args += ["-t", f"{dur:.6f}"]
    args += ["-vn", *(["-af", af] if af else []), "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"]
    proc = subprocess.run(args, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace")
        if (
            "does not contain any stream" in err
            or "matches no streams" in err
            or "Output file #0 does not contain" in err
        ):
            return np.zeros(0, np.float32)
        raise MediaError("ffmpeg_failed", f"Could not read audio from {Path(path).name}.", None, {"stderr": err[-800:]})
    x = np.frombuffer(proc.stdout, np.float32).copy()
    return x.reshape(-1, channels) if channels > 1 else x


def write_wav(path: str | Path, samples: np.ndarray, sr: int) -> None:
    """Writes float samples ([n] mono or [n, ch]) as 16-bit PCM WAV."""
    import wave

    x = np.asarray(samples, np.float32)
    if x.ndim == 1:
        x = x[:, None]
    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).round().astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def ffprobe_json(path: str | Path) -> dict:
    p = Path(path)
    if not p.exists():
        raise MediaError("not_found", f"File not found: {p}", "Check the path; it must be readable by this machine.")
    proc = subprocess.run(
        [ffprobe_bin(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(p)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise MediaError(
            "unreadable_media",
            f"ffprobe could not read {p.name}.",
            "Is it a video or audio file?",
            {"stderr": proc.stderr[-500:]},
        )
    return json.loads(proc.stdout or "{}")
