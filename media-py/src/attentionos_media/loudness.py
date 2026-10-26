"""Loudness in numpy/scipy: ITU-R BS.1770-4 integrated loudness (K-weighting, 400 ms blocks, absolute and relative
gates), true peak by 4x oversampling, and a look-ahead true-peak limiter.

The render normalises its own mix with this meter, so `finish` usually only has to confirm the result (one fast
measurement and a stream copy) instead of running ffmpeg's two-pass loudnorm. The numbers agree with ffmpeg's
`ebur128`/`loudnorm` meters to within about 0.2 LU; QC still measures the real file with ffmpeg.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache

import numpy as np


@cache
def _k_weighting(sr: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """The two BS.1770 pre-filters (high shelf + RLB high-pass), designed for any sample rate."""
    # Stage 1: high shelf (+4 dB above ~1.7 kHz).
    f0, g, q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = np.tan(np.pi * f0 / sr)
    vh = 10 ** (g / 20)
    vb = vh**0.4996667741545416
    a0 = 1 + k / q + k * k
    b1 = np.array([(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0])
    a1 = np.array([1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0])
    # Stage 2: RLB high-pass (~38 Hz).
    f0, q = 38.13547087602444, 0.5003270373238773
    k = np.tan(np.pi * f0 / sr)
    a0 = 1 + k / q + k * k
    b2 = np.array([1.0, -2.0, 1.0])
    a2 = np.array([1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0])
    return b1, a1, b2, a2


def _as_channels(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, np.float64)
    return x[:, None] if x.ndim == 1 else x


def integrated_lufs(x: np.ndarray, sr: int) -> float:
    """Gated integrated loudness (LUFS) of mono [n] or multichannel [n, ch] audio. −70 for silence."""
    from scipy.signal import lfilter

    ch = _as_channels(x)
    if len(ch) < int(0.4 * sr):
        return -70.0
    b1, a1, b2, a2 = _k_weighting(sr)
    y = lfilter(b2, a2, lfilter(b1, a1, ch, axis=0), axis=0)
    block, hop = int(0.4 * sr), int(0.1 * sr)
    n = 1 + (len(y) - block) // hop
    # Mean square per 400 ms block (75% overlap) via a cumulative sum: O(n), no Python loop.
    c = np.cumsum(np.concatenate([np.zeros((1, y.shape[1])), y**2]), axis=0)
    starts = np.arange(n) * hop
    ms = (c[starts + block] - c[starts]) / block  # [n, ch]
    z = ms.sum(axis=1)  # channel weights are 1.0 for L/R/C
    lk = -0.691 + 10 * np.log10(z + 1e-20)
    gated = z[lk > -70]
    if not len(gated):
        return -70.0
    rel = -0.691 + 10 * np.log10(gated.mean()) - 10
    final = z[(lk > -70) & (lk > rel)]
    return float(-0.691 + 10 * np.log10(final.mean())) if len(final) else -70.0


def loudness_range(x: np.ndarray, sr: int) -> float:
    """EBU Tech 3342 loudness range (LU): spread (10th to 95th percentile) of 3 s short-term loudness, gated."""
    from scipy.signal import lfilter

    ch = _as_channels(x)
    block, hop = int(3.0 * sr), int(0.1 * sr)
    if len(ch) < block:
        return 0.0
    b1, a1, b2, a2 = _k_weighting(sr)
    y = lfilter(b2, a2, lfilter(b1, a1, ch, axis=0), axis=0)
    c = np.cumsum(np.concatenate([np.zeros((1, y.shape[1])), y**2]), axis=0)
    starts = np.arange(1 + (len(y) - block) // hop) * hop
    z = ((c[starts + block] - c[starts]) / block).sum(axis=1)
    st = -0.691 + 10 * np.log10(z + 1e-20)
    st = st[st > -70]
    if not len(st):
        return 0.0
    rel = -0.691 + 10 * np.log10(np.mean(10 ** ((st + 0.691) / 10))) - 20
    st = st[st > rel]
    return float(np.percentile(st, 95) - np.percentile(st, 10)) if len(st) > 1 else 0.0


def measure(x: np.ndarray, sr: int) -> dict:
    """{integratedLufs, truePeakDbtp, lraLu} in the same shape as the ffmpeg meter's report."""
    return {
        "integratedLufs": round(integrated_lufs(x, sr), 2),
        "truePeakDbtp": round(true_peak_db(x, sr), 2),
        "lraLu": round(loudness_range(x, sr), 2),
    }


def true_peak_db(x: np.ndarray, sr: int, oversample: int = 4) -> float:
    """dBTP: the sample peak after 4x polyphase oversampling (BS.1770 Annex 2)."""
    from scipy.signal import resample_poly

    ch = _as_channels(x)
    if not len(ch):
        return -120.0
    up = resample_poly(ch, oversample, 1, axis=0) if sr < 96000 else ch
    peak = float(np.abs(up).max())
    return 20 * np.log10(peak + 1e-12)


@dataclass
class LoudnessResult:
    integrated: float
    true_peak: float
    gain_db: float
    limited_db: float  # gain reduction the limiter applied at its deepest point (0 = untouched)

    def to_json(self) -> dict:
        return {
            "integratedLufs": round(self.integrated, 2),
            "truePeakDbtp": round(self.true_peak, 2),
            "gainDb": round(self.gain_db, 2),
            "limiterDb": round(self.limited_db, 2),
        }


def limit(
    x: np.ndarray, sr: int, ceiling_db: float, lookahead_s: float = 0.005, release_s: float = 0.08
) -> tuple[np.ndarray, float]:
    """Look-ahead peak limiter on the 4x-oversampled envelope: gain never lets a true peak exceed `ceiling_db`.
    Gain changes are smoothed (instant attack inside the look-ahead window, exponential release), so it is
    transparent on the few peaks a speech mix has. Returns (audio, deepest gain reduction in dB)."""
    from scipy.ndimage import maximum_filter1d
    from scipy.signal import resample_poly

    ch = _as_channels(x)
    ceiling = 10 ** (ceiling_db / 20)
    env = np.abs(resample_poly(ch, 4, 1, axis=0)).max(axis=1)
    env = env[: len(env) // 4 * 4].reshape(-1, 4).max(axis=1)
    env = np.pad(env, (0, max(0, len(ch) - len(env))))[: len(ch)]
    if env.max(initial=0.0) <= ceiling:
        return x, 0.0
    look = max(1, int(lookahead_s * sr))
    need = np.minimum(1.0, ceiling / np.maximum(env, 1e-9))
    # The gain must already be down when the peak arrives: take the minimum over the look-ahead window.
    g = -maximum_filter1d(-need, size=2 * look + 1, mode="nearest")
    # Release smoothing (a one-pole filter on the gain, fast because it runs on a 1 ms control grid).
    hop = max(1, sr // 1000)
    ctrl = g[: len(g) // hop * hop].reshape(-1, hop).min(axis=1) if len(g) >= hop else g
    coef = float(np.exp(-1.0 / max(1.0, release_s * 1000)))
    # Attack instantly, release with a one-pole filter (~1000 control steps per second of audio).
    sm = np.empty_like(ctrl)
    prev = 1.0
    for i, t in enumerate(ctrl.tolist()):
        prev = t if t < prev else coef * prev + (1 - coef) * t
        sm[i] = prev
    gain = np.repeat(sm, hop)
    gain = np.pad(gain, (0, max(0, len(ch) - len(gain))), mode="edge")[: len(ch)]
    out = ch * gain[:, None]
    return (out[:, 0] if np.asarray(x).ndim == 1 else out).astype(np.float32), float(20 * np.log10(sm.min()))


def normalize(
    x: np.ndarray, sr: int, target_lufs: float = -14.0, true_peak_max: float = -1.0
) -> tuple[np.ndarray, LoudnessResult]:
    """One linear gain to `target_lufs`, then the limiter keeps true peaks under `true_peak_max − 0.5` (headroom for
    the AAC encoder). Speech mixes almost never need more than a dB of limiting."""
    lufs = integrated_lufs(x, sr)
    if lufs <= -69:
        return x, LoudnessResult(lufs, true_peak_db(x, sr), 0.0, 0.0)
    gain = target_lufs - lufs
    y = (np.asarray(x, np.float64) * 10 ** (gain / 20)).astype(np.float32)
    y, red = limit(y, sr, true_peak_max - 0.5)
    return y, LoudnessResult(integrated_lufs(y, sr), true_peak_db(y, sr), gain, red)
