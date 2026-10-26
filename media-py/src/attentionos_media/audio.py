"""Audio analysis shared by prep, cut-plan and QC: RMS envelopes, loudness, silence runs and the dead-air
gap measure. Everything here works in SOURCE time of whatever signal it is given; callers that need
output time must map through the time map (never compare output times with source-time pauses)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .ffmpeg import ffmpeg_stderr

HOP_S = 0.01  # 10 ms envelope hop
SR = 48000


def envelope_db(x: np.ndarray, sr: int = SR, hop_s: float = HOP_S, win_s: float | None = None) -> np.ndarray:
    """RMS level in dBFS per hop. `win_s` > hop smooths with a centred moving average of power."""
    hop = max(1, round(sr * hop_s))
    n = len(x) // hop
    if n == 0:
        return np.zeros(0, np.float64)
    power = (x[: n * hop].astype(np.float64).reshape(n, hop) ** 2).mean(axis=1)
    if win_s and win_s > hop_s:
        k = max(1, round(win_s / hop_s))
        kernel = np.ones(k) / k
        power = np.convolve(power, kernel, mode="same")
    return 10.0 * np.log10(power + 1e-12)


@dataclass
class Loudness:
    integrated: float  # LUFS
    true_peak: float  # dBTP
    lra: float  # LU

    def to_json(self) -> dict:
        return {
            "integratedLufs": round(self.integrated, 2),
            "truePeakDbtp": round(self.true_peak, 2),
            "lraLu": round(self.lra, 2),
        }


def measure_loudness(path: str | Path) -> Loudness:
    """EBU R128 via ffmpeg's loudnorm analysis (same meter the finisher uses)."""
    err = ffmpeg_stderr(
        ["-i", str(path), "-vn", "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"]
    )
    data = parse_loudnorm_json(err)
    if data is None:
        return Loudness(-70.0, -70.0, 0.0)
    return Loudness(
        _num(data.get("input_i"), -70.0), _num(data.get("input_tp"), -70.0), _num(data.get("input_lra"), 0.0)
    )


def parse_loudnorm_json(stderr: str) -> dict | None:
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _num(v: object, default: float) -> float:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return f if np.isfinite(f) else default


@dataclass
class Levels:
    floor_db: float  # room floor (1st percentile of audible frames)
    speech_db: float  # power mean of voiced frames
    ref_db: float  # 90th percentile


def levels(db: np.ndarray) -> Levels:
    audible = db[db > -90]
    if len(audible) == 0:
        return Levels(-120.0, -120.0, -120.0)
    floor = float(np.percentile(audible, 1))
    ref = float(np.percentile(audible, 90))
    voiced = db[db > floor + 0.35 * (ref - floor)]
    speech = float(10 * np.log10(np.mean(10 ** (voiced / 10)))) if len(voiced) else ref
    return Levels(floor, speech, ref)


def runs_below(db: np.ndarray, threshold: float, min_s: float, hop_s: float = HOP_S) -> list[tuple[float, float]]:
    """(start_s, end_s) of every run of frames below `threshold` lasting at least `min_s`."""
    mask = db < threshold
    out: list[tuple[float, float]] = []
    if not len(mask):
        return out
    padded = np.concatenate([[False], mask, [False]])
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    for a, b in zip(edges[::2], edges[1::2], strict=True):
        if (b - a) * hop_s >= min_s - 1e-9:
            out.append((round(float(a) * hop_s, 3), round(float(b) * hop_s, 3)))
    return out


@dataclass
class SilenceMap:
    """Loudness-derived dual-threshold silence map. Thresholds are applied to the envelope as if the
    clip were normalised to `target_lufs`, then clamped above the room floor so quiet recordings still work."""

    strict_db: float
    broad_db: float
    gain_db: float
    floor_db: float
    speech_db: float
    loudness: Loudness | None
    strict: list[tuple[float, float]] = field(default_factory=list)
    broad: list[tuple[float, float]] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "strictDb": round(self.strict_db, 2),
            "broadDb": round(self.broad_db, 2),
            "gainDb": round(self.gain_db, 2),
            "floorDb": round(self.floor_db, 2),
            "speechDb": round(self.speech_db, 2),
            "loudness": self.loudness.to_json() if self.loudness else None,
            "strict": [{"start": a, "end": b} for a, b in self.strict],
            "broad": [{"start": a, "end": b} for a, b in self.broad],
        }


@dataclass
class SilenceOptions:
    strict_db: float = -42.0
    broad_db: float = -35.0
    strict_min_s: float = 0.12
    broad_min_s: float = 0.12
    # The broad detector runs on a smoothed (50 ms) envelope: brief dips inside words average out, and its
    # edges sit a little inside the strict ones, which keeps word tails and onsets safe.
    broad_window_s: float = 0.05
    target_lufs: float | None = -14.0
    floor_margin_db: float = 3.0


def silence_map(x: np.ndarray, sr: int, loud: Loudness | None, opts: SilenceOptions) -> tuple[SilenceMap, np.ndarray]:
    """Returns the map plus the normalised 10 ms envelope (used for tail/onset refinement)."""
    gain = 0.0
    if opts.target_lufs is not None and loud is not None and loud.integrated > -69:
        gain = opts.target_lufs - loud.integrated
    db = envelope_db(x, sr) + gain
    db_broad = envelope_db(x, sr, win_s=opts.broad_window_s) + gain
    lv = levels(db)
    strict_thr = max(opts.strict_db, lv.floor_db + opts.floor_margin_db)
    broad_thr = max(opts.broad_db, strict_thr + 1.0)
    sm = SilenceMap(
        strict_db=strict_thr,
        broad_db=broad_thr,
        gain_db=gain,
        floor_db=lv.floor_db,
        speech_db=lv.speech_db,
        loudness=loud,
        strict=runs_below(db, strict_thr, opts.strict_min_s),
        broad=runs_below(db_broad, broad_thr, opts.broad_min_s),
    )
    return sm, db


# ---------------------------------------------------------------------------------------------------------
# Dead-air measure (QC and cut-plan estimate). Quiet = below max(speech mean - 18 dB, room floor + 3 dB),
# measured on the real waveform, never on word timestamps.
# ---------------------------------------------------------------------------------------------------------


@dataclass
class GapReport:
    duration_s: float
    speech_db: float
    floor_db: float
    quiet_db: float
    count: int
    p50: float
    p90: float
    max: float
    over: list[tuple[float, float]]
    lead_s: float
    tail_s: float

    def to_json(self) -> dict:
        return {
            "durationS": round(self.duration_s, 3),
            "levels": {
                "speechDb": round(self.speech_db, 1),
                "floorDb": round(self.floor_db, 1),
                "quietBelowDb": round(self.quiet_db, 1),
            },
            "count": self.count,
            "p50S": self.p50,
            "p90S": self.p90,
            "maxS": self.max,
            "overLimit": [{"at": s, "durS": d} for s, d in self.over],
            "leadS": self.lead_s,
            "tailS": self.tail_s,
        }


def measure_gaps(
    db: np.ndarray,
    *,
    max_pause_s: float = 0.15,
    quiet_db_under_speech: float = 18.0,
    floor_margin_db: float = 3.0,
    min_quiet_s: float = 0.04,
    hop_s: float = HOP_S,
) -> GapReport:
    dur = len(db) * hop_s
    audible = db[db > -90]
    if len(audible) == 0:
        return GapReport(dur, -120, -120, -120, 0, 0.0, 0.0, 0.0, [], round(dur, 2), round(dur, 2))
    lv = levels(db)
    thr = max(lv.speech_db - quiet_db_under_speech, lv.floor_db + floor_margin_db)
    runs = [(a, b - a) for a, b in runs_below(db, thr, min_quiet_s, hop_s)]
    lead = next((d for s, d in runs if s <= 0.01), 0.0)
    tail = next((d for s, d in runs if s + d >= dur - 0.02), 0.0)
    inner = [(s, d) for s, d in runs if s > 0.01 and s + d < dur - 0.02]
    over = [(round(s, 2), round(d, 2)) for s, d in inner if d > max_pause_s + 1e-9]
    lens = sorted(round(d, 3) for _, d in inner) or [0.0]
    return GapReport(
        duration_s=dur,
        speech_db=lv.speech_db,
        floor_db=lv.floor_db,
        quiet_db=thr,
        count=len(inner),
        p50=lens[len(lens) // 2],
        p90=lens[min(len(lens) - 1, int(len(lens) * 0.9))],
        max=lens[-1],
        over=over,
        lead_s=round(lead, 3),
        tail_s=round(tail, 3),
    )
