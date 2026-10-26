from __future__ import annotations

import pytest

from attentionos_media.finish import finish
from attentionos_media.qc import qc

from .conftest import make_clip, sentence

pytestmark = pytest.mark.slow


def tight_script(n: int = 4) -> list[dict]:
    out: list[dict] = []
    for i in range(n):
        out += sentence("this line is tight and clean.", 0.26)
        out.append({"pause": 0.08 + 0.01 * (i % 2)})
    return out


def status(report: dict, cid: str) -> str:
    return next(c["status"] for c in report["checks"] if c["id"] == cid)


@pytest.fixture(scope="module")
def clean(tmp_path_factory):
    d = tmp_path_factory.mktemp("qc")
    clip = make_clip(d / "clean.mp4", tight_script(), speech_db=-16.0)
    fin = finish({"input": clip["path"], "output": str(d / "clean.final.mp4")})
    return fin["output"]


def test_clean_clip_passes(clean):
    r = qc({"path": clean})
    assert r["passed"], r["checks"]
    for cid in ("format", "black_frames", "freeze", "clipping", "loudness", "true_peak", "pauses"):
        assert status(r, cid) == "pass", cid


def test_detects_black_frames(tmp_path):
    clip = make_clip(tmp_path / "black.mp4", tight_script(), defects={"black": [{"start": 2.0, "end": 2.6}]})
    r = qc({"path": clip["path"], "skip": ["loudness", "true_peak"]})
    assert status(r, "black_frames") == "fail"
    assert not r["passed"]
    assert any("black" in f.lower() for f in r["fixes"])


def test_detects_freeze_but_allows_planned_stills(tmp_path):
    clip = make_clip(tmp_path / "freeze.mp4", tight_script(), defects={"freeze": [{"start": 1.0, "end": 3.0}]})
    r = qc({"path": clip["path"], "skip": ["loudness", "true_peak"]})
    assert status(r, "freeze") == "fail"
    manifest = tmp_path / "render.json"
    manifest.write_text(
        '{"staticRanges": [{"start": 0.9, "end": 3.1, "reason": "still"}], "captions": [], "overlays": []}'
    )
    r2 = qc({"path": clip["path"], "manifest": str(manifest), "skip": ["loudness", "true_peak"]})
    assert status(r2, "freeze") == "pass"


def test_detects_long_pause(tmp_path):
    script = [*sentence("first part of the line."), {"pause": 0.6}, *sentence("and the rest of it.")]
    clip = make_clip(tmp_path / "pause.mp4", script)
    r = qc({"path": clip["path"], "skip": ["loudness", "true_peak"]})
    assert status(r, "pauses") == "fail"
    check = next(c for c in r["checks"] if c["id"] == "pauses")
    assert check["value"] >= 0.5


def test_detects_clipping(tmp_path):
    clip = make_clip(tmp_path / "clip.mp4", tight_script(), defects={"clip": [{"start": 1.0, "end": 1.6}]})
    r = qc({"path": clip["path"], "skip": ["loudness", "true_peak"]})
    assert status(r, "clipping") == "fail"


def test_detects_wrong_resolution_and_fps(tmp_path):
    clip = make_clip(tmp_path / "small.mp4", tight_script(2), width=720, height=1280, fps=25)
    r = qc({"path": clip["path"], "skip": ["loudness", "true_peak"]})
    assert status(r, "format") == "fail"
    detail = next(c["detail"] for c in r["checks"] if c["id"] == "format")
    assert "720×1280" in detail and "25" in detail


def test_caption_outside_safe_zone_fails(clean, tmp_path):
    m = tmp_path / "render.json"
    m.write_text(
        '{"safeBox": {"top": 240, "bottom": 1480, "left": 60, "right": 920}, "staticRanges": [],'
        '"captions": [{"start": 0, "end": 1, "text": "LOW", "box": [300, 1600, 700, 1700]}], "overlays": []}'
    )
    r = qc({"path": clean, "manifest": str(m)})
    assert status(r, "caption_safe_zone") == "fail"


@pytest.mark.parametrize("level", [-38.0, -6.0])
def test_loudnorm_hits_target(tmp_path, level):
    clip = make_clip(tmp_path / f"l{int(-level)}.mp4", tight_script(5), speech_db=level)
    out = finish({"input": clip["path"], "output": str(tmp_path / "out.mp4")})
    assert abs(out["after"]["integratedLufs"] - (-14.0)) <= 1.0, out
    assert out["after"]["truePeakDbtp"] <= -0.9
    r = qc({"path": out["output"]})
    assert status(r, "loudness") == "pass"
    assert status(r, "true_peak") in ("pass", "warn")


def test_finish_keeps_video_stream_identical(clean, tmp_path):
    from attentionos_media.qc import video_stream_hash

    again = finish({"input": clean, "output": str(tmp_path / "again.mp4")})
    assert video_stream_hash(again["output"]) == video_stream_hash(clean)
