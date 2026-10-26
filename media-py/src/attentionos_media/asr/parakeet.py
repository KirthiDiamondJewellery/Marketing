"""Parakeet TDT engine through sherpa-onnx (optional `parakeet` extra). Long audio is decoded in ≤25 s windows
split at quiet points so the model stays fast; token timestamps are joined into words."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from ..audio import envelope_db
from ..errors import MediaError
from ..models import artifact_path, installed
from ..schemas import Word
from . import ASR_SR, AsrInput, missing_model


def _windows(audio: np.ndarray, max_s: float = 25.0) -> list[tuple[int, int]]:
    """Split at the quietest 10 ms frame in the last 5 s of each window."""
    db = envelope_db(audio, ASR_SR)
    hop = ASR_SR // 100
    out, start = [], 0
    n = len(audio)
    while n - start > max_s * ASR_SR:
        lo = start + int((max_s - 5) * ASR_SR)
        hi = start + int(max_s * ASR_SR)
        seg = db[lo // hop : hi // hop]
        cut = lo + int(np.argmin(seg)) * hop if len(seg) else hi
        out.append((start, cut))
        start = cut
    out.append((start, n))
    return out


def transcribe_parakeet(audio: np.ndarray, inp: AsrInput) -> tuple[list[Word], str]:
    try:
        import sherpa_onnx  # type: ignore[import-not-found]
    except ImportError:
        raise MediaError(
            "asr_engine_missing", "The Parakeet engine is not installed.", "Run `uv sync --extra parakeet` in media-py."
        ) from None
    name = inp.model or "parakeet-v2"
    root = Path(inp.cache_dir).expanduser() if inp.cache_dir else None
    if not installed(name, root):
        raise missing_model(name)
    d = artifact_path(name, root)
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(d / "encoder.int8.onnx"),
        decoder=str(d / "decoder.int8.onnx"),
        joiner=str(d / "joiner.int8.onnx"),
        tokens=str(d / "tokens.txt"),
        model_type="nemo_transducer",
        num_threads=inp.threads or max(1, (os.cpu_count() or 2) - 1),
    )
    words: list[Word] = []
    for a, b in _windows(audio):
        st = rec.create_stream()
        st.accept_waveform(ASR_SR, audio[a:b])
        rec.decode_stream(st)
        res = st.result
        offset = a / ASR_SR
        toks, stamps = list(res.tokens), list(res.timestamps)
        durs = list(getattr(res, "durations", []) or [])
        for i, (tok, ts) in enumerate(zip(toks, stamps, strict=False)):
            t = float(ts) + offset
            end = t + (float(durs[i]) if i < len(durs) else 0.08)
            if tok.startswith(" ") or not words or (i == 0):
                if tok.strip():
                    words.append(Word(text=tok.strip(), start=t, end=end))
            else:
                last = words[-1]
                words[-1] = Word(text=last.text + tok, start=last.start, end=max(last.end, end))
    # Without token durations, end each word where the next begins (capped).
    for i in range(len(words) - 1):
        if words[i].end > words[i + 1].start:
            words[i] = Word(text=words[i].text, start=words[i].start, end=words[i + 1].start)
    return words, inp.language or ("en" if name == "parakeet-v2" else "auto")
