"""Trial reels: the pure plan (no video). Same date + reels + speeds → the same variations."""

from __future__ import annotations

import json

import pytest

from attentionos_media.errors import BadInput
from attentionos_media.trial.plan import (
    DAILY_CAP,
    TrialPlanInput,
    TrialReel,
    plan_reel,
    plan_variants,
    split_total,
    trial_plan,
    validate_speeds,
)
from attentionos_media.trial.render import last_sentence_start

TILES = {
    "slug": "tiles",
    "file": "tiles.mp4",
    "titles": ["THREE TILE MISTAKES", "Tile Mistakes, Three of Them"],
    "captionLine": "Comment “GROUT” and I'll send the checklist",
    "hashtags": ["tiling", "tiler", "bathroomremodel", "diyhome", "renovation", "homeimprovement", "grout"],
}
GLAZE = {
    "slug": "glaze",
    "file": "glaze.mp4",
    "titles": ["Glaze in one coat"],
    "hashtags": ["ceramics", "pottery", "glazing", "studiopottery", "handmade"],
}
JOB = {"date": "2030-07-09", "total": 40, "reels": [TILES, GLAZE]}


def plan(job: dict) -> list[dict]:
    return plan_variants(TrialPlanInput.model_validate(job))


def test_even_split():
    assert split_total(40, 2) == [20, 20]
    assert split_total(9, 1) == [9]
    assert split_total(9, 2) == [5, 4]
    assert split_total(40, 3) == [14, 13, 13]


def test_default_day_is_nine():
    out = trial_plan({"date": "2030-07-09", "reels": [TILES]})
    assert out["total"] == 9 and len(out["variants"]) == 9


def test_over_the_daily_cap_is_rejected():
    with pytest.raises(BadInput):
        plan({**JOB, "total": DAILY_CAP + 1})


def test_forty_variants_twenty_per_reel():
    variants = plan(JOB)
    assert len(variants) == 40
    assert sum(v["reel"] == "tiles" for v in variants) == 20


def test_every_look_is_unique_within_a_reel():
    variants = plan(JOB)
    for slug in ("tiles", "glaze"):
        looks = [(v["speed"], v["grade"], v["captionStyle"], v["titleStyle"]) for v in variants if v["reel"] == slug]
        assert len(looks) == len(set(looks))


def test_ids_unique_and_plan_reproducible():
    a, b = plan(JOB), plan(JOB)
    assert a == b
    assert len({v["id"] for v in a}) == 40
    assert plan({**JOB, "date": "2030-07-10"}) != a


def test_speeds_stay_in_range():
    assert all(1.0 < v["speed"] <= 1.1 for v in plan(JOB))


def test_titles_cycle_through_the_given_wordings():
    assert {v["title"] for v in plan(JOB) if v["reel"] == "tiles"} == set(TILES["titles"])


def test_post_caption_keeps_the_owners_line_and_five_hashtags():
    for v in plan(JOB):
        tags = [w for w in v["postCaption"].split() if w.startswith("#")]
        assert len(tags) == 5 and len(set(tags)) == 5
        if v["reel"] == "tiles":
            assert v["postCaption"].startswith(TILES["captionLine"] + "  #")
            assert set(tags) <= {"#" + t for t in TILES["hashtags"]}
        else:
            assert v["postCaption"].startswith("#")


def test_hashtags_are_reshuffled():
    assert len({v["postCaption"] for v in plan(JOB) if v["reel"] == "tiles"}) > 5


def test_every_wording_gets_every_title_style():
    for count in (1, 2, 3, 4, 5):
        reel = TrialReel.model_validate({**TILES, "titles": [f"Title {n}" for n in range(count)]})
        pairs = {(v["title"], v["titleStyle"]) for v in plan_reel(reel, count * 4, "2030-07-09")}
        assert len(pairs) == count * 4


def test_end_ask_always_gets_a_boxed_style():
    assert {v["ctaStyle"] for v in plan(JOB)} <= {"white_box", "black_box"}


def test_reel_without_titles_gets_no_title():
    assert all(v["title"] == "" for v in plan({**JOB, "reels": [{**GLAZE, "titles": []}]}))


def test_the_input_is_not_changed():
    before = json.dumps(JOB, sort_keys=True)
    plan(JOB)
    assert json.dumps(JOB, sort_keys=True) == before


@pytest.mark.parametrize(
    "reel",
    [
        {**GLAZE, "hashtags": []},
        {**GLAZE, "hashtags": ["ceramics", "pottery"]},
        {**GLAZE, "hashtags": ["ceramics", "pottery", "glazing", "studio pottery", "handmade"]},
        {**GLAZE, "hashtags": ["ceramics", "pottery", "glazing", "Pottery", "handmade"]},
        {**GLAZE, "titles": ["  "]},
    ],
)
def test_bad_reels_are_rejected(reel):
    with pytest.raises(BadInput):
        plan({**JOB, "reels": [reel]})


def test_duplicate_slug_rejected():
    with pytest.raises(BadInput):
        plan({**JOB, "reels": [GLAZE, GLAZE]})


def test_hash_signs_are_accepted_and_removed():
    variants = plan({**JOB, "reels": [{**GLAZE, "hashtags": ["#" + t for t in GLAZE["hashtags"]]}]})
    assert all("##" not in v["postCaption"] for v in variants)


def test_speeds():
    assert {v["speed"] for v in plan({**JOB, "speeds": [1.02, 1.04, 1.06]})} == {1.02, 1.04, 1.06}
    with pytest.raises(BadInput):
        validate_speeds([1.05, 1.25, 1.08])
    with pytest.raises(BadInput):
        validate_speeds([1.02, 1.04, 1.05, 1.06, 1.08])  # 5 shares a factor with the 5 caption styles
    with pytest.raises(BadInput):
        validate_speeds([1.02, 1.02, 1.04])


def test_last_sentence_start():
    words = [
        {"w": "Glaze", "s": 0.0, "e": 0.3},
        {"w": "thin.", "s": 0.35, "e": 0.6},
        {"w": "Comment", "s": 0.8, "e": 1.1},
        {"w": "GLAZE", "s": 1.15, "e": 1.5},
    ]
    assert last_sentence_start(words) == 0.8
    assert last_sentence_start([]) is None
