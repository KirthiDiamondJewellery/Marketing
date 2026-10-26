"""`qc`: deterministic export checks on the real MP4 (no LLM). Each check returns pass / warn / fail / skip with the
measured value, the limit and a plain-language fix. The report passes when no check fails.

Checks: format (1080×1920, 30 fps, H.264 yuv420p, AAC), duration, first frame (not black or blank: it is the
thumbnail), black frames, freezes, dead tail, clipping, loudness (−14 LUFS ±1, ≤ −1 dBTP), pauses (> 0.15 s fails,
p90 target 0.10 s, measured on the waveform), caption safe zone and caption contrast (from the render manifest,
measured on the real frames), top-band brightness and busyness, and the video stream hash against a previous
render (must match for audio-only revisions).

Speed: the picture is decoded once (black and freeze detection plus every sampled frame in one ffmpeg graph) and
the audio once (BS.1770 loudness and true peak in numpy)."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import Field

from .audio import SR, envelope_db, measure_gaps
from .errors import NotFound
from .ffmpeg import decode_audio, ffmpeg_bin, log
from .loudness import integrated_lufs, true_peak_db
from .probe import probe_file
from .render.safezone import Box, safe_box
from .schemas import SafeZone, Wire


class Expect(Wire):
    w: int = 1080
    h: int = 1920
    fps: float = 30.0
    codec: str = "h264"
    audio_codec: str = "aac"
    duration_s: float | None = None


class LoudnessSpec(Wire):
    target: float = -14.0
    tolerance: float = 1.0
    true_peak_max: float = -1.0


class PauseSpec(Wire):
    max_s: float = 0.15
    p90_target_s: float = 0.10
    max_lead_s: float = 0.25
    max_tail_s: float = 0.6


class Previous(Wire):
    path: str
    revision: Literal["audio_only", "video", "full"] = "full"


class QcInput(Wire):
    path: str
    expect: Expect = Field(default_factory=Expect)
    loudness: LoudnessSpec = Field(default_factory=LoudnessSpec)
    pauses: PauseSpec = Field(default_factory=PauseSpec)
    speech_stem: str | None = None
    manifest: str | None = None
    safe_zone: SafeZone | None = None
    previous: Previous | None = None
    skip: list[str] = Field(default_factory=list)


def _check(cid: str, label: str, status: str, detail: str, fix: str | None = None, value=None, limit=None) -> dict:
    out = {"id": cid, "label": label, "status": status, "detail": detail}
    if fix and status in ("fail", "warn"):
        out["fix"] = fix
    if value is not None:
        out["value"] = value
    if limit is not None:
        out["limit"] = limit
    return out


def _intervals(stderr: str, start_key: str, end_key: str) -> list[tuple[float, float]]:
    starts = [float(x) for x in re.findall(rf"{start_key}[:=]\s*(-?[\d.]+)", stderr)]
    ends = [float(x) for x in re.findall(rf"{end_key}[:=]\s*(-?[\d.]+)", stderr)]
    return [(s, ends[i] if i < len(ends) else float("inf")) for i, s in enumerate(starts)]


def video_stream_hash(path: str | Path) -> str | None:
    proc = subprocess.run(
        [
            ffmpeg_bin(),
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-c",
            "copy",
            "-f",
            "hash",
            "-hash",
            "md5",
            "-",
        ],
        capture_output=True,
        text=True,
    )
    m = re.search(r"MD5=([0-9a-f]+)", proc.stdout)
    return m.group(1) if m else None


SCAN_W, SCAN_H = 540, 960


def scan_video(path: Path, frames: list[int], *, black: bool, freeze: bool) -> tuple[str, dict[int, np.ndarray]]:
    """One decode: blackdetect + freezedetect on every frame, and the listed frame numbers as small gray images
    (540×960, limited-range luma). Returns (ffmpeg's log, {frame: image})."""
    chain = []
    if black:
        chain.append("blackdetect=d=0.1:pic_th=0.98:pix_th=0.10")
    if freeze:
        chain.append("freezedetect=n=0.002:d=1.0")
    frames = sorted(set(frames))
    sel = "+".join(f"eq(n,{n})" for n in frames) if frames else "0"
    pre = ",".join(chain) or "null"
    graph = f"[0:v]{pre},split=2[a][b];[b]select='{sel}',scale={SCAN_W}:{SCAN_H}:flags=area,format=gray[s]"
    proc = subprocess.run(
        [
            ffmpeg_bin(),
            "-hide_banner",
            "-nostdin",
            "-nostats",
            "-i",
            str(path),
            "-an",
            "-filter_complex",
            graph,
            "-map",
            "[a]",
            "-f",
            "null",
            "-",
            "-map",
            "[s]",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ],
        capture_output=True,
    )
    size = SCAN_W * SCAN_H
    raw = proc.stdout
    got = [
        np.frombuffer(raw[i * size : (i + 1) * size], np.uint8).reshape(SCAN_H, SCAN_W) for i in range(len(raw) // size)
    ]
    return proc.stderr.decode(errors="replace"), dict(zip(frames, got, strict=False))


def _rel_lum(v: float) -> float:
    """Relative luminance of a grey level given as limited-range luma (16..235)."""
    c = min(1.0, max(0.0, (v - 16) / 219))
    c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return c


def _fmt_t(t: float) -> str:
    return f"{t:.2f}s"


def qc(payload: dict) -> dict:
    inp = QcInput.model_validate(payload)
    path = Path(inp.path)
    if not path.exists():
        raise NotFound("Video", inp.path)
    log(f"Checking {path.name}")
    info = probe_file(path)
    v, a = info.get("video"), info.get("audio")
    dur = info["durationS"]
    checks: list[dict] = []
    skip = set(inp.skip)
    manifest = json.loads(Path(inp.manifest).read_text()) if inp.manifest and Path(inp.manifest).exists() else None
    meas: dict = {"durationS": dur}

    # format ---------------------------------------------------------------------------------------------------
    if "format" not in skip:
        e = inp.expect
        problems = []
        if not v:
            problems.append("no video stream")
        else:
            if (v["displayWidth"], v["displayHeight"]) != (e.w, e.h):
                problems.append(f"{v['displayWidth']}×{v['displayHeight']} instead of {e.w}×{e.h}")
            if not v.get("fps") or abs(v["fps"] - e.fps) > 0.01:
                problems.append(f"{v.get('fps')} fps instead of {e.fps:g}")
            if v.get("codec") != e.codec:
                problems.append(f"{v.get('codec')} video instead of {e.codec}")
            if v.get("pixFmt") != "yuv420p":
                problems.append(f"{v.get('pixFmt')} pixels instead of yuv420p")
        if not a:
            problems.append("no audio stream")
        elif a.get("codec") != e.audio_codec:
            problems.append(f"{a.get('codec')} audio instead of {e.audio_codec}")
        checks.append(
            _check(
                "format",
                "Size, frame rate and codecs",
                "fail" if problems else "pass",
                "; ".join(problems) if problems else f"{e.w}×{e.h}, {e.fps:g} fps, H.264 + AAC",
                "Re-export at 1080×1920, 30 fps, H.264 (yuv420p) with AAC audio. The cut engine does this by default.",
            )
        )

    if "duration" not in skip and inp.expect.duration_s is not None:
        diff = abs(dur - inp.expect.duration_s)
        checks.append(
            _check(
                "duration",
                "Length matches the plan",
                "pass" if diff <= 0.1 else "fail",
                f"{dur:.2f}s (plan {inp.expect.duration_s:.2f}s)",
                "The render does not match the cut list. Re-render.",
                round(dur, 3),
                inp.expect.duration_s,
            )
        )

    # one picture pass: black, freeze and every frame the later checks look at ----------------------------------
    static = [(r["start"], r["end"]) for r in (manifest or {}).get("staticRanges", [])]
    fps = (v or {}).get("fps") or 30.0
    n_frames = max(1, round(dur * fps))
    band_samples = [round(n_frames * (i + 0.5) / 12) for i in range(12)] if "top_band" not in skip else []
    caps = (manifest or {}).get("captions", [])
    cap_samples = {i: round(((c["start"] + c["end"]) / 2) * fps) for i, c in enumerate(caps[:40])}
    samples: dict[int, np.ndarray] = {}
    err = ""
    if v:
        err, samples = scan_video(
            path,
            [0, *band_samples, *cap_samples.values()],
            black="black_frames" not in skip,
            freeze="freeze" not in skip,
        )

    if v and "first_frame" not in skip:
        f0 = samples.get(0)
        if f0 is None:
            checks.append(_check("first_frame", "First frame shows a picture", "fail", "could not read frame 1"))
        else:
            mean, std = float(f0.mean()), float(f0.std())
            meas["firstFrame"] = {"meanLuma": round(mean, 1), "stdLuma": round(std, 1)}
            bad = "black" if mean < 22 else ("blank (one flat colour)" if std < 3.0 else None)
            checks.append(
                _check(
                    "first_frame",
                    "First frame shows a picture",
                    "fail" if bad else "pass",
                    f"frame 1 is {bad}" if bad else f"mean luma {mean:.0f}, detail {std:.0f}",
                    "Frame 1 is the thumbnail and the first impression: start on the speaker or the hook graphic, not a fade from black.",
                    round(mean, 1),
                )
            )

    if v and "black_frames" not in skip:
        blacks = _intervals(err, "black_start", "black_end")
        meas["black"] = [[round(s, 2), round(min(e, dur), 2)] for s, e in blacks]
        checks.append(
            _check(
                "black_frames",
                "No black frames",
                "fail" if blacks else "pass",
                ", ".join(f"black from {_fmt_t(s)} for {min(e, dur) - s:.2f}s" for s, e in blacks) or "none",
                "Check the cut list and B-roll around those times: a missing clip or a cut past the end of the footage shows as black.",
            )
        )

    if v and "freeze" not in skip:
        freezes = _intervals(err, "lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end")
        bad = [
            (s, min(e, dur))
            for s, e in freezes
            if not any(s >= a0 - 0.1 and min(e, dur) <= b0 + 0.1 for a0, b0 in static)
        ]
        meas["freezes"] = [[round(s, 2), round(min(e, dur), 2)] for s, e in freezes]
        checks.append(
            _check(
                "freeze",
                "No frozen picture",
                "fail" if bad else "pass",
                ", ".join(f"frozen from {_fmt_t(s)} for {e - s:.2f}s" for s, e in bad) or "none",
                "A clip ran out of frames or a still sat too long. Shorten the segment or add motion (a camera push).",
            )
        )

    # audio-derived checks -----------------------------------------------------------------------------------------
    xs = decode_audio(path, SR, channels=max(1, min(2, a.get("channels") or 1))) if a else np.zeros(0, np.float32)
    x = (xs.mean(axis=1) if xs.ndim == 2 else xs) if a else np.zeros(0, np.float32)
    if a and "clipping" not in skip:
        hot = (np.abs(xs) >= 0.999).any(axis=1) if xs.ndim == 2 else np.abs(xs) >= 0.999
        runs = 0
        if hot.any():
            padded = np.concatenate([[False], hot, [False]])
            edges = np.flatnonzero(padded[1:] != padded[:-1])
            runs = int(sum(1 for s, e in zip(edges[::2], edges[1::2], strict=True) if e - s >= 3))
        peak = float(20 * np.log10(np.abs(xs).max() + 1e-12)) if len(xs) else -120.0
        meas["samplePeakDbfs"] = round(peak, 2)
        checks.append(
            _check(
                "clipping",
                "No clipping",
                "fail" if runs else "pass",
                f"{runs} clipped run(s), sample peak {peak:.1f} dBFS",
                "The audio is distorted. Lower the music or SFX gain, then finish again (loudnorm keeps the peak under −1 dBTP).",
                runs,
                0,
            )
        )

    if a and "loudness" not in skip:
        xs2 = xs if "clipping" not in skip else decode_audio(path, SR, channels=max(1, min(2, a.get("channels") or 1)))
        integrated, tp = integrated_lufs(xs2, SR), true_peak_db(xs2, SR)

        meas["loudness"] = {"integratedLufs": round(integrated, 2), "truePeakDbtp": round(tp, 2)}
        L = inp.loudness
        off = abs(integrated - L.target)
        st = "pass" if off <= L.tolerance else "fail"
        checks.append(
            _check(
                "loudness",
                f"Loudness {L.target:g} LUFS ±{L.tolerance:g}",
                st,
                f"{integrated:.1f} LUFS",
                "Run the finish step (two-pass loudnorm) on this file.",
                round(integrated, 2),
                L.target,
            )
        )
        tp_st = "pass" if tp <= L.true_peak_max + 0.05 else ("warn" if tp <= L.true_peak_max + 0.5 else "fail")
        checks.append(
            _check(
                "true_peak",
                f"True peak ≤ {L.true_peak_max:g} dBTP",
                tp_st,
                f"{tp:.2f} dBTP",
                "Run the finish step; if it persists, lower the loudest SFX.",
                round(tp, 2),
                L.true_peak_max,
            )
        )

    if a and "pauses" not in skip:
        stem = Path(inp.speech_stem) if inp.speech_stem else None
        y = decode_audio(stem, SR) if stem and stem.exists() else x
        g = measure_gaps(envelope_db(y, SR), max_pause_s=inp.pauses.max_s)
        meas["pauses"] = g.to_json()
        P = inp.pauses
        status = "fail" if g.over else ("warn" if g.p90 > P.p90_target_s else "pass")
        detail = (
            (
                f"{len(g.over)} pause(s) over {P.max_s:g}s: "
                + ", ".join(f"{d:.2f}s at {_fmt_t(s)}" for s, d in g.over[:6])
            )
            if g.over
            else f"longest {g.max:.2f}s, p90 {g.p90:.2f}s (target {P.p90_target_s:g}s)"
        )
        checks.append(
            _check(
                "pauses",
                f"No pause over {P.max_s:g}s",
                status,
                detail,
                "Dead air the viewer will hear. Add those spots to the cut list (or approve the suggested silence cuts) and re-render.",
                g.max,
                P.max_s,
            )
        )
        if "dead_tail" not in skip:
            tail_bad = g.tail_s > P.max_tail_s
            checks.append(
                _check(
                    "dead_tail",
                    "No dead tail",
                    "fail" if tail_bad else "pass",
                    f"{g.tail_s:.2f}s of quiet at the end",
                    "Trim the end to just after the last word.",
                    g.tail_s,
                    P.max_tail_s,
                )
            )
        if "lead_in" not in skip:
            checks.append(
                _check(
                    "lead_in",
                    "Speech starts right away",
                    "warn" if g.lead_s > P.max_lead_s else "pass",
                    f"{g.lead_s:.2f}s before the first word",
                    "Start the cut on the first word: the first second decides the skip rate.",
                    g.lead_s,
                    P.max_lead_s,
                )
            )

    # caption safe zone ----------------------------------------------------------------------------------------------
    if "caption_safe_zone" not in skip:
        if manifest is None:
            checks.append(
                _check(
                    "caption_safe_zone",
                    "Captions and graphics inside the safe zone",
                    "skip",
                    "no render manifest given",
                )
            )
        else:
            b = manifest.get("safeBox")
            box = (
                Box(b["top"], b["bottom"], b["left"], b["right"])
                if b
                else safe_box(
                    inp.safe_zone,
                    info["video"]["displayWidth"] if v else 1080,
                    info["video"]["displayHeight"] if v else 1920,
                )
            )
            outside = [
                c for c in manifest.get("captions", []) + manifest.get("overlays", []) if not box.contains(*c["box"])
            ]
            checks.append(
                _check(
                    "caption_safe_zone",
                    "Captions and graphics inside the safe zone",
                    "fail" if outside else "pass",
                    f"{len(outside)} element(s) outside the safe box"
                    + (
                        ": "
                        + ", ".join(
                            f"“{c.get('text') or c.get('kind')}” at {c.get('start', c.get('at', 0)):.1f}s"
                            for c in outside[:4]
                        )
                        if outside
                        else ""
                    ),
                    "Move or shrink them so nothing sits in the top band, the bottom 20% or the right-side button column.",
                    len(outside),
                    0,
                )
            )

    # caption contrast -------------------------------------------------------------------------------------------
    style = (manifest or {}).get("captionStyle")
    if v and "caption_contrast" not in skip and style and cap_samples:
        fw, fh = (v or {}).get("displayWidth") or 1080, (v or {}).get("displayHeight") or 1920
        sx, sy = SCAN_W / fw, SCAN_H / fh
        text_l = _rel_lum(
            16 + 219 * (0.2126 * style["text"][0] + 0.7152 * style["text"][1] + 0.0722 * style["text"][2]) / 255
        )
        worst = None
        for i, n in cap_samples.items():
            img = samples.get(n)
            if img is None:
                continue
            x0, y0, x1, y1 = caps[i]["box"]
            gx, gy = 14, 10  # ring just outside the caption box, where the text meets the picture
            X0, Y0 = max(0, int((x0 - gx * 3) * sx)), max(0, int((y0 - gy * 3) * sy))
            X1, Y1 = min(SCAN_W, int((x1 + gx * 3) * sx)), min(SCAN_H, int((y1 + gy * 3) * sy))
            ix0, iy0, ix1, iy1 = int(x0 * sx), int(y0 * sy), int(x1 * sx), int(y1 * sy)
            region = img[Y0:Y1, X0:X1].astype(np.float32)
            mask = np.ones(region.shape, bool)
            mask[max(0, iy0 - Y0) : max(0, iy1 - Y0), max(0, ix0 - X0) : max(0, ix1 - X0)] = False
            if not mask.any():
                continue
            bg = float(np.percentile(region[mask], 75))
            bg_l = _rel_lum(bg)
            ratio = (max(text_l, bg_l) + 0.05) / (min(text_l, bg_l) + 0.05)
            if worst is None or ratio < worst[0]:
                worst = (ratio, caps[i])
        if worst is not None:
            ratio, cap = worst
            # Outlined or boxed text is readable on anything; a drop shadow helps but can't carry a light background.
            protected = bool(style.get("outline") or style.get("box"))
            if protected or ratio >= 4.5:
                status = "pass"
            elif style.get("shadow") or ratio >= 3.0:
                status = "warn"
            else:
                status = "fail"
            meas["captionContrast"] = round(ratio, 2)
            checks.append(
                _check(
                    "caption_contrast",
                    "Captions readable on the picture",
                    status,
                    f"lowest contrast {ratio:.1f}:1 behind “{cap.get('text', '')}” at {cap['start']:.1f}s"
                    + (" (outlined or boxed text)" if protected else " (shadowed text)" if style.get("shadow") else ""),
                    "Light background behind light captions: use an outlined or boxed caption style, or move the captions.",
                    round(ratio, 2),
                    4.5,
                )
            )

    # top band ------------------------------------------------------------------------------------------------------
    band_imgs = [samples[n] for n in band_samples if n in samples]
    if v and "top_band" not in skip and band_imgs:
        top = max(
            1,
            round(
                SCAN_H
                * ((manifest or {}).get("safeBox", {}).get("top", 240) / ((v or {}).get("displayHeight") or 1920))
            ),
        )
        means = [float(f[:top].mean()) for f in band_imgs]
        bright = sum(1 for m in means if m > 200)
        meas["topBandLuma"] = [round(m, 1) for m in means]
        frac = bright / max(1, len(means))
        checks.append(
            _check(
                "top_band",
                "Top band dark enough for the app's white UI",
                "fail" if frac > 0.6 else ("warn" if frac > 0.25 else "pass"),
                f"{bright} of {len(means)} sampled frames have a very bright top band",
                "The app's white icons and tabs sit there. Reframe, darken the top, or use a darker visual.",
                round(frac, 2),
                0.6,
            )
        )
        # Busyness: luma spread on a coarse 54×9 grid of the band (high-contrast text or edges fight the UI).
        spreads = []
        for f in band_imgs:
            b = f[:top].astype(np.float32)
            gh, gw = max(1, b.shape[0] // 9), max(1, b.shape[1] // 54)
            g = b[: gh * 9, : gw * 54].reshape(9, gh, 54, gw).mean(axis=(1, 3)) if top >= 9 else b
            spreads.append(float(g.max() - g.min()))
        busy = sum(1 for sp in spreads if sp > 45 * 219 / 255)
        meas["topBandSpread"] = [round(sp, 1) for sp in spreads]
        checks.append(
            _check(
                "top_band_contrast",
                "Top band calm behind the app's UI",
                "warn" if busy / len(spreads) > 0.5 else "pass",
                f"{busy} of {len(spreads)} sampled frames have high-contrast detail in the top band",
                "Text or hard edges up there compete with the app's tabs. Keep graphics below the top band and frame the shot a little lower.",
                round(busy / len(spreads), 2),
                0.5,
            )
        )

    # stream hash ---------------------------------------------------------------------------------------------------
    if inp.previous and "stream_hash" not in skip:
        now_h, prev_h = video_stream_hash(path), video_stream_hash(inp.previous.path)
        meas["videoStreamMd5"] = now_h
        same = now_h is not None and now_h == prev_h
        if inp.previous.revision == "audio_only":
            checks.append(
                _check(
                    "stream_hash",
                    "Picture unchanged on an audio-only revision",
                    "pass" if same else "fail",
                    "video stream identical" if same else "video stream changed",
                    "An audio-only revision must not re-encode the picture. Re-render from the same work folder.",
                    now_h,
                    prev_h,
                )
            )
        else:
            checks.append(
                _check(
                    "stream_hash",
                    "Picture changed as expected",
                    "pass",
                    "identical" if same else "changed",
                    None,
                    now_h,
                    prev_h,
                )
            )
    elif v and "stream_hash" not in skip:
        meas["videoStreamMd5"] = video_stream_hash(path)

    fails = [c for c in checks if c["status"] == "fail"]
    warns = [c for c in checks if c["status"] == "warn"]
    ran = [c for c in checks if c["status"] != "skip"]
    summary = (
        f"All {len(ran)} checks passed"
        if not fails and not warns
        else f"{len(ran) - len(fails) - len(warns)} of {len(ran)} checks passed; {len(fails)} failed, {len(warns)} to look at"
    )
    return {
        "path": str(path),
        "passed": not fails,
        "summary": summary,
        "checks": checks,
        "measurements": meas,
        "fixes": [c["fix"] for c in fails + warns if c.get("fix")],
    }
