"""End-to-end: synthetic talking-head clip → prep (stub ASR) → cut-plan → plan → render → finish → QC."""

from __future__ import annotations

import copy
import json
import os
import time
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from attentionos_media.cutplan import cut_plan
from attentionos_media.finish import finish
from attentionos_media.prep import prep
from attentionos_media.probe import probe_file
from attentionos_media.qc import qc, video_stream_hash
from attentionos_media.render import render

from .conftest import make_clip, talk_script

pytestmark = pytest.mark.slow


def build_plan(prepped: dict, edit_map: dict, shot: str) -> dict:
    out_s = edit_map["stats"]["outputS"]
    third = round(out_s / 3, 3)
    return {
        "version": 1,
        "format": "split-demo",
        "source": {
            "media": {"path": prepped["proxy"], "durationS": prepped["probe"]["durationS"]},
            "transcript": prepped["transcript"],
            "timeMap": {"fps": 30, "keepRanges": edit_map["keepRanges"]},
        },
        "layout": {
            "segments": [
                {"mode": "full", "start": 0, "dur": third},
                {"mode": "split", "start": third, "dur": third, "visual": {"assetId": "shot"}, "fit": "contain"},
                {"mode": "fullVisual", "start": 2 * third, "dur": 2.0, "visual": {"assetId": "shot"}},
            ]
        },
        "captions": {"style": "bold-pop", "emphasisWords": ["result", "numbers"]},
        "overlays": [
            {"kind": "headline", "at": 0, "dur": 2.5, "text": "We tested this on real numbers"},
            {"kind": "lower-third", "at": 3.0, "dur": 2.0, "text": "Demo presenter", "subtext": "Example role"},
            {
                "kind": "chart",
                "at": third + 0.5,
                "dur": 2.5,
                "text": "Hours saved",
                "props": {"labels": ["Before", "After"], "values": [3, 11]},
                "evidenceId": "ev-demo-1",
            },
        ],
        "audio": {
            "sfx": [{"kind": "whoosh", "at": third}, {"kind": "pop", "at": third + 0.5}],
            "loudness": -14,
            "truePeak": -1,
        },
        "camera": [{"kind": "zoom", "at": 1.0, "dur": 1.5, "scale": 1.12}],
        "export": {"w": 1080, "h": 1920, "fps": 30},
    }


@pytest.fixture(scope="module")
def pipeline(tmp_path_factory):
    d = tmp_path_factory.mktemp("e2e")
    clip = make_clip(
        d / "raw.mp4", talk_script(10), lead_s=0.6, tail_s=1.0, width=1920, height=1080
    )  # landscape: framing crops it
    t0 = time.monotonic()
    prepped = prep(
        {"source": clip["path"], "workDir": str(d / "work"), "asr": {"engine": "stub", "stubWords": clip["words"]}}
    )
    em = cut_plan({"audioPath": prepped["audio"], "sourcePath": prepped["proxy"], "transcript": prepped["transcript"]})
    shot = d / "shot.png"
    im = Image.new("RGB", (1600, 1000), (24, 40, 90))
    ImageDraw.Draw(im).rectangle((200, 300, 1400, 700), fill=(240, 190, 40))
    im.save(shot)
    plan = build_plan(prepped, em, str(shot))
    req = {
        "plan": plan,
        "assets": {"shot": {"path": str(shot)}},
        "output": str(d / "out" / "v1.mp4"),
        "workDir": str(d / "render"),
    }
    r1 = render(req)
    fin = finish({"input": r1["output"], "output": str(d / "out" / "v1.final.mp4")})
    elapsed = time.monotonic() - t0
    return {
        "dir": d,
        "clip": clip,
        "prepped": prepped,
        "editMap": em,
        "plan": plan,
        "req": req,
        "r1": r1,
        "final": fin["output"],
        "elapsed": elapsed,
    }


def test_render_is_valid_vertical_mp4(pipeline):
    r1 = pipeline["r1"]
    info = probe_file(pipeline["final"])
    assert (info["video"]["displayWidth"], info["video"]["displayHeight"]) == (1080, 1920)
    assert info["video"]["fps"] == 30.0 and info["video"]["codec"] == "h264" and info["audio"]["codec"] == "aac"
    assert abs(info["durationS"] - r1["durationS"]) < 0.1
    assert 20.0 <= pipeline["clip"]["durationS"] <= 60.0
    assert r1["frames"] == round(pipeline["editMap"]["stats"]["outputS"] * 30)


def test_render_passes_qc(pipeline):
    r1 = pipeline["r1"]
    report = qc(
        {
            "path": pipeline["final"],
            "manifest": r1["manifest"],
            "speechStem": r1["speechStem"],
            "expect": {"durationS": r1["durationS"]},
        }
    )
    failed = [c for c in report["checks"] if c["status"] == "fail"]
    assert report["passed"], failed
    manifest = json.loads(Path(r1["manifest"]).read_text())
    assert manifest["captions"], "captions were burned in"
    box = manifest["safeBox"]
    for c in manifest["captions"]:
        _x0, y0, x1, y1 = c["box"]
        assert y1 <= box["bottom"] and x1 <= box["right"] and y0 >= box["top"]


def test_audio_only_revision_keeps_picture_byte_stable(pipeline):
    req = copy.deepcopy(pipeline["req"])
    req["plan"]["audio"]["sfx"].append({"kind": "ding", "at": 4.0})
    req["output"] = str(pipeline["dir"] / "out" / "v2.mp4")
    r2 = render(req)
    assert r2["reusedChunks"] == len(r2["chunks"])
    fin2 = finish({"input": r2["output"], "output": str(pipeline["dir"] / "out" / "v2.final.mp4")})
    report = qc(
        {"path": fin2["output"], "previous": {"path": pipeline["final"], "revision": "audio_only"}, "skip": ["pauses"]}
    )
    assert next(c for c in report["checks"] if c["id"] == "stream_hash")["status"] == "pass"
    assert video_stream_hash(fin2["output"]) == video_stream_hash(pipeline["final"])


def test_overlay_revision_rerenders_only_affected_segment(pipeline):
    req = copy.deepcopy(pipeline["req"])
    req["plan"]["overlays"][0]["text"] = "We tested this twice"
    req["output"] = str(pipeline["dir"] / "out" / "v3.mp4")
    r3 = render(req)
    changed = [c for c in r3["chunks"] if not c["reused"]]
    assert changed and all(c["startFrame"] < round(2.5 * 30) for c in changed)
    assert r3["reusedChunks"] >= 1


@pytest.mark.skipif(not os.environ.get("ATTENTIONOS_PERF"), reason="perf timing: set ATTENTIONOS_PERF=1")
@pytest.mark.parametrize("source", ["h264-landscape", "hevc-portrait"])
def test_perf_60s(tmp_path, source):
    """A 60 s talking head through the whole engine (prep → cut-plan → render → finish → QC). Prints wall and CPU
    seconds per stage; the budget is 60 s of wall time on a laptop CPU."""
    import resource
    import subprocess

    def cpu() -> float:
        a, b = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
        return a.ru_utime + a.ru_stime + b.ru_utime + b.ru_stime

    w, h = (1920, 1080) if source == "h264-landscape" else (1080, 1920)
    clip = make_clip(tmp_path / "raw60.mp4", talk_script(20, pause=0.8), lead_s=0.5, tail_s=0.5, width=w, height=h)
    src = clip["path"]
    if source == "hevc-portrait":  # phone-like footage at 29.97 fps: needs a real proxy
        src = str(tmp_path / "raw60_hevc.mp4")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", clip["path"], "-r", "30000/1001", "-c:v", "libx265", "-preset",
             "ultrafast", "-x265-params", "log-level=error", "-tag:v", "hvc1", "-c:a", "copy", src],
            check=True,
        )  # fmt: skip
    rec: dict = {"source": source, "sourceS": clip["durationS"]}

    def stage(name, fn):
        t, c = time.monotonic(), cpu()
        out = fn()
        rec[name] = {"wallS": round(time.monotonic() - t, 2), "cpuS": round(cpu() - c, 1)}
        return out

    t0, c0 = time.monotonic(), cpu()
    p = stage(
        "prep",
        lambda: prep(
            {"source": src, "workDir": str(tmp_path / "w"), "asr": {"engine": "stub", "stubWords": clip["words"]}}
        ),
    )
    em = stage(
        "cutPlan", lambda: cut_plan({"audioPath": p["audio"], "sourcePath": p["proxy"], "transcript": p["transcript"]})
    )
    plan = build_plan(p, em, "")
    plan["layout"]["segments"] = [{"mode": "full", "start": 0, "dur": em["stats"]["outputS"]}]
    plan["overlays"] = plan["overlays"][:2]
    r = stage(
        "render",
        lambda: render({"plan": plan, "assets": {}, "output": str(tmp_path / "o.mp4"), "workDir": str(tmp_path / "r")}),
    )
    f = stage("finish", lambda: finish({"input": r["output"], "output": str(tmp_path / "f.mp4")}))
    report = stage("qc", lambda: qc({"path": f["output"], "manifest": r["manifest"], "speechStem": r["speechStem"]}))
    rec["total"] = {"wallS": round(time.monotonic() - t0, 2), "cpuS": round(cpu() - c0, 1)}
    rec["outputS"], rec["proxy"], rec["finish"]["method"] = r["durationS"], p.get("proxyMode"), f["method"]
    print(json.dumps(rec))
    assert clip["durationS"] >= 55 and report["passed"]
    assert rec["total"]["wallS"] < 60
