from __future__ import annotations

import json

import pytest

from attentionos_media.prep import prep
from attentionos_media.probe import probe_file
from attentionos_media.render.face import CENTER, crop_window, detect_focus

from .conftest import make_clip, sentence

pytestmark = pytest.mark.slow


def test_prep_odd_sized_landscape_clip_and_rerun_skips(tmp_path):
    clip = make_clip(
        tmp_path / "odd.mp4",
        [*sentence("one two three."), {"pause": 0.7}, *sentence("four five.")],
        width=1281,
        height=721,
    )
    work = tmp_path / "work"
    out = prep({"source": clip["path"], "workDir": str(work), "asr": {"engine": "stub", "stubWords": clip["words"]}})
    p = probe_file(out["proxy"])["video"]
    assert p["displayWidth"] % 2 == 0 and p["displayHeight"] % 2 == 0 and p["fps"] == 30.0
    assert p["displayWidth"] == 1280
    assert out["silenceMap"]["strict"] and out["contactSheet"]
    assert [w["text"] for w in out["transcript"]["words"]] == [w["text"] for w in clip["words"]]
    mtime = (work / "proxy.mp4").stat().st_mtime_ns
    again = prep({"source": clip["path"], "workDir": str(work), "asr": {"engine": "stub", "stubWords": clip["words"]}})
    assert (work / "proxy.mp4").stat().st_mtime_ns == mtime  # finished steps are skipped
    assert json.loads((work / "prep.json").read_text())["asr"].startswith("stub")
    assert again["transcriptPath"] == out["transcriptPath"]


def test_prep_without_asr(tmp_path):
    clip = make_clip(tmp_path / "a.mp4", sentence("just audio checks"), width=540, height=960)
    out = prep(
        {"source": clip["path"], "workDir": str(tmp_path / "w"), "asr": {"engine": "none"}, "contactSheet": False}
    )
    assert "transcript" not in out and out["audio"].endswith("audio.wav")


def test_face_framing_falls_back_to_centre_without_a_detector(tmp_path):
    clip = make_clip(tmp_path / "f.mp4", sentence("no face here"), width=540, height=960)
    focus = detect_focus(clip["path"], [0.2, 0.5], 540, 960)
    assert focus.found is False
    x, y, w, h = crop_window(1920, 1080, 1080, 1920, CENTER)
    assert (w, h) == (606, 1080) and x == (1920 - 606) // 2 // 2 * 2 and y == 0
