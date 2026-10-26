"""Sound effects synthesised in code with numpy: whoosh, swipe, pop, riser, click, hit, ding, zoom, impact, glitch,
soft, tick. Nothing is sampled, so every sound is CC0 by construction and the repo ships no audio files. Each sound
reports its "land" sample (the moment the ear hears it hit) so a plan's `at` lines up with the cut or the graphic,
not the sound's start. Every use is re-pitched by up to ±1 semitone from its seed, so repeated sounds don't feel
copy-pasted. Deterministic: the same seed gives the same samples."""

from __future__ import annotations

import numpy as np

SR = 48000

# Peak level relative to the speech peak (the mix is loudness-normalised afterwards).
LEVEL = {
    "whoosh": 0.30,
    "swipe": 0.24,
    "pop": 0.32,
    "riser": 0.24,
    "click": 0.22,
    "hit": 0.60,
    "ding": 0.20,
    "zoom": 0.26,
    "impact": 0.45,
    "glitch": 0.16,
    "soft": 0.14,
    "tick": 0.18,
}


def _band_noise(
    rng: np.random.Generator, dur: float, f0: float, f1: float, width: float = 0.45, shape: str = "exp"
) -> np.ndarray:
    """Noise whose band centre moves f0 → f1 (or f0 → f1 → f0 for "arc"), by STFT-domain shaping."""
    n = int(dur * SR)
    block = 1024
    hop = block // 4
    win = np.hanning(block)
    out = np.zeros(n + block)
    freqs = np.fft.rfftfreq(block, 1 / SR)
    steps = max(1, (n - 1) // hop + 1)
    for k in range(steps):
        x = k * hop / max(1, n)
        fc = f0 + (f1 - f0) * np.sin(np.pi * x) if shape == "arc" else f0 * (f1 / f0) ** x
        spec = np.fft.rfft(rng.standard_normal(block) * win)
        bw = max(80.0, fc * width)
        spec *= np.exp(-0.5 * ((freqs - fc) / bw) ** 2)
        out[k * hop : k * hop + block] += np.fft.irfft(spec, block) * win
    return out[:n]


def _env(n: int, peak: float, a: float = 2.0, b: float = 2.0) -> np.ndarray:
    x = np.linspace(0, 1, n)
    return np.where(x < peak, (x / max(peak, 1e-6)) ** a, ((1 - x) / max(1 - peak, 1e-6)) ** b)


def _chirp(dur: float, f0: float, f1: float) -> np.ndarray:
    n = int(dur * SR)
    f = f0 * (f1 / f0) ** np.linspace(0, 1, n)
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def whoosh(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    d = 0.45
    s = _band_noise(rng, d, 300, 4200, 0.4) * _env(int(d * SR), 0.6)
    return s, int(0.6 * len(s))


def swipe(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    d = 0.18
    s = _band_noise(rng, d, 2200, 8500, 0.55) * _env(int(d * SR), 0.35, 1.5, 2.5)
    return s, int(0.35 * len(s))


def pop(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    f = 900 * np.exp(-t * 25) + 280
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 35)
    return s, 0


def riser(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    d = 0.9
    s = (_band_noise(rng, d, 400, 6000, 0.35) + 0.3 * _chirp(d, 110, 820)) * _env(int(d * SR), 0.97, 3.0, 1.0)
    return s, int(0.97 * len(s))


def click(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    n = int(0.03 * SR)
    nz = rng.standard_normal(n)
    hp = nz - np.convolve(nz, np.ones(8) / 8, mode="same")
    return hp * np.exp(-np.arange(n) / (0.003 * SR)), 0


def hit(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    n = int(0.6 * SR)
    t = np.arange(n) / SR
    f = 38 + 90 * np.exp(-t * 18)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6) * 0.6 + rng.standard_normal(n) * np.exp(-t * 90) * 0.25
    return s, 0


def ding(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    t = np.arange(int(0.45 * SR)) / SR
    s = (np.sin(2 * np.pi * 1760 * t) + 0.5 * np.sin(2 * np.pi * 2640 * t)) * np.exp(-t * 9)
    return s, 0


def zoom(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    """A short rising air sweep for punch-ins: lands at its end."""
    d = 0.32
    s = _band_noise(rng, d, 500, 5200, 0.35) * _env(int(d * SR), 0.85, 2.0, 1.2) + 0.15 * _chirp(d, 220, 660) * _env(
        int(d * SR), 0.85
    )
    return s, int(0.85 * len(s))


def impact(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    """A deep thud with a noisy transient (lighter than `hit`)."""
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 52 + 70 * np.exp(-t * 22)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
    snap = _band_noise(rng, 0.45, 1800, 900, 0.8) * np.exp(-t * 60)
    return 0.8 * body + 0.4 * snap, 0


def glitch(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    """Bit-crushed, gated noise bursts."""
    n = int(0.22 * SR)
    x = rng.standard_normal(n)
    hold = 24
    x = np.repeat(x[::hold], hold)[:n]  # sample-and-hold
    gate = (np.sin(2 * np.pi * 38 * np.arange(n) / SR) > -0.2).astype(float)
    return np.round(x * gate * 4) / 4 * np.exp(-np.arange(n) / (0.12 * SR)), 0


def soft(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    """A very soft, low swish for quiet transitions."""
    d = 0.4
    return _band_noise(rng, d, 250, 1400, 0.5) * _env(int(d * SR), 0.5, 2.5, 2.5), int(0.5 * d * SR)


def tick(rng: np.random.Generator) -> tuple[np.ndarray, int]:
    """A woody tick (for counters and list beats)."""
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * 1900 * t) * np.exp(-t * 140) + 0.3 * rng.standard_normal(n) * np.exp(-t * 400)
    return s, 0


SYNTHS = {
    "whoosh": whoosh,
    "swipe": swipe,
    "pop": pop,
    "riser": riser,
    "click": click,
    "hit": hit,
    "ding": ding,
    "zoom": zoom,
    "impact": impact,
    "glitch": glitch,
    "soft": soft,
    "tick": tick,
}


def synth(kind: str, seed: int = 0) -> tuple[np.ndarray, int]:
    """Peak-normalised to LEVEL[kind]; returns (samples float32 at 48 kHz, land index)."""
    rng = np.random.default_rng(seed)
    s, land = SYNTHS[kind](rng)
    s = np.asarray(s, np.float64)
    # ±1 semitone re-pitch per seed (resampling), so a repeated sound never sounds pasted.
    ratio = 2 ** (rng.uniform(-1.0, 1.0) / 12)
    if abs(ratio - 1) > 1e-3 and len(s) > 8:
        idx = np.arange(0, len(s) - 1, ratio)
        s = np.interp(idx, np.arange(len(s)), s)
        land = min(len(s) - 1, round(land / ratio))
    # 2 ms fade at both ends (no clicks at the sound's edges), then level the peak
    k = int(0.002 * SR)
    if len(s) > 2 * k:
        ramp = np.linspace(0, 1, k)
        s[:k] *= ramp
        s[-k:] *= ramp[::-1]
    peak = np.abs(s).max() or 1.0
    s = s / peak * LEVEL[kind]
    return s.astype(np.float32), land
