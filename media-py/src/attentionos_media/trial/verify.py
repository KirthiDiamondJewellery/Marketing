"""`trial-verify`: check every rendered trial reel before anything is scheduled.

For each variation in `<workDir>/manifest.json`:
  - format: H.264 + AAC, 1080×1920, 30 fps, yuv420p, audio as long as the video, no metadata left from the source
  - length: source length / speed
  - captions: three caption lines are looked up in the finished video at the moment they should be on screen, and
    the pixels are compared with the caption image that was drawn
  - title: on screen at the start, and gone after `titleSeconds` when the reel sets one
  - end ask (when the reel has one): on screen after its start, not before
Across the batch: no two files identical, no two looks identical within a reel, words unchanged since the render.

Writes `verify.json`, `preview.jpg` (one frame per variation) and a poster frame per variation in `posters/`.
"""

from __future__ import annotations

import json
import math
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from ..errors import BadInput
from ..ffmpeg import ffmpeg_bin, ffprobe_json, log
from ..schemas import Wire
from . import text
from .render import FRAME, sha256_file

MATCH = 28.0  # mean colour error (0-255) under which drawn text counts as on screen
MIN_STATE = 0.3  # only test captions that stay up at least this long
MIN_PIXELS = 40  # a light or dark area smaller than this is too small to score
TILE = (216, 384)
POSTER_AT = 1.2


class TrialVerifyInput(Wire):
    work_dir: str


def frame_at(path: str, seconds: float) -> Image.Image:
    raw = subprocess.run(
        [ffmpeg_bin(), "-nostdin", "-v", "error", "-ss", f"{max(seconds, 0):.3f}", "-i", path, "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True,
    ).stdout  # fmt: skip
    if len(raw) < FRAME[0] * FRAME[1] * 3:
        raise ValueError(f"no frame at {seconds:.2f}s")
    return Image.frombytes("RGB", FRAME, raw[: FRAME[0] * FRAME[1] * 3])


def text_error(frame: Image.Image, overlay: Image.Image, x: int, y: int) -> float:
    """Colour error between the frame and the overlay, over the overlay's solid interior.

    Light and dark pixels are scored apart and the worse score wins. Averaged together, a black box on a black
    background would look "on screen" even with its white text missing.
    """
    solid = overlay.getchannel("A").point(lambda a: 255 if a == 255 else 0).filter(ImageFilter.MinFilter(5))
    mask = np.asarray(solid) > 0
    region = np.asarray(frame.crop((x, y, x + overlay.width, y + overlay.height)), dtype=np.int16)
    drawn = np.asarray(overlay.convert("RGB"), dtype=np.int16)
    light = drawn.mean(axis=2) > 128
    errors = [
        float(np.abs(region - drawn)[part].mean()) for part in (mask & light, mask & ~light) if part.sum() >= MIN_PIXELS
    ]
    return max(errors) if errors else 255.0


def check_format(v: dict) -> list[str]:
    info = ffprobe_json(v["file"])
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video or not audio:
        return ["missing video or audio"]
    problems = []
    got = (
        video.get("codec_name"),
        video.get("width"),
        video.get("height"),
        video.get("r_frame_rate"),
        video.get("pix_fmt"),
        audio.get("codec_name"),
    )
    want = ("h264", *FRAME, "30/1", "yuv420p", "aac")
    if got != want:
        problems.append(f"format {got} is not {want}")
    expected = v["sourceDuration"] / v["speed"]
    duration = float(info.get("format", {}).get("duration") or 0)
    if abs(duration - expected) > 0.1:
        problems.append(f"{duration:.2f}s long, expected {expected:.2f}s at {v['speed']}x")
    if abs(float(audio.get("duration") or 0) - duration) > 0.15:
        problems.append(f"audio is {float(audio.get('duration') or 0):.2f}s, video {duration:.2f}s")
    tags = {k.lower() for k in (info.get("format", {}).get("tags") or {})}
    leftover = tags - {"major_brand", "minor_version", "compatible_brands", "encoder"}
    if leftover:
        problems.append(f"metadata from the source is still in the file ({', '.join(sorted(leftover))})")
    return problems


def check_captions(v: dict, words: list[dict]) -> list[str]:
    states = [s for s in text.caption_states(words, v["captionStyle"], v["sourceDuration"]) if s[1] - s[0] >= MIN_STATE]
    if len(states) < 3:
        return ["fewer than 3 captions long enough to check"]
    problems = []
    for start, end, tokens, active in (states[0], states[len(states) // 2], states[-1]):
        frame = frame_at(v["file"], (start + end) / 2 / v["speed"])
        error = text_error(frame, text.caption_image(tokens, active, v["captionStyle"], FRAME[0]), 0, v["captionY"])
        if error > MATCH:
            problems.append(
                f"caption {' '.join(tokens)!r} not on screen at {(start + end) / 2:.2f}s (error {error:.0f})"
            )
    return problems


def check_title(v: dict, title_seconds: float | None) -> list[str]:
    if not v.get("title") or "titleFile" not in v:
        return []
    overlay = Image.open(v["titleFile"]).convert("RGBA")
    shown = min(1.0, (title_seconds or 2.0) / 2)
    error = text_error(frame_at(v["file"], shown / v["speed"]), overlay, v["titleX"], v["titleY"])
    problems = [f"title not on screen at {shown:.1f}s (error {error:.0f})"] if error > MATCH else []
    if title_seconds and title_seconds + 1.0 < v["sourceDuration"]:
        after = text_error(frame_at(v["file"], (title_seconds + 1.0) / v["speed"]), overlay, v["titleX"], v["titleY"])
        if after <= MATCH:
            problems.append(f"title still on screen after {title_seconds}s")
    return problems


def check_cta(v: dict) -> list[str]:
    overlay = Image.open(v["ctaFile"]).convert("RGBA")
    start = v["ctaStart"]
    during = (start + v["sourceDuration"]) / 2
    problems = []
    if text_error(frame_at(v["file"], during / v["speed"]), overlay, v["ctaX"], v["ctaY"]) > MATCH:
        problems.append(f"the end ask is not on screen at {during:.1f}s")
    if (
        start >= 1.5
        and text_error(frame_at(v["file"], (start - 1.0) / v["speed"]), overlay, v["ctaX"], v["ctaY"]) <= MATCH
    ):
        problems.append(f"the end ask is on screen before {start:.1f}s")
    return problems


def check_variant(v: dict, words: list[dict], reel: dict) -> dict:
    if not Path(v["file"]).is_file():
        return {"id": v["id"], "problems": ["file missing"], "sha": None}
    try:
        problems = [*check_format(v), *check_captions(v, words), *check_title(v, reel.get("titleSeconds"))]
        if "ctaFile" in v:
            problems += check_cta(v)
    except (subprocess.CalledProcessError, OSError, ValueError, KeyError) as err:
        # a file ffmpeg can't read is a failed check, not a crash that hides the other results
        problems = [f"could not be checked: {err}"]
    return {"id": v["id"], "problems": problems, "sha": sha256_file(v["file"])}


def posters_and_preview(variants: list[dict], work: Path) -> tuple[dict[str, str], str]:
    posters_dir = work / "posters"
    posters_dir.mkdir(exist_ok=True)
    columns = len(variants) if len(variants) <= 5 else min(10, math.ceil(len(variants) / 2))
    rows = -(-len(variants) // columns)
    sheet = Image.new("RGB", (TILE[0] * columns, TILE[1] * rows), "black")
    posters: dict[str, str] = {}
    for i, v in enumerate(variants):
        frame = frame_at(v["file"], POSTER_AT)
        poster = posters_dir / f"{v['id']}.jpg"
        frame.resize((540, 960), Image.Resampling.LANCZOS).save(poster, quality=85)
        posters[v["id"]] = str(poster)
        tile = frame.resize(TILE, Image.Resampling.LANCZOS)
        draw = ImageDraw.Draw(tile)
        draw.rectangle((0, TILE[1] - 22, TILE[0], TILE[1]), fill=(0, 0, 0))
        draw.text((6, TILE[1] - 18), f"{v['id']}  {v['speed']}x {v['grade']}", fill="white")
        sheet.paste(tile, (TILE[0] * (i % columns), TILE[1] * (i // columns)))
    preview = work / "preview.jpg"
    sheet.save(preview, quality=88)
    return posters, str(preview)


def trial_verify(payload: dict) -> dict:
    inp = TrialVerifyInput.model_validate(payload)
    work = Path(inp.work_dir)
    try:
        manifest = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
        reels = {r["slug"]: r for r in manifest["reels"]}
        words = {slug: json.loads((work / slug / "words.json").read_text(encoding="utf-8")) for slug in reels}
    except (OSError, ValueError, KeyError) as err:
        raise BadInput(f"Can't read the render in {work}: {err}. Render it first (trial-render).") from err
    variants = manifest["variants"]
    log(f"Checking {len(variants)} trial reels")
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda v: check_variant(v, words[v["reel"]], reels[v["reel"]]), variants))

    failures = [f"{r['id']}: {p}" for r in results for p in r["problems"]]
    for slug, sha in manifest["words"].items():
        if sha256_file(work / slug / "words.json") != sha:
            failures.append(f"{slug}: the words changed after the render. Render again.")
    shas = [r["sha"] for r in results if r["sha"]]
    if len(set(shas)) != len(shas):
        failures.append("two files are byte-identical")
    looks = [(v["reel"], v["speed"], v["grade"], v["captionStyle"], v["titleStyle"]) for v in variants]
    if len(set(looks)) != len(looks):
        failures.append("two variations of one reel share the same look")
    if not variants:
        failures.append("nothing was rendered")

    ok = not failures
    posters, preview = posters_and_preview(variants, work) if ok else ({}, None)
    report = {
        "ok": ok,
        "count": len(variants),
        "partial": bool(manifest.get("partial")),
        "files": {r["id"]: r["sha"] for r in results},
        "failures": failures,
        "clean": len(variants) - len({f.split(":")[0] for f in failures if ":" in f}),
        "preview": preview,
        "posters": posters,
    }
    (work / "verify.json").write_text(json.dumps(report, indent=2) + "\n")
    return report
