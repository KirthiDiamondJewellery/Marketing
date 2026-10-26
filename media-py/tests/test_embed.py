from __future__ import annotations

import hashlib
import os
import sys
import types
from typing import ClassVar

import numpy as np
import pytest

from attentionos_media import embed as embed_mod
from attentionos_media.embed import DEFAULT_EMBED_MODEL, EMBED_MODELS, embed
from attentionos_media.errors import MediaError
from attentionos_media.models import models_command


class FakeTextEmbedding:
    """Stands in for fastembed.TextEmbedding: deterministic unit vectors, no download, no ONNX."""

    instances: ClassVar[list[FakeTextEmbedding]] = []

    def __init__(self, model_name: str, cache_dir: str | None = None, **kwargs):
        if model_name.startswith("nope/"):
            raise ValueError("Model nope/x is not supported")
        self.model_name = model_name
        self.cache_dir = cache_dir
        self.kwargs = kwargs
        self.seen: list[str] = []
        FakeTextEmbedding.instances.append(self)

    def embed(self, texts, batch_size: int = 256):
        for t in texts:
            self.seen.append(t)
            seed = int.from_bytes(hashlib.sha256(t.encode()).digest()[:4], "little")
            v = np.random.default_rng(seed).standard_normal(384).astype(np.float32)
            yield v / np.linalg.norm(v)


@pytest.fixture
def fake_fastembed(monkeypatch):
    real = os.environ.get("ATTENTIONOS_TEST_EMBED")
    if real:  # opt-in: exercise the real model (downloads ~70 MB once)
        yield None
        return
    mod = types.ModuleType("fastembed")
    mod.TextEmbedding = FakeTextEmbedding  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "fastembed", mod)
    monkeypatch.setattr(embed_mod, "_ENCODERS", {})
    FakeTextEmbedding.instances.clear()
    yield FakeTextEmbedding


def test_embed_returns_model_dim_and_one_vector_per_text(fake_fastembed):
    out = embed({"texts": ["how to price a kitchen remodel", "", "permits take six weeks"]})
    assert out["model"] == DEFAULT_EMBED_MODEL
    assert out["dim"] == 384
    assert len(out["vectors"]) == 3 and all(len(v) == 384 for v in out["vectors"])
    norms = [float(np.linalg.norm(v)) for v in out["vectors"]]
    assert all(abs(n - 1) < 1e-3 for n in norms)
    # deterministic, and the encoder is loaded once per process
    again = embed({"texts": ["how to price a kitchen remodel"]})
    assert again["vectors"][0] == out["vectors"][0]
    if fake_fastembed:
        assert len(fake_fastembed.instances) == 1
        assert fake_fastembed.instances[0].cache_dir.endswith("embed")


def test_query_kind_adds_the_bge_instruction(fake_fastembed):
    if not fake_fastembed:
        pytest.skip("checks the fake encoder's inputs")
    embed({"texts": ["pricing"], "kind": "query"})
    embed({"texts": ["pricing"], "kind": "document"})
    seen = fake_fastembed.instances[0].seen
    assert seen[0].startswith("Represent this sentence") and seen[0].endswith("pricing")
    assert seen[1] == "pricing"


def test_empty_input_needs_no_model(monkeypatch):
    monkeypatch.setitem(sys.modules, "fastembed", None)  # import would fail
    assert embed({"texts": []}) == {"model": DEFAULT_EMBED_MODEL, "dim": 384, "vectors": []}


def test_missing_extra_is_a_plain_error(monkeypatch):
    monkeypatch.setitem(sys.modules, "fastembed", None)
    monkeypatch.setattr(embed_mod, "_ENCODERS", {})
    with pytest.raises(MediaError) as err:
        embed({"texts": ["hello"]})
    assert err.value.code == "embed_engine_missing" and "uv sync --extra embed" in (err.value.fix or "")


def test_offline_without_cached_model_fails_cleanly(fake_fastembed):
    with pytest.raises(MediaError) as err:
        embed({"texts": ["hello"], "allowDownload": False})
    assert err.value.code == "model_missing"


def test_unknown_model_is_bad_input(fake_fastembed):
    if not fake_fastembed:
        pytest.skip("uses the fake encoder")
    with pytest.raises(MediaError) as err:
        embed({"texts": ["hello"], "model": "nope/x"})
    assert err.value.code == "bad_input"


def test_models_list_and_path_include_the_embedding_model(tmp_path):
    listing = models_command("list", {"cacheDir": str(tmp_path)})
    entry = next(m for m in listing["models"] if m["name"] == f"embed:{DEFAULT_EMBED_MODEL}")
    assert entry["kind"] == "embed" and not entry["installed"] and entry["license"] == "MIT"
    paths = models_command("path", {"cacheDir": str(tmp_path), "name": "embed"})["paths"]
    assert paths["embed"]["path"].endswith("embed") and paths["embed"]["installed"] is False
    assert EMBED_MODELS[DEFAULT_EMBED_MODEL][0] == 384


def test_models_download_embed_uses_the_cache(fake_fastembed, tmp_path):
    if not fake_fastembed:
        pytest.skip("uses the fake encoder")
    out = models_command("download", {"cacheDir": str(tmp_path), "name": "embed"})
    assert out["results"][0]["name"] == f"embed:{DEFAULT_EMBED_MODEL}"
    assert fake_fastembed.instances[-1].cache_dir == str(tmp_path / "embed")
