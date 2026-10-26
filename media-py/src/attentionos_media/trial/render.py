"""`trial-render`: a day of trial reel variations from clean reels (no burned-in captions or title).

Each variation is the same video with a different speed (pitch kept), colour filter, caption style, title style and
wording, position and (optional) end ask, re-encoded as H.264/AAC 1080×1920 30 fps with the original metadata removed.

Word timings come from the input (`words`, what AttentionOS's speech-to-text heard) or, when missing, from the `asr`
command (whisper.cpp by default). They are saved as `<workDir>/<slug>/words.json` and hashed into the manifest, so
`trial-verify` can tell when they changed after the render.

Writes `<workDir>/out/<id>.mp4` and `<workDir>/manifest.json`; returns the manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from itertools import pairwise
from pathlib import Path

from pydantic import Field

from ..errors import BadInput, MediaError, NotFound
from ..ffmpeg import BT709_TAGS, log, run_ffmpeg
from ..probe import probe_file
from ..schemas import Wire, Word
from . import text
from .plan import GRADES, TrialPlanInput, plan_variants

FRAME = (1080, 1920)


class AsrChoice(Wire):
    engine: str = "whispercpp"
    model: str | None = None
    language: str | None = None


class TrialRenderInput(TrialPlanInput):
    work_dir: str
    # Word timings per reel slug, in seconds of the clean source.
    words: dict[str, list[Word]] = Field(default_factory=dict)
    asr: AsrChoice = Field(default_factory=AsrChoice)
    # Render only the first N variations of each reel (quick checks). A partial render can't be scheduled.
    only: int | None = Field(default=None, ge=1)
    # Fetch the caption fonts (Montserrat, Geist; OFL, ~1 MB) when they aren't in the cache yet. Off in tests.
    fetch_fonts: bool = False
    parallel: int | None = Field(default=None, ge=1, le=16)


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def even(pixels: int) -> int:
    """ffmpeg places overlays on even pixels in yuv420; do the same so the manifest is exact."""
    return pixels - pixels % 2


def source_info(path: str) -> dict:
    if not Path(path).is_file():
        raise NotFound("Clean reel", path)
    info = probe_file(path)
    video = info.get("video")
    if not video:
        raise MediaError("bad_media", f"{Path(path).name} has no picture.", "Use the clean reel's video file.")
    if not info.get("audio"):
        raise MediaError(
            "bad_media", f"{Path(path).name} has no sound.", "Trial reels need the reel's own audio for captions."
        )
    w, h = video["displayWidth"], video["displayHeight"]
    if not w or not h or abs(w / h - FRAME[0] / FRAME[1]) > 0.01:
        raise MediaError(
            "bad_media",
            f"{Path(path).name} is {w}×{h}, not a 9:16 vertical video.",
            "Export the clean reel as 9:16 (1080×1920).",
        )
    return {"width": w, "height": h, "duration": float(info["durationS"])}


def ensure_fonts() -> None:
    """The caption fonts, fetched once into the model cache when missing. Renders still work without them."""
    from ..models import download, installed

    for name in ("font-montserrat", "font-geist"):
        if installed(name):
            continue
        try:
            log(f"Fetching the {name.removeprefix('font-')} font for captions")
            download(name)
        except Exception as exc:  # offline: Pillow's built-in font is used instead
            log(f"Couldn't fetch {name} ({exc}); using the built-in font")


def to_words(words: list[Word]) -> list[dict]:
    return [{"w": w.text.strip(), "s": float(w.start), "e": float(w.end)} for w in words if w.text.strip()]


def transcribe_reel(path: str, asr: AsrChoice) -> list[dict]:
    from ..asr import transcribe

    log(f"Transcribing {Path(path).name}")
    payload: dict = {"path": path, "engine": asr.engine}
    if asr.model:
        payload["model"] = asr.model
    if asr.language:
        payload["language"] = asr.language
    out = transcribe(payload)
    return to_words([Word.model_validate(w) for w in out.get("words", [])])


def last_sentence_start(words: list[dict]) -> float | None:
    """Where the last sentence begins: after the last full stop, question or exclamation mark, or a long pause."""
    if not words:
        return None
    start = words[0]["s"]
    for prev, word in pairwise(words):
        if prev["w"][-1:] in ".?!" or word["s"] - prev["e"] > text.SENTENCE_GAP:
            start = word["s"]
    return start


def title_position(image_size: tuple[int, int], reel, variant: dict) -> tuple[int, int]:
    width, height = image_size
    margin = round(FRAME[0] * 0.045)
    x = margin if reel.title_x == "left" else (FRAME[0] - width) // 2
    x = min(max(x + variant["titleDx"], margin // 2), FRAME[0] - width - margin // 2)
    y = round(reel.title_y * FRAME[1] - height / 2) + variant["titleDy"]
    return even(max(x, 0)), even(min(max(y, 0), FRAME[1] - height))


def caption_y(reel, variant: dict) -> int:
    strip = text.CAPTION_STRIP_HEIGHT
    y = round(reel.caption_y * FRAME[1] - strip / 2) + variant["captionDy"]
    return even(min(max(y, 0), FRAME[1] - strip))


def _workers(requested: int | None, jobs: int) -> tuple[int, int]:
    cpu = os.cpu_count() or 4
    workers = requested or max(1, min(4, cpu // 2))
    workers = max(1, min(workers, jobs))
    return workers, max(1, cpu // workers)


def prepare_variant(work: Path, reel, variant: dict, timelines: dict[str, Path], cta_start: float | None) -> dict:
    """Draw the variation's title and ask images and work out where everything sits. Runs in the main thread."""
    placed: dict = {"captionY": caption_y(reel, variant), "captions": str(timelines[variant["captionStyle"]])}
    titles_dir = work / reel.slug / "titles"
    titles_dir.mkdir(parents=True, exist_ok=True)
    if variant["title"]:
        image = text.title_image(variant["title"], variant["titleStyle"], FRAME[0])
        file = titles_dir / f"{variant['id']}.png"
        image.save(file)
        x, y = title_position(image.size, reel, variant)
        placed |= {"titleFile": str(file), "titleX": x, "titleY": y}
    if reel.cta and cta_start is not None:
        image = text.title_image(reel.cta.text, variant["ctaStyle"], FRAME[0], max_width=0.6)
        file = titles_dir / f"{variant['id']}-cta.png"
        image.save(file)
        x = even((FRAME[0] - image.width) // 2 + variant["titleDx"])
        y = even(round(reel.cta.y * FRAME[1] - image.height / 2) + variant["titleDy"])
        placed |= {
            "ctaFile": str(file),
            "ctaX": max(x, 0),
            "ctaY": min(max(y, 0), FRAME[1] - image.height),
            "ctaStart": round(cta_start, 3),
        }
    return placed


def encode_variant(source: str, duration: float, reel, variant: dict, out: Path, threads: int) -> None:
    speed = variant["speed"]
    inputs = ["-i", source, "-f", "concat", "-safe", "0", "-i", variant["captions"]]
    chain = [f"[0:v]scale={FRAME[0]}:{FRAME[1]}:flags=lanczos,setsar=1,{GRADES[variant['grade']]}[graded]"]
    last = "graded"
    if "titleFile" in variant:
        window = f":enable='lt(t,{reel.title_seconds})'" if reel.title_seconds else ""
        index = inputs.count("-i")
        inputs += ["-i", variant["titleFile"]]
        chain.append(f"[{last}][{index}:v]overlay={variant['titleX']}:{variant['titleY']}{window}[titled]")
        last = "titled"
    if "ctaFile" in variant:
        index = inputs.count("-i")
        inputs += ["-i", variant["ctaFile"]]
        chain.append(
            f"[{last}][{index}:v]overlay={variant['ctaX']}:{variant['ctaY']}:enable='gte(t,{variant['ctaStart']})'[cta]"
        )
        last = "cta"
    chain += [
        f"[{last}][1:v]overlay=0:{variant['captionY']}[captioned]",
        f"[captioned]setpts=PTS/{speed},format=yuv420p[v]",
        f"[0:a]atempo={speed}[a]",
    ]
    run_ffmpeg(
        [
            "-v", "error", *inputs,
            "-filter_complex", ";".join(chain),
            "-map", "[v]", "-map", "[a]",
            "-t", f"{duration / speed:.3f}", "-r", "30",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", str(threads),
            *BT709_TAGS,
            "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
            "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart",
            str(out),
        ],
        what=f"render trial reel {variant['id']}",
    )  # fmt: skip


def trial_render(payload: dict) -> dict:
    t0 = time.monotonic()
    inp = TrialRenderInput.model_validate(payload)
    variants = plan_variants(inp)
    if inp.only:
        variants = [v for v in variants if v["index"] < inp.only]
    work = Path(inp.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    out_dir = work / "out"
    if out_dir.exists():  # a new render never leaves stale files behind
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    for stale in ("manifest.json", "verify.json", "preview.jpg"):
        (work / stale).unlink(missing_ok=True)

    if inp.fetch_fonts:
        ensure_fonts()
    reels = {r.slug: r for r in inp.reels}
    sources: dict[str, dict] = {}
    words: dict[str, list[dict]] = {}
    word_hash: dict[str, str] = {}
    t_asr = 0.0
    for reel in inp.reels:
        if not reel.file:
            raise BadInput(f"{reel.slug}: no video file.")
        sources[reel.slug] = source_info(reel.file)
        given = inp.words.get(reel.slug)
        t = time.monotonic()
        words[reel.slug] = to_words(given) if given is not None else transcribe_reel(reel.file, inp.asr)
        t_asr += time.monotonic() - t if given is None else 0.0
        reel_dir = work / reel.slug
        if reel_dir.exists():
            for folder in [*reel_dir.glob("captions-*"), reel_dir / "titles"]:
                shutil.rmtree(folder, ignore_errors=True)
        reel_dir.mkdir(parents=True, exist_ok=True)
        wfile = reel_dir / "words.json"
        wfile.write_text(json.dumps(words[reel.slug], ensure_ascii=False))
        word_hash[reel.slug] = sha256_file(wfile)
        if len(words[reel.slug]) < 3:
            raise MediaError(
                "no_speech",
                f"{reel.slug}: found {len(words[reel.slug])} spoken words, too few for captions.",
                "Use a reel where someone talks; trial reels add captions from the speech.",
            )

    # Captions depend only on the reel and the style, so variations share them. Everything Pillow draws is drawn
    # here, in one thread; ffmpeg then runs in parallel.
    log(f"Drawing captions and titles for {len(variants)} variations")
    timelines: dict[str, dict[str, Path]] = {slug: {} for slug in reels}
    cta_starts: dict[str, float | None] = {}
    for slug, reel in reels.items():
        duration = sources[slug]["duration"]
        for style in sorted({v["captionStyle"] for v in variants if v["reel"] == slug}):
            timelines[slug][style] = text.write_captions(
                words[slug], style, duration, FRAME[0], work / slug / f"captions-{style}"
            )
        cta_starts[slug] = None
        if reel.cta:
            start = reel.cta.start if reel.cta.start is not None else last_sentence_start(words[slug])
            cta_starts[slug] = start if start is not None and start < duration - 0.5 else None
    planned = [
        {**v, **prepare_variant(work, reels[v["reel"]], v, timelines[v["reel"]], cta_starts[v["reel"]])}
        for v in variants
    ]

    workers, threads = _workers(inp.parallel, len(planned))
    log(f"Rendering {len(planned)} trial reels ({workers} at a time)")
    t_render = time.monotonic()
    done_count = 0

    def one(v: dict) -> dict:
        nonlocal done_count
        reel = reels[v["reel"]]
        out = out_dir / f"{v['id']}.mp4"
        t = time.monotonic()
        encode_variant(reel.file, sources[v["reel"]]["duration"], reel, v, out, threads)
        done_count += 1
        log(f"Rendered {done_count} of {len(planned)}")
        return {
            **v,
            "file": str(out),
            "source": reel.file,
            "sourceDuration": sources[v["reel"]]["duration"],
            "renderS": round(time.monotonic() - t, 2),
        }

    with ThreadPoolExecutor(max_workers=workers) as pool:
        rendered = list(pool.map(one, planned))
    t_render = time.monotonic() - t_render

    manifest = {
        "date": inp.date,
        "total": inp.total,
        "partial": bool(inp.only),
        "workDir": str(work),
        "reels": [r.dump() for r in inp.reels],
        "words": word_hash,
        "variants": rendered,
        "timings": {
            "transcribeS": round(t_asr, 2),
            "renderS": round(t_render, 2),
            "totalS": round(time.monotonic() - t0, 2),
            "workers": workers,
        },
    }
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    return manifest
