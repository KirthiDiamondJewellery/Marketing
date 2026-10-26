"""`asr`: word-level transcription. Engines:

- `whispercpp` (default): whisper.cpp through the `pywhispercpp` wheels (install the `asr` extra), or the
  `whisper-cli` binary when it is on PATH (e.g. `brew install whisper-cpp`). Models come from `models download`.
- `parakeet`: Parakeet TDT through sherpa-onnx (install the `parakeet` extra).
- `stub`: returns fixed words from the input or `$ATTENTIONOS_ASR_STUB` (a JSON file). For tests and demos.

Every engine returns `{language, text, words[{text, start, end, confidence?}], durationS}` with times in seconds
of the input media.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import Field

from ..errors import BadInput, MediaError, NotFound
from ..ffmpeg import decode_audio, log
from ..schemas import Transcript, Wire, Word

ASR_SR = 16000


class AsrInput(Wire):
    path: str
    engine: Literal["whispercpp", "parakeet", "stub"] = "whispercpp"
    model: str | None = None
    language: str | None = None
    prompt: str | None = None
    cache_dir: str | None = None
    threads: int | None = Field(default=None, ge=1, le=64)
    stub_words: list[Word] | None = None


def transcribe(payload: dict) -> dict:
    inp = AsrInput.model_validate(payload)
    if not Path(inp.path).exists():
        raise NotFound("Media file", inp.path)
    if inp.engine == "stub" or os.environ.get("ATTENTIONOS_ASR_STUB"):
        return stub(inp).dump()
    audio = decode_audio(inp.path, ASR_SR)
    duration = len(audio) / ASR_SR
    if duration == 0:
        return Transcript(language=inp.language or "en", text="", words=[], duration_s=0).dump()
    log(f"Transcribing {Path(inp.path).name} ({duration:.0f}s) with {inp.engine}")
    if inp.engine == "parakeet":
        from .parakeet import transcribe_parakeet

        words, lang = transcribe_parakeet(audio, inp)
    else:
        from .whispercpp import transcribe_whisper

        words, lang = transcribe_whisper(audio, inp)
    words = clean_words(words, duration)
    return Transcript(
        language=lang, text=" ".join(w.text for w in words), words=words, duration_s=round(duration, 3)
    ).dump()


def stub(inp: AsrInput) -> Transcript:
    """Fixed word timings: from the input, or from the JSON file named by $ATTENTIONOS_ASR_STUB."""
    words = inp.stub_words
    if words is None:
        src = os.environ.get("ATTENTIONOS_ASR_STUB")
        if not src:
            raise BadInput("The stub engine needs stubWords or $ATTENTIONOS_ASR_STUB.")
        data = json.loads(Path(src).read_text())
        raw = data.get("words", data) if isinstance(data, dict) else data
        words = [Word.model_validate(w) for w in raw]
    duration = len(decode_audio(inp.path, ASR_SR)) / ASR_SR
    words = clean_words(list(words), duration or None)
    return Transcript(
        language=inp.language or "en", text=" ".join(w.text for w in words), words=words, duration_s=round(duration, 3)
    )


def clean_words(words: list[Word], duration: float | None) -> list[Word]:
    """Sorted, non-overlapping, inside the media, no empty tokens."""
    out: list[Word] = []
    for w in sorted(words, key=lambda w: w.start):
        text = w.text.strip()
        if not text or text in {"[BLANK_AUDIO]", "[MUSIC]", "(music)"}:
            continue
        start, end = max(0.0, w.start), max(w.start, w.end)
        if duration:
            start, end = min(start, duration), min(end, duration)
        if out and start < out[-1].end:
            start = out[-1].end
        end = max(end, start + 0.01)
        out.append(Word(text=text, start=round(start, 3), end=round(end, 3), confidence=w.confidence))
    return out


def write_temp_wav(audio) -> str:
    from ..ffmpeg import write_wav

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    write_wav(path, audio, ASR_SR)
    return path


def missing_model(name: str) -> MediaError:
    return MediaError(
        "model_missing",
        f"The speech model '{name}' is not downloaded yet.",
        f'Run `attentionos doctor --fix` or `attentionos-media models download` with {{"name": "{name}"}} (about 500 MB, one time).',
    )
