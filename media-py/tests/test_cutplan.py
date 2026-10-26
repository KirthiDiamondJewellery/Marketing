from __future__ import annotations

import numpy as np

from attentionos_media.cutplan import cut_plan
from attentionos_media.ffmpeg import write_wav

from .conftest import make_clip, sentence


def plan_for(tmp_path, script, *, words=None, options=None, name="a.wav", **kw):
    clip = make_clip(tmp_path / name, script, video=False, **kw)
    transcript = {"language": "en", "words": words if words is not None else clip["words"]}
    return clip, cut_plan({"audioPath": clip["path"], "transcript": transcript, "options": options or {}})


def overlaps(a, b):
    return a["start"] < b[1] and a["end"] > b[0]


def test_cuts_long_pauses_and_keeps_every_word(tmp_path):
    script = [
        *sentence("so here is the thing."),
        {"pause": 0.9},
        *sentence("most people never check."),
        {"pause": 1.2},
        *sentence("that is it."),
    ]
    clip, em = plan_for(tmp_path, script, lead_s=0.5, tail_s=0.8)
    silences = [c for c in em["cuts"] if c["kind"] == "silence"]
    w = clip["words"]
    for gap in ((w[4]["end"], w[5]["start"]), (w[8]["end"], w[9]["start"])):
        assert any(overlaps(c, gap) for c in silences), gap
    assert {c["kind"] for c in em["cuts"]} >= {"lead_in", "silence"}
    for w in clip["words"]:  # word protection: no cut touches a word or its pad
        for c in em["cuts"]:
            assert not overlaps(c, (w["start"] - 0.03, w["end"] + 0.03)), (c, w)
    assert em["stats"]["estimatedMaxPauseS"] <= 0.15
    assert em["stats"]["outputS"] < em["stats"]["sourceS"] - 2.0
    assert em["status"] == "review"
    # frame quantised keep ranges
    for r in em["keepRanges"]:
        assert abs(r["start"] * 30 - round(r["start"] * 30)) < 1e-3
    assert all(c["reason"] for c in em["cuts"])


def test_dual_threshold_requires_agreement(tmp_path):
    """Short clicks inside a pause: the strict 10 ms detector sees silence between them, the smoothed broad
    detector does not, so the pause is kept (likely a sound, not dead air) and the reason says so."""
    clip = make_clip(
        tmp_path / "base.wav",
        [*sentence("first line here."), {"pause": 1.0}, *sentence("second line here.")],
        video=False,
    )
    from attentionos_media.ffmpeg import decode_audio

    x = decode_audio(clip["path"], 48000)
    gap_start = clip["words"][2]["end"]
    for k in range(7):  # a click every 0.14 s: loud enough to keep the 50 ms envelope above −35 dB
        i = int((gap_start + 0.08 + k * 0.14) * 48000)
        x[i : i + 480] += np.hanning(480) * 0.5
    path = tmp_path / "clicks.wav"
    write_wav(path, x, 48000)
    em = cut_plan({"audioPath": str(path), "transcript": {"words": clip["words"]}})
    gap = (gap_start, clip["words"][3]["start"])
    assert not any(c["kind"] == "silence" and overlaps(c, gap) for c in em["cuts"])
    assert any("Not confirmed" in k["reason"] for k in em["kept"])


def test_word_inside_pause_is_protected(tmp_path):
    script = [*sentence("one two three."), {"pause": 1.2}, *sentence("four five six.")]
    clip = make_clip(tmp_path / "w.wav", script, video=False)
    words = list(clip["words"])
    mid = (words[2]["end"] + words[3]["start"]) / 2
    words.insert(3, {"text": "yes", "start": mid - 0.05, "end": mid + 0.05})  # the ASR heard a soft word in the gap
    em = cut_plan({"audioPath": clip["path"], "transcript": {"words": words}})
    assert not any(c["kind"] == "silence" and overlaps(c, (mid - 0.1, mid + 0.1)) for c in em["cuts"])
    assert any("word was heard" in k["reason"] for k in em["kept"])


def test_hook_zone_is_protected(tmp_path):
    script = [
        *sentence("stop", 0.3),
        {"pause": 0.35},
        *sentence("scrolling right now."),
        {"pause": 0.8},
        *sentence("here is why."),
    ]
    clip, em = plan_for(tmp_path, script, lead_s=0.4)
    hook = next(p for p in em["protected"] if p["reason"] == "hook zone")
    assert hook["start"] <= clip["words"][0]["start"]
    assert not any(c["kind"] == "silence" and overlaps(c, (hook["start"], hook["end"])) for c in em["cuts"])
    # the later pause is still cut
    assert any(c["kind"] == "silence" for c in em["cuts"])
    _, em2 = plan_for(tmp_path, script, lead_s=0.4, options={"hookProtectS": 0}, name="b.wav")
    assert len([c for c in em2["cuts"] if c["kind"] == "silence"]) > len(
        [c for c in em["cuts"] if c["kind"] == "silence"]
    )


def test_last_full_take_wins(tmp_path):
    script = [
        *sentence("the best way to start"),
        {"pause": 1.0},
        *sentence("the best way to start is to write it down."),
        {"pause": 0.7},
        *sentence("then you ship it."),
    ]
    clip, em = plan_for(tmp_path, script)
    retakes = [c for c in em["cuts"] if c["kind"] == "retake"]
    assert len(retakes) == 1
    first_take = (clip["words"][0]["start"], clip["words"][4]["end"])
    assert retakes[0]["start"] <= first_take[0] + 0.01 and retakes[0]["end"] >= first_take[1]
    assert "last full take wins" in retakes[0]["reason"]
    second = clip["words"][5]
    assert any(r["start"] <= second["start"] < r["end"] for r in em["keepRanges"])


def test_broken_off_later_take_is_flagged_not_cut(tmp_path):
    script = [
        *sentence("this tool saves you an hour every single day."),
        {"pause": 1.0},
        *sentence("this tool saves you"),
        {"pause": 1.0},
        *sentence("anyway moving on."),
    ]
    _, em = plan_for(tmp_path, script)
    assert not [c for c in em["cuts"] if c["kind"] == "retake"]
    assert em["flags"] and "broken off" in em["flags"][0]["message"]


def test_spoken_edit_note_removes_flub_and_note(tmp_path):
    script = [
        *sentence("we ship on friday"),
        {"pause": 0.5},
        *sentence("cut that."),
        {"pause": 0.6},
        *sentence("we ship on monday."),
        {"pause": 0.6},
        *sentence("see you then."),
    ]
    clip, em = plan_for(tmp_path, script)
    notes = [c for c in em["cuts"] if c["kind"] == "edit_note"]
    assert len(notes) == 1
    flub = (clip["words"][0]["start"], clip["words"][5]["end"])  # "we ship on friday cut that."
    assert notes[0]["start"] <= flub[0] + 0.01 and notes[0]["end"] >= flub[1] - 0.01
    assert "cut that" in notes[0]["reason"].lower()
    kept_monday = clip["words"][6]
    assert any(r["start"] <= kept_monday["start"] < r["end"] for r in em["keepRanges"])


def test_custom_edit_note_phrase(tmp_path):
    script = [
        *sentence("pricing starts at nine"),
        {"pause": 0.5},
        *sentence("redo please."),
        {"pause": 0.5},
        *sentence("pricing starts at ten."),
    ]
    _, em = plan_for(tmp_path, script, options={"editNotePhrases": ["redo please"], "retakes": False})
    assert [c for c in em["cuts"] if c["kind"] == "edit_note"]


def test_noisy_room_raises_threshold_above_floor(tmp_path):
    script = [*sentence("loud room test."), {"pause": 1.0}, *sentence("still works.")]
    _, em = plan_for(tmp_path, script, room_tone_db=-36.0, speech_db=-12.0)
    assert em["silence"]["strictDb"] > -42.0  # clamped above the measured floor
    assert any(c["kind"] == "silence" for c in em["cuts"])


def test_no_words_is_safe(tmp_path):
    clip = make_clip(tmp_path / "n.wav", [{"pause": 2.0}], video=False)
    em = cut_plan({"audioPath": clip["path"], "transcript": {"words": []}})
    assert em["keepRanges"] and em["stats"]["sourceS"] > 1.9
