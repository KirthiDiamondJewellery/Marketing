from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from attentionos_media.testing import synth

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path_factory, monkeypatch):
    """Never touch the user's real model/font cache from tests (unless the opt-in ASR test asks for it)."""
    import os

    if not os.environ.get("ATTENTIONOS_TEST_ASR"):
        monkeypatch.setenv("ATTENTIONOS_CACHE_DIR", str(tmp_path_factory.getbasetemp() / "cache"))
    monkeypatch.delenv("ATTENTIONOS_ASR_STUB", raising=False)


def make_clip(path: Path, script: list[dict], **kw) -> dict:
    return synth({"output": str(path), "script": script, **kw})


def sentence(words: str, word_dur: float = 0.28) -> list[dict]:
    return [{"word": w, "dur": word_dur} for w in words.split()]


VOCAB = [
    "we",
    "tested",
    "this",
    "on",
    "real",
    "numbers",
    "and",
    "the",
    "result",
    "surprised",
    "everyone",
    "who",
    "saw",
    "first",
    "draft",
    "today",
    "most",
    "teams",
    "skip",
    "step",
    "because",
    "it",
    "feels",
    "slow",
    "but",
    "measuring",
    "once",
    "saves",
    "hours",
    "later",
    "here",
    "is",
    "exactly",
    "how",
    "simple",
    "setup",
    "works",
    "start",
    "small",
    "write",
    "every",
    "change",
    "down",
    "then",
    "compare",
    "weekly",
    "totals",
    "against",
    "your",
    "baseline",
    "notice",
    "which",
    "habit",
    "moved",
    "needle",
    "keep",
    "doing",
    "that",
    "drop",
    "rest",
    "repeat",
    "next",
    "month",
    "until",
    "gains",
    "stop",
    "showing",
    "up",
    "clearly",
    "enough",
]


def talk_script(n_sentences: int, pause: float = 0.7) -> list[dict]:
    """A talking-head-like script: distinct sentences of 6–9 words with pauses between them (no repeated lines,
    so retake detection leaves them alone)."""
    script: list[dict] = []
    pos = 0
    for i in range(n_sentences):
        n = 6 + i % 4
        for k in range(n):
            w = VOCAB[pos % len(VOCAB)] + ("" if pos < len(VOCAB) else str(pos // len(VOCAB)))
            pos += 1
            script.append({"word": w + ("." if k == n - 1 else ""), "dur": 0.24 + 0.04 * ((i + k) % 3)})
            if k == 2 and i % 3 == 1:
                script.append({"pause": 0.06})  # a natural tiny gap inside a sentence
        script.append({"pause": pause + 0.1 * (i % 3)})
    return script


def run_cli(cmd: list[str], payload: dict | None = None, timeout: float = 120) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, "-m", "attentionos_media", *cmd],
        input=json.dumps(payload or {}),
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=ROOT,
    )
    return proc.returncode, json.loads(proc.stdout)
