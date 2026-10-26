"""`models`: download and locate the things media-py fetches at setup time instead of committing them:
ASR models, the face detector, the OFL fonts and the local embedding model (`embed`, fetched by fastembed). Every entry carries its license, size and SHA-256; a download
is verified before it is moved into the cache.

Cache dir: $ATTENTIONOS_CACHE_DIR, else the platform cache dir (`~/Library/Caches/attentionos` on macOS,
`$XDG_CACHE_HOME/attentionos` or `~/.cache/attentionos` on Linux, `%LOCALAPPDATA%\\attentionos\\Cache` on Windows).
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from pydantic import Field

from .errors import BadInput, MediaError
from .ffmpeg import log
from .schemas import Wire

HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
GH_SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
GFONTS = "https://raw.githubusercontent.com/google/fonts/main/ofl"


@dataclass(frozen=True)
class Artifact:
    name: str
    kind: str  # asr-whisper | asr-parakeet | face | font
    url: str
    sha256: str
    bytes: int
    license: str
    license_url: str
    file: str  # file name (or directory name for archives) inside the cache
    archive: bool = False
    description: str = ""


_WHISPER_LICENSE = ("MIT", "https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE")
_WHISPER = {
    "tiny": ("be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21", 77691713),
    "tiny.en": ("921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f", 77704715),
    "base": ("60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", 147951465),
    "base.en": ("a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002", 147964211),
    "small": ("1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", 487601967),
    "small.en": ("c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d", 487614201),
    "medium": ("6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208", 1533763059),
    "medium.en": ("cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356", 1533774781),
    "large-v3-turbo": ("1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69", 1624555275),
}

ARTIFACTS: dict[str, Artifact] = {}
for _name, (_sha, _size) in _WHISPER.items():
    ARTIFACTS[f"whisper-{_name}"] = Artifact(
        f"whisper-{_name}",
        "asr-whisper",
        f"{HF}/ggml-{_name}.bin",
        _sha,
        _size,
        *_WHISPER_LICENSE,
        f"ggml-{_name}.bin",
        description=f"whisper.cpp {_name} model ({_size / 1e6:.0f} MB)",
    )
ARTIFACTS["parakeet-v2"] = Artifact(
    "parakeet-v2",
    "asr-parakeet",
    f"{GH_SHERPA}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
    482468385,
    "CC-BY-4.0",
    "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2",
    "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    archive=True,
    description="Parakeet TDT 0.6B v2 (English) for sherpa-onnx",
)
ARTIFACTS["parakeet-v3"] = Artifact(
    "parakeet-v3",
    "asr-parakeet",
    f"{GH_SHERPA}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
    487170055,
    "CC-BY-4.0",
    "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
    "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    archive=True,
    description="Parakeet TDT 0.6B v3 (multilingual) for sherpa-onnx",
)
ARTIFACTS["face-yunet"] = Artifact(
    "face-yunet",
    "face",
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    232589,
    "MIT",
    "https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE",
    "face_detection_yunet_2023mar.onnx",
    description="YuNet face detector (OpenCV Zoo)",
)
_FONTS = {
    "font-montserrat": (
        "montserrat/Montserrat%5Bwght%5D.ttf",
        "Montserrat[wght].ttf",
        "0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7",
        744936,
    ),
    "font-geist": (
        "geist/Geist%5Bwght%5D.ttf",
        "Geist[wght].ttf",
        "73894e0448cae90a92b6c2f8732b7bb9acb7b94c418bff559dad4a18e1de9659",
        169056,
    ),
    "font-instrument-serif": (
        "instrumentserif/InstrumentSerif-Regular.ttf",
        "InstrumentSerif-Regular.ttf",
        "498efd461f6ddfcb7a111bf9a565709d2085d48201d501ead960d93e84ffbb88",
        70012,
    ),
    "font-instrument-serif-italic": (
        "instrumentserif/InstrumentSerif-Italic.ttf",
        "InstrumentSerif-Italic.ttf",
        "08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385",
        71592,
    ),
    "font-caveat": (
        "caveat/Caveat%5Bwght%5D.ttf",
        "Caveat[wght].ttf",
        "0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988",
        403648,
    ),
}
for _name, (_path, _file, _sha, _size) in _FONTS.items():
    ARTIFACTS[_name] = Artifact(
        _name,
        "font",
        f"{GFONTS}/{_path}",
        _sha,
        _size,
        "OFL-1.1",
        f"{GFONTS}/{_path.split('/')[0]}/OFL.txt",
        _file,
        description=f"{_file} (SIL Open Font License 1.1)",
    )

GROUPS = {
    "fonts": [n for n in ARTIFACTS if n.startswith("font-")],
    "default": ["whisper-small", "face-yunet", *[n for n in ARTIFACTS if n.startswith("font-")]],
}
DEFAULT_WHISPER = "small"


def cache_dir() -> Path:
    env = os.environ.get("ATTENTIONOS_CACHE_DIR")
    if env:
        return Path(env).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "attentionos"
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "attentionos" / "Cache"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "attentionos"


def artifact_path(name: str, root: Path | None = None) -> Path:
    a = resolve(name)
    return (root or cache_dir()) / a.kind / a.file


def resolve(name: str) -> Artifact:
    if name in ARTIFACTS:
        return ARTIFACTS[name]
    if f"whisper-{name}" in ARTIFACTS:  # "small" -> whisper-small
        return ARTIFACTS[f"whisper-{name}"]
    raise BadInput(f"Unknown model '{name}'. Known: {', '.join(sorted(ARTIFACTS))}.")


def installed(name: str, root: Path | None = None) -> bool:
    p = artifact_path(name, root)
    return p.is_dir() if resolve(name).archive else p.is_file()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(name: str, root: Path | None = None, *, force: bool = False) -> dict:
    a = resolve(name)
    dest = artifact_path(a.name, root)
    if installed(a.name, root) and not force:
        return {"name": a.name, "path": str(dest), "status": "cached", "license": a.license}
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
        part = Path(tmp) / "download.part"
        log(f"Downloading {a.description or a.name} ({a.bytes / 1e6:.0f} MB)")
        req = urllib.request.Request(a.url, headers={"User-Agent": "attentionos-media/0.1"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp, part.open("wb") as out:
                done, step = 0, max(1, a.bytes // 10)
                next_mark = step
                while chunk := resp.read(1 << 20):
                    out.write(chunk)
                    done += len(chunk)
                    if done >= next_mark:
                        log(f"{a.name}: {min(100, round(100 * done / a.bytes))}%")
                        next_mark += step
        except OSError as exc:
            raise MediaError(
                "download_failed",
                f"Could not download {a.name}: {exc}.",
                "Check the internet connection and try again.",
            ) from exc
        digest = _sha256(part)
        if digest != a.sha256:
            raise MediaError(
                "checksum_mismatch",
                f"The download of {a.name} is corrupt or changed upstream.",
                "Delete the cache folder and try again; if it keeps failing, report it.",
                {"expected": a.sha256, "got": digest},
            )
        if a.archive:
            with tarfile.open(part) as tar:
                tar.extractall(tmp, filter="data")
            extracted = Path(tmp) / a.file
            if not extracted.is_dir():
                raise MediaError("bad_archive", f"{a.name} did not contain {a.file}.")
            if dest.exists():
                shutil.rmtree(dest)
            shutil.move(str(extracted), dest)
        else:
            os.replace(part, dest)
    return {
        "name": a.name,
        "path": str(dest),
        "status": "downloaded",
        "sha256": a.sha256,
        "bytes": a.bytes,
        "license": a.license,
    }


class ModelsInput(Wire):
    name: str | None = None
    names: list[str] = Field(default_factory=list)
    cache_dir: str | None = None
    force: bool = False


def _embed_name(name: str) -> str | None:
    """`embed` (the default model) or `embed:<fastembed model name>`; None for every other artifact."""
    if name == "embed":
        from .embed import DEFAULT_EMBED_MODEL

        return DEFAULT_EMBED_MODEL
    return name.split(":", 1)[1] if name.startswith("embed:") else None


def _embed_listing(root: Path | None) -> list[dict]:
    from .embed import EMBED_MODELS, embed_cache_dir, embed_model_installed

    return [
        {
            "name": f"embed:{model}",
            "kind": "embed",
            "bytes": mb * 1_000_000,
            "license": lic,
            "installed": embed_model_installed(model, root),
            "path": str(embed_cache_dir(root)),
            "description": f"{model} text embeddings ({dim} dimensions) for the local knowledge store",
        }
        for model, (dim, lic, mb) in EMBED_MODELS.items()
    ]


def models_command(action: str, payload: dict) -> dict:
    inp = ModelsInput.model_validate(payload or {})
    root = Path(inp.cache_dir).expanduser() if inp.cache_dir else None
    if action == "list":
        return {
            "cacheDir": str(root or cache_dir()),
            "models": _embed_listing(root)
            + [
                {
                    "name": a.name,
                    "kind": a.kind,
                    "bytes": a.bytes,
                    "license": a.license,
                    "licenseUrl": a.license_url,
                    "installed": installed(a.name, root),
                    "path": str(artifact_path(a.name, root)),
                    "description": a.description,
                }
                for a in ARTIFACTS.values()
            ],
        }
    names = list(inp.names) or ([inp.name] if inp.name else [f"whisper-{DEFAULT_WHISPER}"])
    expanded: list[str] = []
    for n in names:
        expanded.extend(GROUPS.get(n, [n]))
    if action == "path":
        from .embed import embed_cache_dir, embed_model_installed

        return {
            "paths": {
                n: (
                    {"path": str(embed_cache_dir(root)), "installed": embed_model_installed(m, root)}
                    if (m := _embed_name(n))
                    else {"path": str(artifact_path(n, root)), "installed": installed(n, root)}
                )
                for n in expanded
            }
        }
    if action == "download":
        from .embed import download_embed_model

        return {
            "results": [
                download_embed_model(m, root, force=inp.force)
                if (m := _embed_name(n))
                else download(n, root, force=inp.force)
                for n in expanded
            ]
        }
    raise BadInput(f"Unknown models action '{action}'. Use list, path or download.")
