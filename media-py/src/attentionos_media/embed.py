"""`embed`: local text embeddings for the knowledge store (ADR-15). CPU only, no API key.

Input:  {"model"?: str, "texts": [str, ...], "kind"?: "document" | "query", "batchSize"?: int}
Output: {"model": str, "dim": int, "vectors": [[float, ...], ...]}

Uses fastembed (ONNX Runtime) from the optional `embed` extra. The default model is BAAI/bge-small-en-v1.5
(384 dimensions, MIT, about 70 MB). Models are cached under `<cache dir>/embed`, next to the speech models,
and are fetched on first use or ahead of time with `models download {"name": "embed"}`.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from pydantic import Field

from .errors import BadInput, MediaError
from .ffmpeg import log
from .schemas import Wire

DEFAULT_EMBED_MODEL = "BAAI/bge-small-en-v1.5"

# Known local models: name -> (dim, license, approx MB). Any other fastembed text model also works.
EMBED_MODELS: dict[str, tuple[int, str, int]] = {
    "BAAI/bge-small-en-v1.5": (384, "MIT", 67),
    "BAAI/bge-base-en-v1.5": (768, "MIT", 210),
    "sentence-transformers/all-MiniLM-L6-v2": (384, "Apache-2.0", 90),
    "nomic-ai/nomic-embed-text-v1.5": (768, "Apache-2.0", 520),
}

# BGE English models retrieve a little better when the query carries this instruction (documents don't).
_BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

EMBED_FIX = "Install local embeddings with `uv sync --extra embed` in the media-py folder (`attentionos doctor --fix` does this)."


class EmbedInput(Wire):
    model: str | None = None
    texts: list[str] = Field(default_factory=list, max_length=4096)
    kind: Literal["document", "query"] = "document"
    batch_size: int = Field(default=64, ge=1, le=512)
    cache_dir: str | None = None
    # When false, never download: fail with model_missing if the model isn't cached yet.
    allow_download: bool = True


def embed_cache_dir(root: Path | None = None) -> Path:
    from .models import cache_dir

    return (root or cache_dir()) / "embed"


def _model_slug(model: str) -> str:
    return model.split("/")[-1].lower()


def embed_model_installed(model: str = DEFAULT_EMBED_MODEL, root: Path | None = None) -> bool:
    """fastembed stores models in a Hugging Face style cache: look for a folder naming the model."""
    d = embed_cache_dir(root)
    if not d.is_dir():
        return False
    slug = _model_slug(model)
    return any(slug in p.name.lower() and any(p.rglob("*.onnx")) for p in d.iterdir() if p.is_dir())


_ENCODERS: dict[tuple[str, str], Any] = {}


def _encoder(model: str, root: Path, allow_download: bool) -> Any:
    key = (model, str(root))
    if key in _ENCODERS:
        return _ENCODERS[key]
    try:
        from fastembed import TextEmbedding
    except ImportError as exc:
        raise MediaError("embed_engine_missing", "Local embeddings are not installed.", EMBED_FIX) from exc
    root.mkdir(parents=True, exist_ok=True)
    if not embed_model_installed(model, root.parent):
        if not allow_download:
            raise MediaError(
                "model_missing",
                f"The embedding model {model} is not downloaded yet.",
                'Run `attentionos-media models download` with {"name": "embed"}, or allow the download.',
            )
        log(f"Downloading the embedding model {model} (first use only)")
    try:
        enc = TextEmbedding(model_name=model, cache_dir=str(root), local_files_only=not allow_download)
    except ValueError as exc:  # unknown model name
        raise BadInput(f"Unknown embedding model '{model}': {exc}") from exc
    except Exception as exc:  # network, corrupt cache
        raise MediaError(
            "model_missing" if not allow_download else "download_failed",
            f"Could not load the embedding model {model}: {exc}",
            "Check the internet connection for the first download, then try again.",
        ) from exc
    _ENCODERS[key] = enc
    return enc


def embed(payload: dict) -> dict:
    inp = EmbedInput.model_validate(payload or {})
    model = inp.model or os.environ.get("ATTENTIONOS_EMBED_MODEL") or DEFAULT_EMBED_MODEL
    known_dim = EMBED_MODELS.get(model, (0, "", 0))[0]
    if not inp.texts:
        return {"model": model, "dim": known_dim, "vectors": []}
    root = embed_cache_dir(Path(inp.cache_dir).expanduser() if inp.cache_dir else None)
    enc = _encoder(model, root, inp.allow_download)
    texts = [t if t.strip() else " " for t in inp.texts]
    if inp.kind == "query" and "bge-" in model.lower() and "-en" in model.lower():
        texts = [_BGE_QUERY_PREFIX + t for t in texts]
    if len(texts) > inp.batch_size:
        log(f"Embedding {len(texts)} passages")
    vectors = [[round(float(x), 6) for x in v] for v in enc.embed(texts, batch_size=inp.batch_size)]
    dim = len(vectors[0]) if vectors else known_dim
    return {"model": model, "dim": dim, "vectors": vectors}


def download_embed_model(model: str = DEFAULT_EMBED_MODEL, root: Path | None = None, *, force: bool = False) -> dict:
    """`models download {"name": "embed"}`: fetch the model into the cache once."""
    cached = embed_model_installed(model, root)
    if cached and not force:
        return {"name": f"embed:{model}", "path": str(embed_cache_dir(root)), "status": "cached"}
    _encoder(model, embed_cache_dir(root), True)
    return {
        "name": f"embed:{model}",
        "path": str(embed_cache_dir(root)),
        "status": "downloaded",
        "license": EMBED_MODELS.get(model, (0, "see model card", 0))[1],
    }
