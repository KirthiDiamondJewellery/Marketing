"""The plan for a day of trial reels: which look every variation gets.

Pure functions only (no video, no clock), so the whole plan is testable and reproducible: the same date, reels and
settings always give the same variations. The looks are the changes a creator would make by hand in an editing app:
a speed up to 1.1x, a light colour filter, restyled captions, a restyled and lightly reordered title, and five
reshuffled hashtags.

`trial-plan` (JSON in, JSON out) returns the variations without rendering anything.
"""

from __future__ import annotations

import math
import random
from datetime import datetime
from typing import Literal

from pydantic import Field

from ..errors import BadInput
from ..schemas import Wire

DAILY_CAP = 50  # the documented API publishing cap per rolling 24 hours, shared with every other post
MAX_HASHTAGS = 5  # Instagram only counts five
MAX_SPEED = 1.10
DEFAULT_TOTAL = 9

# Table lengths 8, 7, 5 are pairwise coprime, so stepping through all three with the same index gives a different
# speed + grade + caption style on every variation of a reel (up to 280).
DEFAULT_SPEEDS = (1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.10)

# ffmpeg filters. None of them adds a brightness offset, so black letterbox bars stay black.
GRADES = {
    "warm": "colorbalance=rm=0.06:bm=-0.06:rh=0.03:bh=-0.03",
    "cool": "colorbalance=rm=-0.05:bm=0.06:bh=0.03",
    "punch": "eq=contrast=1.07:saturation=1.14",
    "soft": "eq=gamma=1.06:saturation=0.92",
    "vivid": "vibrance=intensity=0.28",
    "moody": "eq=contrast=1.05:gamma=0.95:saturation=0.9",
    "golden": "colorbalance=rh=0.05:gh=0.02:bh=-0.05,eq=saturation=1.06",
}
CAPTION_STYLES = ("outline", "box_word", "yellow_word", "single_caps", "caps_outline")
TITLE_STYLES = ("plain_caps", "white_box", "black_box", "small_plain")
CTA_STYLES = ("white_box", "black_box")  # it sits over the picture, so it needs a box to read


class Cta(Wire):
    """The on-screen ask near the end of a video. `start` is in source seconds; omitted, it is the start of the last
    sentence the speaker says."""

    text: str = Field(min_length=1, max_length=120)
    start: float | None = Field(default=None, ge=0)
    y: float = Field(default=0.3, gt=0, lt=1)


class TrialReel(Wire):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    file: str | None = None
    # The owner's title first, then light reorders of the same words. [] = no title.
    titles: list[str] = Field(default_factory=list, max_length=8)
    title_x: Literal["left", "center"] = "center"
    title_y: float = Field(default=0.17, gt=0, lt=1)
    # Seconds the title stays on screen (source time). None = the whole video.
    title_seconds: float | None = Field(default=None, gt=0)
    caption_y: float = Field(default=0.6, gt=0, lt=1)
    cta: Cta | None = None
    # The owner's caption line, word for word. None = hashtags only.
    caption_line: str | None = Field(default=None, max_length=2000)
    hashtags: list[str] = Field(default_factory=list, max_length=30)


class TrialPlanInput(Wire):
    date: str
    total: int = DEFAULT_TOTAL
    reels: list[TrialReel]
    speeds: list[float] | None = None


def validate_speeds(raw: list[float] | tuple[float, ...] | None) -> tuple[float, ...]:
    speeds = tuple(DEFAULT_SPEEDS if raw is None else raw)
    if not speeds:
        raise BadInput("speeds must list at least one speed.")
    if any(not 1.0 < s <= MAX_SPEED for s in speeds) or len(set(speeds)) != len(speeds):
        raise BadInput(f"speeds must be different values above 1.0 and at most {MAX_SPEED}.")
    if math.gcd(len(speeds), len(GRADES)) != 1 or math.gcd(len(speeds), len(CAPTION_STYLES)) != 1:
        raise BadInput(
            f"There are {len(speeds)} speeds. The count must share no factor with {len(GRADES)} or "
            f"{len(CAPTION_STYLES)}, or two variations of a reel would share a look (8 works)."
        )
    return tuple(float(s) for s in speeds)


def split_total(total: int, reel_count: int) -> list[int]:
    """Split the day's total evenly; any remainder goes to the first reels."""
    base, extra = divmod(total, reel_count)
    return [base + (1 if i < extra else 0) for i in range(reel_count)]


def clean_hashtag(tag: str) -> str:
    return tag.strip().lstrip("#").strip()


def validate(inp: TrialPlanInput) -> None:
    if not inp.reels:
        raise BadInput("Give at least one clean reel.")
    if not 1 <= inp.total <= DAILY_CAP:
        raise BadInput(f"The day's total must be 1 to {DAILY_CAP} (the daily publishing cap), got {inp.total}.")
    if inp.total < len(inp.reels):
        raise BadInput(f"The total ({inp.total}) is less than the {len(inp.reels)} reels given.")
    try:
        datetime.strptime(inp.date, "%Y-%m-%d")
    except ValueError as exc:
        raise BadInput(f"date must be YYYY-MM-DD, got {inp.date!r}.") from exc
    slugs = [r.slug for r in inp.reels]
    if len(set(slugs)) != len(slugs):
        raise BadInput(f"Every reel needs its own slug, got {slugs}.")
    for reel in inp.reels:
        tags = [clean_hashtag(t) for t in reel.hashtags]
        if len(tags) < MAX_HASHTAGS or any(not t or any(c.isspace() for c in t) for t in tags):
            raise BadInput(f"{reel.slug}: needs at least {MAX_HASHTAGS} hashtags (single words).")
        if len({t.lower() for t in tags}) != len(tags):
            raise BadInput(f"{reel.slug}: a hashtag is listed twice.")
        if any(not t.strip() for t in reel.titles):
            raise BadInput(f"{reel.slug}: a title is blank.")
        if reel.cta is not None and not reel.cta.text.strip():
            raise BadInput(f"{reel.slug}: the on-screen ask is blank.")


def post_caption(reel: TrialReel, rng: random.Random) -> str:
    pool = [clean_hashtag(t) for t in reel.hashtags]
    tags = " ".join("#" + t for t in rng.sample(pool, min(MAX_HASHTAGS, len(pool))))
    line = (reel.caption_line or "").strip()
    return f"{line}  {tags}" if line else tags


def plan_reel(reel: TrialReel, count: int, date: str, speeds: tuple[float, ...] = DEFAULT_SPEEDS) -> list[dict]:
    rng = random.Random(f"{date}:{reel.slug}")
    speed_order = rng.sample(speeds, len(speeds))
    grades = rng.sample(sorted(GRADES), len(GRADES))
    caption_styles = rng.sample(CAPTION_STYLES, len(CAPTION_STYLES))
    title_styles = rng.sample(TITLE_STYLES, len(TITLE_STYLES))
    titles = [t.strip() for t in reel.titles] or [""]
    return [
        {
            "id": f"{reel.slug}-{i + 1:02d}",
            "reel": reel.slug,
            "index": i,
            "speed": speed_order[i % len(speed_order)],
            "grade": grades[i % len(grades)],
            "captionStyle": caption_styles[i % len(caption_styles)],
            # The style shifts by one each time the wordings repeat, so every wording gets every style.
            "titleStyle": title_styles[(i % len(titles) + i // len(titles)) % len(title_styles)],
            "ctaStyle": CTA_STYLES[i % len(CTA_STYLES)],
            "title": titles[i % len(titles)],
            "titleDx": rng.randint(-24, 24),
            "titleDy": rng.randint(-20, 20),
            "captionDy": rng.randint(-45, 45),
            "postCaption": post_caption(reel, rng),
        }
        for i in range(count)
    ]


def plan_variants(inp: TrialPlanInput) -> list[dict]:
    validate(inp)
    speeds = validate_speeds(inp.speeds)
    counts = split_total(inp.total, len(inp.reels))
    return [v for reel, count in zip(inp.reels, counts, strict=True) for v in plan_reel(reel, count, inp.date, speeds)]


def trial_plan(payload: dict) -> dict:
    inp = TrialPlanInput.model_validate(payload)
    variants = plan_variants(inp)
    return {"date": inp.date, "total": inp.total, "variants": variants}
