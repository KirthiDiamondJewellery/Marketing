"""`synth`: deterministic synthetic test clips (no real footage, no TTS). Speech-like "words" are voiced harmonic
bursts with syllable modulation over a quiet room tone; the picture is ffmpeg's `testsrc2` pattern. The command
returns the exact word timings, which tests feed to the stub ASR engine.

Defects can be seeded for QC tests: black spans, frozen spans, clipped audio, a wrong size or frame rate."""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
from pydantic import Field

from .ffmpeg import run_ffmpeg, write_wav
from .schemas import Range, Wire

SR = 48000


class ScriptItem(Wire):
    word: str | None = None
    dur: float = Field(default=0.3, gt=0)
    pause: float | None = Field(default=None, ge=0)
    loud_db: float | None = None


class Defects(Wire):
    black: list[Range] = Field(default_factory=list)
    freeze: list[Range] = Field(default_factory=list)
    clip: list[Range] = Field(default_factory=list)


class SynthInput(Wire):
    output: str
    script: list[ScriptItem]
    width: int = 1080
    height: int = 1920
    fps: int = 30
    seed: int = 1
    speech_db: float = -20.0
    room_tone_db: float = -62.0
    lead_s: float = 0.0
    tail_s: float = 0.0
    defects: Defects = Field(default_factory=Defects)
    video: bool = True
    pattern: str = "testsrc2"


def _word(rng: np.random.Generator, dur: float, level_db: float) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    f0 = rng.uniform(105, 185) * (1 + 0.03 * np.sin(2 * np.pi * rng.uniform(4, 6) * t))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    voiced = sum((0.8**k) * np.sin(k * phase + rng.uniform(0, 6.28)) for k in range(1, 9))
    breath = rng.standard_normal(n) * 0.08
    syll = 0.55 + 0.45 * np.abs(np.sin(np.pi * rng.uniform(2.5, 4.5) * t + rng.uniform(0, 1)))
    a = int(0.015 * SR)
    env = np.ones(n)
    if n > 2 * a:
        env[:a] = np.linspace(0, 1, a)
        env[-a:] = np.linspace(1, 0, a)
    x = (voiced + breath) * syll * env
    rms = np.sqrt(np.mean(x**2)) or 1.0
    return x / rms * 10 ** (level_db / 20)


def synth(payload: dict) -> dict:
    inp = SynthInput.model_validate(payload)
    rng = np.random.default_rng(inp.seed)
    parts: list[np.ndarray] = []
    words: list[dict] = []
    t = 0.0

    def silence(d: float) -> None:
        nonlocal t
        if d > 0:
            parts.append(np.zeros(round(d * SR)))
            t += round(d * SR) / SR

    silence(inp.lead_s)
    for item in inp.script:
        if item.pause is not None:
            silence(item.pause)
            continue
        w = _word(rng, item.dur, item.loud_db if item.loud_db is not None else inp.speech_db)
        words.append({"text": item.word or "word", "start": round(t, 4), "end": round(t + len(w) / SR, 4)})
        parts.append(w)
        t += len(w) / SR
    silence(inp.tail_s)
    x = np.concatenate(parts) if parts else np.zeros(SR)
    # Room tone: low-passed noise at the requested level, under everything.
    room = np.convolve(rng.standard_normal(len(x)), np.ones(12) / 12, mode="same")
    room = room / (np.sqrt(np.mean(room**2)) or 1.0) * 10 ** (inp.room_tone_db / 20)
    x = x + room
    for c in inp.defects.clip:
        a, b = int(c.start * SR), int(c.end * SR)
        x[a:b] = np.clip(x[a:b] * 40, -1.0, 1.0)
    dur = len(x) / SR
    out = Path(inp.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "a.wav"
        write_wav(wav, np.clip(x, -1, 1), SR)
        if not inp.video:
            run_ffmpeg(
                ["-i", str(wav), "-c:a", "pcm_s16le", str(out)]
                if out.suffix == ".wav"
                else ["-i", str(wav), "-c:a", "aac", "-b:a", "192k", str(out)],
                what="write the test audio",
            )
        else:
            vf = []
            for b in inp.defects.black:
                vf.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,{b.start},{b.end})'")
            total = round(dur * inp.fps)
            for f in inp.defects.freeze:  # repeat one frame, then trim back to the original length
                first, last = round(f.start * inp.fps), round(f.end * inp.fps)
                vf.append(
                    f"loop=loop={last - first}:size=1:start={first},setpts=N/({inp.fps}*TB),trim=end_frame={total}"
                )
            chain = ",".join([*vf, "format=yuv420p"])
            run_ffmpeg(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    f"{inp.pattern}=s={inp.width}x{inp.height}:r={inp.fps}:d={dur:.4f}",
                    "-i",
                    str(wav),
                    "-vf",
                    chain,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "23",
                    "-g",
                    str(inp.fps),
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-ar",
                    "48000",
                    "-shortest",
                    "-movflags",
                    "+faststart",
                    str(out),
                ],
                what="write the test clip",
            )
    return {"path": str(out), "durationS": round(dur, 4), "words": words}
