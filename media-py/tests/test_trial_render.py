"""Trial reels end to end on a synthetic clip: render 3 variations, then verify them (and catch a broken file)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from PIL import Image

from attentionos_media.errors import MediaError
from attentionos_media.trial import text
from attentionos_media.trial.render import trial_render
from attentionos_media.trial.verify import trial_verify

from .conftest import make_clip

pytestmark = pytest.mark.slow

SPEECH = "Glaze thin. Then fire it slow. Most people skip the second coat. It shows on the rim every time. Comment GLAZE for the chart."
WORDS = SPEECH.split(" ")


@pytest.fixture(scope="module")
def clip(tmp_path_factory) -> tuple[Path, list[dict]]:
    out = tmp_path_factory.mktemp("trial") / "clean.mp4"
    script = []
    for w in WORDS:
        script.append({"word": w, "dur": 0.34})
        if w.endswith("."):
            script.append({"pause": 0.6})
    res = make_clip(out, script, width=720, height=1280, lead_s=0.3, tail_s=0.8)
    words = [{"text": w["text"], "start": w["start"], "end": w["end"]} for w in res["words"]]
    return out, words


def job(path: Path, work: Path, words: list[dict], **extra) -> dict:
    return {
        "date": "2030-07-09",
        "total": 3,
        "workDir": str(work),
        "reels": [
            {
                "slug": "glaze",
                "file": str(path),
                "titles": ["Glaze in one coat", "One coat of glaze"],
                "titleSeconds": 2.5,
                "cta": {"text": "Comment GLAZE"},
                "hashtags": ["ceramics", "pottery", "glazing", "studiopottery", "handmade"],
            }
        ],
        "words": {"glaze": words},
        **extra,
    }


def test_render_and_verify(clip, tmp_path):
    path, words = clip
    manifest = trial_render(job(path, tmp_path, words))
    assert len(manifest["variants"]) == 3
    assert {v["id"] for v in manifest["variants"]} == {"glaze-01", "glaze-02", "glaze-03"}
    assert all(Path(v["file"]).is_file() for v in manifest["variants"])
    # The end ask starts where the last sentence starts.
    last = next(w for w in words if w["text"] == "Comment")
    assert manifest["variants"][0]["ctaStart"] == pytest.approx(last["start"], abs=0.01)

    report = trial_verify({"workDir": str(tmp_path)})
    assert report["ok"], report["failures"]
    assert Path(report["preview"]).is_file()
    assert set(report["posters"]) == {"glaze-01", "glaze-02", "glaze-03"}
    assert Image.open(report["preview"]).size[0] == 216 * 3

    # Swap a file for another variation's: verify must fail (duplicate bytes, captions in the wrong place).
    files = [v["file"] for v in manifest["variants"]]
    shutil.copy(files[0], files[1])
    bad = trial_verify({"workDir": str(tmp_path)})
    assert not bad["ok"]
    assert any("byte-identical" in f for f in bad["failures"])


def test_edited_words_fail_verify(clip, tmp_path):
    path, words = clip
    trial_render(job(path, tmp_path, words, total=1))
    wfile = tmp_path / "glaze" / "words.json"
    data = json.loads(wfile.read_text())
    data[0]["w"] = "Changed"
    wfile.write_text(json.dumps(data))
    assert any("words changed" in f for f in trial_verify({"workDir": str(tmp_path)})["failures"])


def test_too_few_words_is_a_clear_error(clip, tmp_path):
    path, _ = clip
    with pytest.raises(MediaError) as exc:
        trial_render(job(path, tmp_path, [{"text": "hi", "start": 0.1, "end": 0.3}], total=1))
    assert exc.value.code == "no_speech"


def test_landscape_is_refused(tmp_path):
    out = tmp_path / "wide.mp4"
    make_clip(out, [{"word": "hello", "dur": 0.4}], width=640, height=360)
    with pytest.raises(MediaError) as exc:
        trial_render(job(out, tmp_path / "w", [{"text": "a", "start": 0, "end": 0.1}], total=1))
    assert "9:16" in exc.value.message


def test_caption_styles_draw_full_width_strips():
    for style in text.CAPTION_STYLES:
        img = text.caption_image(("Glaze", "thin"), 0, style, 1080)
        assert img.size == (1080, text.CAPTION_STRIP_HEIGHT)
        assert img.getchannel("A").getbbox() is not None
    for style in text.TITLE_STYLES:
        assert text.title_image("Glaze in one coat 🔥", style, 1080).width <= 1080


def test_emoji_are_left_out():
    assert text.strip_emoji("One coat 🔥 only") == "One coat only"
