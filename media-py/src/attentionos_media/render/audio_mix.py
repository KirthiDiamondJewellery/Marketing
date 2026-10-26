"""The render's audio, built in numpy at 48 kHz on the exact output frame grid (audio and video stay locked):

1. **Voice chain** on decode, every setting derived from measured levels: high-pass (rumble), FFT denoise
   (`afftdn`, strength from the speech-to-room-floor ratio; skipped on clean recordings), de-esser, and a gentle
   compressor run at a known operating point (the voice is pre-gained so speech sits at −20 dBFS).
2. **Cut speech**: keep ranges joined with an equal-power crossfade centred on every join (16 ms by default), so
   cuts never click and room tone never steps; outer edges get 4 ms fades.
3. **SFX**: synthesised sounds land on their `at` (plan entries plus code-placed ones on layout changes and
   punch-ins), gained relative to the voice.
4. **Music bed** (optional): level-matched under the voice and ducked by a sidechain envelope of the speech
   (50 ms attack, 350 ms release, −10 dB), faded out at the end.
5. **Loudness**: the mix is normalised to the plan's target (−14 LUFS) with a true-peak limiter (−1.5 dBTP), so
   `finish` usually only verifies it.

Also writes the speech-only stem that QC measures pauses on."""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path

import numpy as np

from ..audio import envelope_db, levels
from ..errors import MediaError
from ..ffmpeg import decode_audio, has_filter, write_wav
from ..loudness import LoudnessResult, normalize
from ..schemas import AudioPlan, VoiceChain
from ..timemap import TimeMap
from .sfx import synth

SR = 48000
FADE = int(0.004 * SR)


@dataclass
class MixResult:
    mix: np.ndarray  # stereo [n, 2]
    speech: np.ndarray  # mono [n]
    warnings: list[str]
    voice_chain: str = ""
    loudness: LoudnessResult | None = None
    sfx: list[dict] = field(default_factory=list)


def voice_filter(voice: VoiceChain, x: np.ndarray) -> str:
    """The ffmpeg audio chain for the voice, from levels measured on the raw recording."""
    if not len(x):
        return ""
    db = envelope_db(x, SR)
    lv = levels(db)
    if lv.speech_db < -80:
        return ""
    parts: list[str] = []
    if voice.highpass_hz > 0:
        parts.append(f"highpass=f={voice.highpass_hz:g}:poles=2")
    # Room floor over ALL frames (digital silence counts as a clean room), not just the audible ones.
    floor = float(np.percentile(db, 5)) if len(db) else lv.floor_db
    snr = lv.speech_db - floor
    nr = {"off": 0.0, "light": 8.0, "strong": 18.0}.get(voice.denoise)
    if nr is None:  # auto: clean recordings, and ones with no pause to measure the room on, are left alone
        nr = 0.0 if snr >= 48 or snr < 18 else (8.0 if snr >= 36 else 14.0)
    if nr > 0 and has_filter("afftdn"):
        nf = max(-80.0, min(-20.0, floor + 2.0))
        parts.append(f"afftdn=nr={nr:g}:nf={nf:.1f}:tn=1")
    if voice.deess and has_filter("deesser"):
        parts.append("deesser=i=0.35:m=0.5:f=0.5:s=o")
    if voice.compress and has_filter("acompressor"):
        pre = max(-12.0, min(24.0, -20.0 - lv.speech_db))
        parts.append(f"volume={pre:.2f}dB")
        parts.append("acompressor=threshold=0.126:ratio=2.5:attack=8:release=120:knee=4:makeup=1")
    return ",".join(parts)


def cut_speech(x: np.ndarray, tm: TimeMap, crossfade_ms: float = 16.0) -> np.ndarray:
    spf = SR / tm.fps
    total = round(tm.output_frames * spf)
    out = np.zeros(total, np.float32)
    if not len(x):
        return out
    ramp = np.linspace(0.0, 1.0, FADE, dtype=np.float32)
    half = int(crossfade_ms / 1000 * SR) // 2

    def take(a: int, b: int) -> np.ndarray:
        seg = x[max(0, a) : max(0, b)]
        if a < 0:
            seg = np.concatenate([np.zeros(-a, np.float32), seg])
        return np.pad(seg, (0, max(0, (b - a) - len(seg))))

    keeps = tm.keeps
    for i, k in enumerate(keeps):
        a, b = round(k.src_start * spf), round(k.src_end * spf)
        o = round(k.out_start * spf)
        piece = take(a, b).copy()
        if len(piece) > 2 * FADE:
            if k.src_start > 0 and (i == 0 or half == 0):
                piece[:FADE] *= ramp
            if k.src_end < tm.source_frames and (i == len(keeps) - 1 or half == 0):
                piece[-FADE:] *= ramp[::-1]
        n = min(len(piece), total - o)
        out[o : o + n] = piece[:n]
    if half > 0:
        theta = np.linspace(0.0, np.pi / 2, 2 * half, dtype=np.float32)
        fo, fi = np.cos(theta), np.sin(theta)
        for prev, nxt in pairwise(keeps):
            o = round(nxt.out_start * spf)
            if o - half < 0 or o + half > total:
                continue
            e, s = round(prev.src_end * spf), round(nxt.src_start * spf)
            # Pieces shorter than the window keep their hard join.
            if (prev.length * spf) < 2 * half or (nxt.length * spf) < 2 * half:
                continue
            out[o - half : o + half] = take(e - half, e + half) * fo + take(s - half, s + half) * fi
    return out


def _duck_gain(
    speech: np.ndarray, depth_db: float = -10.0, attack_s: float = 0.05, release_s: float = 0.35
) -> np.ndarray:
    hop = int(0.01 * SR)
    db = envelope_db(speech, SR, 0.01, win_s=0.03)
    lv = levels(db)
    active = (db > max(lv.speech_db - 20.0, lv.floor_db + 6.0)).astype(np.float64)
    g = np.empty_like(active)
    a_coef, r_coef = np.exp(-0.01 / attack_s), np.exp(-0.01 / release_s)
    y = 0.0
    for i, v in enumerate(active):  # one-pole smoother on a 100 Hz control signal
        c = a_coef if v > y else r_coef
        y = c * y + (1 - c) * v
        g[i] = y
    gain_db = depth_db * g
    per_sample = np.repeat(10 ** (gain_db / 20), hop)
    if len(per_sample) < len(speech):
        per_sample = np.pad(per_sample, (0, len(speech) - len(per_sample)), mode="edge")
    return per_sample[: len(speech)].astype(np.float32)


def mix(
    source: str,
    tm: TimeMap,
    plan: AudioPlan,
    assets: dict[str, str],
    seed: int = 7,
    extra_sfx: list[tuple[str, float]] | None = None,
) -> MixResult:
    warnings: list[str] = []
    raw = decode_audio(source, SR)
    chain = voice_filter(plan.voice, raw)
    voice = raw
    if chain:
        try:
            voice = decode_audio(source, SR, af=chain)
        except MediaError:
            voice = np.zeros(0, np.float32)
        if len(voice) < 0.9 * len(raw):
            voice, chain = raw, ""
            warnings.append("The voice clean-up filters failed on this file; the raw voice is used.")
    speech = cut_speech(voice, tm, plan.crossfade_ms)
    n = len(speech)
    out = speech.astype(np.float64).copy()
    speech_peak = float(np.percentile(np.abs(speech), 99.9)) if n else 0.0
    ref = speech_peak if speech_peak > 1e-4 else 0.25
    events = [(fx.kind, fx.at, fx.gain_db, "plan") for fx in plan.sfx]
    events += [(k, at, -3.0, "auto") for k, at in (extra_sfx or [])]
    placed: list[dict] = []
    for i, (kind, at, gain_db, origin) in enumerate(sorted(events, key=lambda e: e[1])):
        s, land = synth(kind, seed + i)
        s = s * ref / 0.5 * (10 ** (gain_db / 20))
        start = round(at * SR) - land
        a, b = max(0, start), min(n, start + len(s))
        if b <= a:
            warnings.append(f"Sound effect '{kind}' at {at:.2f}s falls outside the video; skipped.")
            continue
        out[a:b] += s[a - start : b - start]
        placed.append({"kind": kind, "at": round(at, 3), "origin": origin})
    if plan.music is not None:
        path = assets.get(plan.music.asset_id)
        if not path or not Path(path).exists():
            raise MediaError(
                "asset_missing",
                "The music bed's file is missing.",
                "Re-attach the music asset or remove music from the plan.",
            )
        m = decode_audio(path, SR)
        if len(m) == 0:
            warnings.append("The music file has no audio; skipped.")
        else:
            reps = int(np.ceil(n / len(m)))
            m = np.tile(m, reps)[:n].astype(np.float64)
            sp_db = levels(envelope_db(speech, SR)).speech_db if n else -20.0
            m_db = 10 * np.log10(np.mean(m**2) + 1e-12)
            m *= 10 ** ((sp_db + plan.music.gain_db - m_db) / 20)
            if plan.music.duck:
                m *= _duck_gain(speech)
            fade = min(n, int(0.8 * SR))
            if fade:
                m[-fade:] *= np.linspace(1, 0, fade)
            out += m
    stereo = np.stack([out, out], axis=1).astype(np.float32)
    loud = None
    if n and np.abs(out).max() > 1e-5:
        stereo, loud = normalize(stereo, SR, plan.loudness, plan.true_peak)
    else:
        peak = float(np.abs(out).max()) if n else 0.0
        if peak > 0.98:
            stereo *= 0.98 / peak
    return MixResult(stereo, speech, warnings, chain, loud, placed)


def write_mix(res: MixResult, mix_path: Path, stem_path: Path) -> None:
    write_wav(mix_path, res.mix, SR)
    write_wav(stem_path, res.speech, SR)
