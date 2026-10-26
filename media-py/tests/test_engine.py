"""The best-of engine features: filler and restart removal, sentence micro-pauses, face tracking, motion, the look,
captions, the audio chain, finish's fast path, the new QC checks, prep's linked proxy and encoder fallback.
Everything runs on synthetic clips (ffmpeg test patterns, generated speech-like audio, stubbed word timings)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from attentionos_media.analysis import FaceSample, VideoAnalysis, analyze_video
from attentionos_media.cutplan import cut_plan
from attentionos_media.ffmpeg import ffmpeg_bin
from attentionos_media.finish import finish
from attentionos_media.loudness import integrated_lufs, measure, true_peak_db
from attentionos_media.prep import prep
from attentionos_media.qc import qc, video_stream_hash
from attentionos_media.render.audio_mix import cut_speech, mix, voice_filter
from attentionos_media.render.captions import build_track
from attentionos_media.render.framing import kalman_smooth, plan_shots, smooth_track
from attentionos_media.render.look import look_params, lutyuv_expr
from attentionos_media.render.motion import CapWordRef, zoom_curve
from attentionos_media.render.safezone import safe_box
from attentionos_media.render.sfx import synth
from attentionos_media.schemas import AudioPlan, CameraMove, Captions, Look, Motion, VoiceChain, Word
from attentionos_media.timemap import TimeMap

from .conftest import make_clip, sentence

SR = 48000


def words_of(em: dict, kind: str) -> list[str]:
    return [w for c in em["cuts"] if c["kind"] == kind for w in c.get("words", [])]


# --- cutting -------------------------------------------------------------------------------------------------------


def test_filler_words_go_and_guarded_fillers_need_a_boundary(tmp_path):
    script = [
        *sentence("so we um tested this, like, on real numbers."),
        {"pause": 0.6},
        *sentence("i like it a lot."),
        {"pause": 0.6},
        *sentence("you know what works."),
    ]
    clip = make_clip(tmp_path / "f.wav", script, video=False)
    em = cut_plan({"audioPath": clip["path"], "transcript": {"words": clip["words"]}})
    fillers = words_of(em, "filler")
    assert "um" in fillers
    assert "like," in fillers  # set off by commas
    assert fillers.count("like") == 0  # "i like it" keeps its verb
    assert "you" not in fillers  # "you know what" is not a filler
    kept = TimeMap.from_keep_ranges([(r["start"], r["end"]) for r in em["keepRanges"]], 30, em["source"]["durationS"])
    by_text = {w["text"]: w for w in clip["words"]}
    assert kept.map_word(by_text["um"]["start"], by_text["um"]["end"]) is None
    assert kept.map_word(by_text["it"]["start"], by_text["it"]["end"]) is not None


def test_restart_and_stutter_keep_the_last_attempt(tmp_path):
    script = [
        *sentence("we tested,"),
        {"pause": 0.3},
        *sentence("we tested this on the the real numbers."),
        {"pause": 0.6},
        *sentence("it was very very good."),
    ]
    clip = make_clip(tmp_path / "r.wav", script, video=False)
    em = cut_plan({"audioPath": clip["path"], "transcript": {"words": clip["words"]}})
    dropped = [c for c in em["cuts"] if c["kind"] == "retake"]
    patterns = {c["evidence"]["pattern"] for c in dropped}
    assert {"restart", "stutter"} <= patterns
    assert any(c["words"] == ["we", "tested,"] for c in dropped)
    assert not any("very" in c.get("words", []) for c in dropped)  # an intentional double stays


def test_wordless_sound_between_pauses_is_cut_and_long_ones_are_flagged(tmp_path):
    script = [*sentence("one two three."), {"pause": 0.5}, {"word": "hmm", "dur": 0.35}, {"pause": 0.5}]
    script += [*sentence("four five six."), {"pause": 0.5}, {"word": "mumble", "dur": 1.2}, {"pause": 0.5}]
    script += sentence("seven eight nine.")
    clip = make_clip(tmp_path / "i.wav", script, video=False)
    words = [w for w in clip["words"] if w["text"] not in ("hmm", "mumble")]  # the ASR heard neither
    em = cut_plan({"audioPath": clip["path"], "transcript": {"words": words}})
    hmm = next(w for w in clip["words"] if w["text"] == "hmm")
    assert any(
        c["kind"] == "filler" and c["start"] <= hmm["start"] + 0.05 and c["end"] >= hmm["end"] - 0.05
        for c in em["cuts"]
    )
    assert any("no words in the transcript" in f["message"] for f in em["flags"])


def test_sentence_end_keeps_a_micro_pause(tmp_path):
    script = [*sentence("first part"), {"pause": 0.5}, *sentence("of a line."), {"pause": 0.5}, *sentence("next line.")]
    clip = make_clip(tmp_path / "p.wav", script, video=False)
    em = cut_plan(
        {
            "audioPath": clip["path"],
            "transcript": {"words": clip["words"]},
            "options": {"wordPadS": 0.02, "audioPadS": 0.0},
        }
    )
    w = clip["words"]
    part, line = w[1], w[4]  # "part" (mid-sentence) and "line." (sentence end)

    def residual(word, nxt):
        cut = next(c for c in em["cuts"] if c["start"] >= word["end"] - 0.01 and c["end"] <= nxt["start"] + 0.01)
        return (cut["start"] - word["end"]) + (nxt["start"] - cut["end"])

    mid, end = residual(part, w[2]), residual(line, w[5])
    assert end > mid + 0.02
    assert 0.08 <= end <= 0.15


# --- framing --------------------------------------------------------------------------------------------------------


def _box_clip(path: Path, moving: bool) -> None:
    x = "60+50*t" if moving else "260"
    subprocess.run(
        [
            ffmpeg_bin(), "-v", "error", "-y",
            "-f", "lavfi", "-i", "color=c=0x303030:s=640x360:r=30:d=6",
            "-f", "lavfi", "-i", "color=c=white:s=70x90:r=30:d=6",
            "-filter_complex", f"[0][1]overlay=x='{x}':y=110,format=yuv420p",
            "-c:v", "libx264", "-preset", "ultrafast", str(path),
        ],
        check=True,
    )  # fmt: skip


def box_detector(noise: float = 0.02, outlier_at: int | None = 12):
    rng = np.random.default_rng(4)
    calls = {"n": 0}

    def det(frame: np.ndarray):
        i = calls["n"]
        calls["n"] += 1
        ys, xs = np.nonzero(frame[:, :, 0] > 200)
        if not len(xs):
            return []
        h, w = frame.shape[:2]
        cx = xs.mean() / w + rng.normal(0, noise)
        if i == outlier_at:
            cx = 0.95  # a false positive somewhere else
        return [(cx, ys.min() / h + 0.4 * (ys.max() - ys.min()) / h, (xs.max() - xs.min()) / w, 0.9)]

    return det


def test_face_track_smoothing_follows_a_moving_box_without_jitter(tmp_path):
    clip = tmp_path / "box.mp4"
    _box_clip(clip, moving=True)
    raw = analyze_video(clip, 640, 360, 6.0, detector=box_detector(), detector_name="box")
    assert raw.found_ratio > 0.9
    t, xs, _ys, _valid = smooth_track(raw)
    truth = (60 + 50 * t + 35) / 640
    measured = np.array([f.x if f else np.nan for f in raw.faces])
    # the outlier is rejected and the smoothed path stays on the box
    assert abs(xs[12] - truth[12]) < 0.03 and abs(measured[12] - truth[12]) > 0.3
    assert np.nanmax(np.abs(xs[3:-3] - truth[3:-3])) < 0.03
    # jitter: the smoothed path's frame-to-frame acceleration is a fraction of the raw detections'
    raw_acc = np.nanstd(np.diff(np.where(np.isnan(measured), truth, measured), 2))
    assert np.std(np.diff(xs, 2)) < raw_acc / 5
    shots = plan_shots(raw, [(0, 180)], 30, window_w_frac=0.32, window_h_frac=1.0)
    assert not shots[0].static and len(shots[0].keys) > 3
    speeds = [abs(b[1] - a[1]) / ((b[0] - a[0]) / 30) for a, b in zip(shots[0].keys, shots[0].keys[1:], strict=False)]
    assert max(speeds) <= 0.35 + 1e-6


def test_a_still_speaker_gets_a_static_shot_and_jump_cuts_hold_framing(tmp_path):
    clip = tmp_path / "still.mp4"
    _box_clip(clip, moving=False)
    a = analyze_video(clip, 640, 360, 6.0, detector=box_detector(noise=0.01, outlier_at=None), detector_name="box")
    shots = plan_shots(a, [(0, 60), (75, 180)], 30, window_w_frac=0.32, window_h_frac=1.0)
    assert all(s.static for s in shots)
    assert shots[0].keys[0][1:] == shots[1].keys[0][1:]  # the second shot reuses the first framing


def test_kalman_bridges_misses():
    n = 50
    truth = np.linspace(0.3, 0.6, n)
    valid = np.ones(n, bool)
    valid[20:30] = False
    out = kalman_smooth(np.where(valid, truth, 0.0), valid, 0.2)
    assert np.max(np.abs(out - truth)) < 0.02


def test_no_faces_means_centred_framing():
    a = VideoAnalysis(640, 360, 2.0, 5.0, "none", [None] * 10, {})
    shots = plan_shots(a, [(0, 60)], 30, window_w_frac=0.3, window_h_frac=1.0)
    assert shots[0].keys == [(0, 0.5, 0.38)] and not shots[0].found
    b = VideoAnalysis(640, 360, 2.0, 5.0, "box", [FaceSample(i / 5, 0.7, 0.4, 0.1, 0.9) for i in range(10)], {})
    assert plan_shots(b, [(0, 60)], 30, window_w_frac=0.3, window_h_frac=1.0)[0].keys[0][1] == pytest.approx(
        0.7, abs=0.01
    )


# --- motion and look ------------------------------------------------------------------------------------------------


def test_zoom_curve_alternates_at_cuts_and_punches_in_on_emphasis():
    fps, n = 30, 300
    joins = [90, 180]
    words = [CapWordRef(s, s + 8, s in (120, 200), False) for s in range(0, n, 20)]
    z, punches = zoom_curve(n, fps, joins, [(0, n)], [(0, n)], words, Motion(), [])
    assert z[30] < z[60] < z[89] == pytest.approx(1.04, abs=0.002)  # hook push across the first shot
    assert z[100] == pytest.approx(1.07, abs=1e-6)  # second shot alternates in
    assert punches == [118]
    assert z[150] > 1.07 * 1.05  # punched in
    assert z[181] == pytest.approx(1.0, abs=1e-6)  # the cut resets: third shot back to 1.0
    assert 200 - 2 not in punches  # 200 is within the min gap of 118
    z2, p2 = zoom_curve(
        n, fps, joins, [(0, n)], [(0, n)], words, Motion(punchIns="off", jumpCutZoom=0, hookPush=False), []
    )
    assert np.allclose(z2, 1.0) and not p2
    z3, _ = zoom_curve(
        n, fps, joins, [(0, n)], [(0, n)], [], Motion(), [CameraMove(kind="zoom", at=3.2, dur=1.0, scale=1.3)]
    )
    assert z3[120] <= Motion().max_zoom + 1e-9


def test_look_corrects_a_dark_flat_source_and_leaves_a_good_one_alone():
    dark = {"lumaP0_5": 22, "lumaP50": 70, "lumaP99_5": 170, "neutralRgb": [120, 128, 150]}
    p = look_params(Look(), dark)
    assert p and p["white"] < 255 and p["black"] > 0 and p["gamma"] < 1.0  # brighten mid-tones
    assert p["du"] < 0 and p["dv"] > 0  # blue cast pulled back toward neutral
    assert "lutyuv" not in lutyuv_expr(p) and "val" in lutyuv_expr(p)
    good = {"lumaP0_5": 0.5, "lumaP50": 110, "lumaP99_5": 254.8, "neutralRgb": [128, 128, 128]}
    assert look_params(Look(), good) is None
    assert look_params(Look(color="off"), dark) is None
    assert look_params(Look(color="off", grade="mono"), dark)["saturation"] == 0.0


# --- captions -------------------------------------------------------------------------------------------------------


def test_caption_timing_follows_the_cut_and_cleans_commas():
    words = [
        Word(text="we", start=0.0, end=0.3),
        Word(text="tested,", start=0.35, end=0.6),
        Word(text="um,", start=0.7, end=0.9),
        Word(text="this", start=1.0, end=1.3),
        Word(text="today.", start=1.35, end=1.7),
    ]
    tm = TimeMap.from_keep_ranges([(0.0, 0.65), (0.95, 1.8)], 30, 2.0)
    box = safe_box(None)
    track = build_track(
        Captions(style="bold-pop", maxWords=3, activeColor="#FF0066"), words, tm, box, seam_y=None, frame_h=1920
    )
    texts = [[w.text for w in c.words] for c in track.chunks]
    assert texts == [["we", "tested", "this"], ["today."]]  # "um," was cut, so "tested," lost its comma
    assert all(len(c.words) <= 3 for c in track.chunks)
    assert track.style.active == (255, 0, 102)
    this = track.chunks[0].words[2]
    assert this.start == round(0.70 * 30)  # 1.0 s source → 0.70 s output
    assert track.state_at(this.start)[1] == 2 and track.state_at(this.start - 1)[1] == 1
    y0, y1 = track.band(1920)
    assert 0 < y0 < track.center_y < y1 <= box.bottom + 80


# --- audio ----------------------------------------------------------------------------------------------------------


def _speechy(tmp_path: Path, room_db: float, speech_db: float = -30.0) -> str:
    script = [*sentence("one two three four five."), {"pause": 0.6}, *sentence("six seven eight nine ten.")]
    script += [{"pause": 0.6}, *sentence("and eleven more words to finish.")]
    clip = make_clip(tmp_path / f"v{int(-room_db)}.wav", script, video=False, speech_db=speech_db, room_tone_db=room_db)
    return clip["path"]


def test_audio_chain_hits_loudness_and_denoises_only_noisy_rooms(tmp_path):
    noisy = _speechy(tmp_path, -52.0)
    clean = _speechy(tmp_path, -95.0)
    from attentionos_media.ffmpeg import decode_audio

    assert "afftdn" in voice_filter(VoiceChain(), decode_audio(noisy, SR))
    assert "afftdn" not in voice_filter(VoiceChain(), decode_audio(clean, SR))
    assert "afftdn" not in voice_filter(VoiceChain(denoise="off"), decode_audio(noisy, SR))
    dur = len(decode_audio(noisy, SR)) / SR
    tm = TimeMap.from_keep_ranges([(0.0, 1.2), (1.5, dur)], 30, dur)
    res = mix(noisy, tm, AudioPlan(), {}, extra_sfx=[("zoom", 0.8)])
    assert abs(integrated_lufs(res.mix, SR) + 14.0) < 0.3
    assert true_peak_db(res.mix, SR) <= -1.4
    assert res.loudness is not None and res.sfx == [{"kind": "zoom", "at": 0.8, "origin": "auto"}]


def test_numpy_meter_agrees_with_ffmpeg(tmp_path):
    from attentionos_media.audio import measure_loudness

    path = _speechy(tmp_path, -60.0, speech_db=-24.0)
    from attentionos_media.ffmpeg import decode_audio

    ours = measure(decode_audio(path, SR), SR)
    ref = measure_loudness(path)
    assert abs(ours["integratedLufs"] - ref.integrated) < 0.3
    assert abs(ours["truePeakDbtp"] - ref.true_peak) < 0.5


def test_crossfaded_joins_keep_level_and_never_step():
    rng = np.random.default_rng(1)
    x = (rng.standard_normal(SR * 3) * 0.1).astype(np.float32)
    tm = TimeMap.from_keep_ranges([(0.0, 1.0), (1.5, 3.0)], 30, 3.0)
    j = round(tm.keeps[1].out_start * SR / 30)
    w = int(0.002 * SR)
    rms = float(np.sqrt(np.mean(x**2)))

    def window_rms(y):
        return float(np.sqrt(np.mean(y[j - w : j + w] ** 2)))

    xf = cut_speech(x, tm, 16.0)
    hard = cut_speech(x, tm, 0.0)
    assert window_rms(xf) > 0.75 * rms  # equal power: no dip at the join
    assert window_rms(hard) < 0.6 * rms  # the old fade-out/fade-in dips to silence
    assert np.max(np.abs(np.diff(xf[j - 400 : j + 400]))) < 1.5 * np.max(np.abs(np.diff(x)))


def test_new_sfx_kinds_exist_and_vary_by_seed():
    a, _ = synth("zoom", 1)
    b, _ = synth("zoom", 2)
    assert len(a) != len(b) or not np.allclose(a, b)  # re-pitched per use
    for kind in ("impact", "glitch", "soft", "tick"):
        s, land = synth(kind, 0)
        assert 0 <= land < len(s) and np.abs(s).max() > 0.05


# --- finish and QC --------------------------------------------------------------------------------------------------


@pytest.mark.slow
def test_finish_verifies_on_target_audio_and_copies(tmp_path):
    clip = make_clip(
        tmp_path / "a.mp4", sentence("this line is clean and clear today") * 3, speech_db=-30.0, width=540, height=960
    )
    first = finish({"input": clip["path"], "output": str(tmp_path / "f1.mp4")})
    assert first["method"] == "loudnorm" and abs(first["after"]["integratedLufs"] + 14) <= 1.0
    second = finish({"input": first["output"], "output": str(tmp_path / "f2.mp4"), "tolerance": 1.0})
    assert second["method"] == "verified"
    assert video_stream_hash(second["output"]) == video_stream_hash(first["output"])


@pytest.mark.slow
def test_first_frame_black_fails(tmp_path):
    clip = make_clip(
        tmp_path / "b.mp4",
        sentence("words after a black open"),
        width=540,
        height=960,
        defects={"black": [{"start": 0, "end": 0.4}]},
    )
    r = qc({"path": clip["path"], "expect": {"w": 540, "h": 960}, "skip": ["loudness", "true_peak"]})
    check = next(c for c in r["checks"] if c["id"] == "first_frame")
    assert check["status"] == "fail" and "black" in check["detail"]


@pytest.mark.slow
def test_caption_contrast_fails_for_plain_white_text_on_white(tmp_path):
    out = tmp_path / "white.mp4"
    subprocess.run(
        [
            ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xF0F0F0:s=1080x1920:r=30:d=2",
            "-f", "lavfi", "-i", "sine=f=220:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(out),
        ],
        check=True,
    )  # fmt: skip
    cap = {"start": 0.2, "end": 1.6, "text": "on white", "box": [300, 1100, 780, 1200]}
    for outline, expected in ((False, "fail"), (True, "pass")):
        m = tmp_path / f"m{outline}.json"
        m.write_text(
            json.dumps(
                {
                    "safeBox": {"top": 240, "bottom": 1480, "left": 60, "right": 920},
                    "captions": [cap],
                    "overlays": [],
                    "staticRanges": [{"start": 0, "end": 2, "reason": "test"}],
                    "captionStyle": {"text": [255, 255, 255], "outline": outline, "shadow": False, "box": False},
                }
            )
        )
        r = qc({"path": str(out), "manifest": str(m), "skip": ["pauses", "loudness", "true_peak"]})
        assert next(c for c in r["checks"] if c["id"] == "caption_contrast")["status"] == expected


# --- prep and render ------------------------------------------------------------------------------------------------


@pytest.mark.slow
def test_prep_links_an_edit_ready_source_and_writes_the_analysis(tmp_path):
    ready = make_clip(tmp_path / "ready.mp4", sentence("ready to edit now"), width=540, height=960)
    out = prep({"source": ready["path"], "workDir": str(tmp_path / "a"), "asr": {"engine": "none"}})
    assert out["proxyMode"] == "linked" and Path(out["analysis"]).exists() and Path(out["contactSheet"]).exists()
    off_rate = make_clip(tmp_path / "pal.mp4", sentence("twenty five frames"), width=540, height=960, fps=25)
    out2 = prep({"source": off_rate["path"], "workDir": str(tmp_path / "b"), "asr": {"engine": "none"}})
    assert out2["proxyMode"] == "encoded"
    side = json.loads(Path(out2["analysis"]).read_text())
    assert side["for"] == "proxy.mp4" and side["look"]


@pytest.mark.slow
def test_a_broken_hardware_encoder_falls_back_to_x264(tmp_path, monkeypatch):
    from attentionos_media import render as render_mod

    clip = make_clip(tmp_path / "e.mp4", sentence("short clip for the encoder"), width=540, height=960)
    p = prep(
        {"source": clip["path"], "workDir": str(tmp_path / "w"), "asr": {"engine": "stub", "stubWords": clip["words"]}}
    )
    em = cut_plan({"audioPath": p["audio"], "transcript": p["transcript"]})
    plan = {
        "version": 1,
        "format": "raw-talking-head",
        "source": {
            "media": {"path": p["proxy"], "durationS": p["probe"]["durationS"]},
            "transcript": p["transcript"],
            "timeMap": {"fps": 30, "keepRanges": em["keepRanges"]},
        },
        "export": {"w": 540, "h": 960},
    }
    original = render_mod.resolve_encoder
    monkeypatch.setattr(render_mod, "resolve_encoder", lambda pref: "h264_not_a_real_encoder")
    r = render_mod.render({"plan": plan, "output": str(tmp_path / "o.mp4"), "workDir": str(tmp_path / "r")})
    assert all(c["encoder"] == "libx264" for c in r["chunks"]), [(c["encoder"], c["reused"]) for c in r["chunks"]]
    assert original("x264") == "libx264"
