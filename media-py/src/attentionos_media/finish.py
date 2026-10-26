"""`finish`: EBU R128 loudness to −14 LUFS / −1 dBTP. The render already normalises its mix, so finish first
measures the file (BS.1770 in numpy, one decode): when it is within `tolerance` of the target and under the
true-peak limit, the streams are copied as they are ("verified"). Otherwise it runs the classic two passes of
ffmpeg's loudnorm: pass 1 measures, pass 2 applies the measured values in linear mode (one gain for the whole
clip, so the mix is not pumped). The video stream is always copied untouched, so finishing never changes the
picture's stream hash."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field

from .audio import parse_loudnorm_json
from .errors import MediaError, NotFound
from .ffmpeg import decode_audio, ffmpeg_stderr, log, run_ffmpeg
from .loudness import measure
from .probe import probe_file
from .schemas import Wire


class FinishInput(Wire):
    input: str
    output: str
    loudness: float = Field(default=-14.0, ge=-40, le=-5)
    true_peak: float = Field(default=-1.0, ge=-9, le=0)
    lra: float = Field(default=11.0, ge=1, le=50)
    audio_bitrate: str = "192k"
    # auto: verify and copy when already on target; loudnorm: always run the two passes.
    mode: Literal["auto", "loudnorm"] = "auto"
    tolerance: float = Field(default=0.5, ge=0.1, le=2)


def _measure_file(path: Path, channels: int) -> dict:
    return measure(decode_audio(path, 48000, channels=max(1, min(2, channels))), 48000)


def finish(payload: dict) -> dict:
    inp = FinishInput.model_validate(payload)
    src = Path(inp.input)
    if not src.exists():
        raise NotFound("Input", inp.input)
    info = probe_file(src)
    if not info["audio"]:
        raise MediaError(
            "no_audio",
            "The video has no audio track to normalise.",
            "Render with audio, or skip finishing for silent clips.",
        )
    channels = info["audio"].get("channels") or 2
    out = Path(inp.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp" + out.suffix)
    if inp.mode == "auto":
        now = _measure_file(src, channels)
        if abs(now["integratedLufs"] - inp.loudness) <= inp.tolerance and now["truePeakDbtp"] <= inp.true_peak:
            log("Loudness already on target: copying")
            run_ffmpeg(
                [
                    "-i",
                    str(src),
                    "-map",
                    "0:v?",
                    "-map",
                    "0:a:0",
                    "-c",
                    "copy",
                    "-movflags",
                    "+faststart",
                    "-map_metadata",
                    "-1",
                    "-fflags",
                    "+bitexact",
                    str(tmp),
                ],
                what="write the finished file",
            )
            tmp.replace(out)
            return {
                "output": str(out),
                "target": {"integratedLufs": inp.loudness, "truePeakDbtp": inp.true_peak},
                "before": now,
                "after": now,
                "linear": True,
                "method": "verified",
            }
    # Leave a little headroom for the AAC encoder's inter-sample peaks.
    tp_target = inp.true_peak - 0.5
    log("Measuring loudness (pass 1 of 2)")
    err = ffmpeg_stderr(
        [
            "-i",
            str(src),
            "-vn",
            "-af",
            f"loudnorm=I={inp.loudness}:TP={tp_target}:LRA={inp.lra}:print_format=json",
            "-f",
            "null",
            "-",
        ]
    )
    m = parse_loudnorm_json(err)
    if m is None:
        raise MediaError("loudness_failed", "Could not measure the loudness.", None, {"stderr": err[-600:]})
    before = {
        "integratedLufs": float(m["input_i"]),
        "truePeakDbtp": float(m["input_tp"]),
        "lraLu": float(m["input_lra"]),
    }
    af = (
        f"loudnorm=I={inp.loudness}:TP={tp_target}:LRA={inp.lra}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
        f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true:print_format=summary"
    )
    log("Normalising loudness (pass 2 of 2)")
    run_ffmpeg(
        [
            "-i",
            str(src),
            "-map",
            "0:v?",
            "-map",
            "0:a:0",
            "-c:v",
            "copy",
            "-af",
            af,
            "-ar",
            "48000",
            "-c:a",
            "aac",
            "-b:a",
            inp.audio_bitrate,
            "-movflags",
            "+faststart",
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            str(tmp),
        ],
        what="normalise the loudness",
    )
    tmp.replace(out)
    after = _measure_file(out, channels)
    return {
        "output": str(out),
        "target": {"integratedLufs": inp.loudness, "truePeakDbtp": inp.true_peak},
        "before": before,
        "after": after,
        "linear": "linear=true" in af,
        "method": "loudnorm",
    }
