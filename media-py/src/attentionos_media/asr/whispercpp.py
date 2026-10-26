"""whisper.cpp engine. Prefers the `pywhispercpp` wheels (no compiler needed on macOS, Linux or Windows); falls back
to the `whisper-cli` binary when the wheel is not installed. Word timings come from whisper.cpp's token
timestamps with one word per segment (`max_len=1`, `split_on_word`)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from ..errors import MediaError
from ..models import DEFAULT_WHISPER, artifact_path, download, installed
from ..schemas import Word
from . import ASR_SR, AsrInput, missing_model, write_temp_wav


def _model_file(inp: AsrInput) -> Path:
    name = inp.model or os.environ.get("ATTENTIONOS_ASR_MODEL") or DEFAULT_WHISPER
    if Path(name).expanduser().is_file():  # a direct path to a ggml model
        return Path(name).expanduser()
    root = Path(inp.cache_dir).expanduser() if inp.cache_dir else None
    key = name if name.startswith("whisper-") else f"whisper-{name}"
    if not installed(key, root):
        # First use: fetch the model (checksum-verified, one time) unless the user turned that off.
        if os.environ.get("ATTENTIONOS_AUTO_DOWNLOAD_MODELS", "1") == "0":
            raise missing_model(key)
        try:
            download(key, root)
        except Exception as err:
            raise missing_model(key) from err
    return artifact_path(key, root)


def transcribe_whisper(audio: np.ndarray, inp: AsrInput) -> tuple[list[Word], str]:
    model = _model_file(inp)
    try:
        import pywhispercpp  # noqa: F401
    except ImportError:
        cli = shutil.which("whisper-cli") or shutil.which("whisper-cpp")
        if not cli:
            raise MediaError(
                "asr_engine_missing",
                "No whisper.cpp engine is installed.",
                "Run `uv sync --extra asr` in media-py (attentionos doctor --fix does this), or install whisper.cpp (`brew install whisper-cpp`).",
            ) from None
        return _whisper_cli(cli, audio, model, inp)
    return _pywhispercpp(audio, model, inp)


def _pywhispercpp(audio: np.ndarray, model: Path, inp: AsrInput) -> tuple[list[Word], str]:
    from pywhispercpp.model import Model

    threads = inp.threads or max(1, min(8, (os.cpu_count() or 2) - 1))
    params: dict = {
        "n_threads": threads,
        "print_progress": False,
        "print_realtime": False,
        "token_timestamps": True,
        "max_len": 1,
        "split_on_word": True,
        "language": (inp.language or "auto"),
    }
    if inp.prompt:
        params["initial_prompt"] = inp.prompt
    m = Model(str(model), redirect_whispercpp_logs_to=None, **params)
    segments = m.transcribe(audio.astype(np.float32), extract_probability=True)
    words: list[Word] = []
    for s in segments:
        text = s.text.strip()
        if not text:
            continue
        prob = float(s.probability) if s.probability == s.probability else None  # NaN check
        start, end = s.t0 / 100.0, s.t1 / 100.0
        # whisper.cpp sometimes emits punctuation as its own "word": glue it to the previous word.
        if words and all(not c.isalnum() for c in text):
            words[-1] = Word(
                text=words[-1].text + text,
                start=words[-1].start,
                end=max(words[-1].end, end),
                confidence=words[-1].confidence,
            )
            continue
        words.append(Word(text=text, start=start, end=end, confidence=prob))
    lang = inp.language or "en"
    try:
        import _pywhispercpp as pw  # type: ignore[import-not-found]

        lang = pw.whisper_lang_str(pw.whisper_full_lang_id(m._ctx)) or lang
    except Exception:  # language detection is best effort
        pass
    return words, lang


def _whisper_cli(cli: str, audio: np.ndarray, model: Path, inp: AsrInput) -> tuple[list[Word], str]:
    wav = write_temp_wav(audio)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            prefix = Path(tmp) / "out"
            cmd = [
                cli,
                "-m",
                str(model),
                "-f",
                wav,
                "-oj",
                "-ml",
                "1",
                "-sow",
                "-np",
                "-of",
                str(prefix),
                "-l",
                inp.language or "auto",
            ]
            if inp.threads:
                cmd += ["-t", str(inp.threads)]
            if inp.prompt:
                cmd += ["--prompt", inp.prompt]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                raise MediaError(
                    "asr_failed", "whisper-cli failed to transcribe the audio.", None, {"stderr": proc.stderr[-800:]}
                )
            data = json.loads(Path(f"{prefix}.json").read_text())
    finally:
        os.unlink(wav)
    words: list[Word] = []
    for seg in data.get("transcription", []):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        off = seg.get("offsets", {})
        start, end = off.get("from", 0) / 1000.0, off.get("to", 0) / 1000.0
        if words and all(not c.isalnum() for c in text):
            words[-1] = Word(text=words[-1].text + text, start=words[-1].start, end=max(words[-1].end, end))
            continue
        words.append(Word(text=text, start=start, end=end))
    lang = (data.get("result") or {}).get("language") or inp.language or "en"
    return words, lang


__all__ = ["ASR_SR", "transcribe_whisper"]
