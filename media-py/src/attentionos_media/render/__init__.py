"""`render`: the cut engine. Applies an EditPlan to the source and writes a 1080×1920 30 fps H.264/AAC MP4.

Analysis first, cached: faces and colour statistics come from one low-rate decode (`analysis.py`, cached by
content fingerprint and normally already written by prep), so a render never runs a detector again.

The timeline is split into chunks (one or more per layout segment). Each chunk is one ffmpeg process with one
filter graph (tracked crop, look, zoom, composite, B-roll, graphics and caption layers) and one encode. Each chunk's
inputs are hashed (source frames, layout, framing path, zoom curve, look, B-roll, the layers' exact images, encoder
settings); a chunk whose hash matches a previous render in the same work dir is reused byte for byte. So a revision
that only changes the audio, or only touches one segment, leaves every other segment's video stream identical (QC
verifies this with a stream hash). Chunks run in parallel sized to the machine's cores.

Audio is rebuilt every time (cheap: voice chain, crossfaded joins, SFX, ducked music) and normalised to the plan's
loudness target, so `finish` normally only verifies it."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from itertools import pairwise
from pathlib import Path

import numpy as np
from PIL import Image
from pydantic import Field

from ..analysis import VideoAnalysis, load_or_analyze
from ..errors import BadInput, MediaError
from ..ffmpeg import has_encoder, log, run_ffmpeg
from ..probe import probe_file
from ..schemas import EditPlan, LayoutSegment, Wire
from ..timemap import TimeMap, to_frame
from . import audio_mix
from .captions import _core, build_track, draw_caption
from .face import CENTER, Focus, crop_window
from .framing import ShotFraming, focus_of, plan_shots
from .graphics import OverlayCtx, OverlayRenderer, anim_steps
from .look import look_params, lutyuv_expr
from .motion import CapWordRef, zoom_curve
from .safezone import safe_box
from .video import ChunkSpec, EncodeSpec, Media, encode_chunk

RENDER_VERSION = "cut-2"
AUTO_SFX_KINDS = {"layout": ["whoosh", "swipe"], "punch": ["zoom", "soft"], "presenter": ["pop"]}


class AssetRef(Wire):
    path: str
    kind: str | None = None


class RenderInput(Wire):
    plan: dict
    assets: dict[str, AssetRef] = Field(default_factory=dict)
    output: str
    work_dir: str
    preset: str = "veryfast"
    chunk_max_s: float = Field(default=8.0, gt=1)
    # Chunks encoded at once; default: sized to the CPU (about one per 4 cores).
    parallel: int | None = Field(default=None, ge=1, le=16)
    seed: int = 7
    preview: bool = False
    # Overrides the plan's export.encoder (auto | x264 | hardware).
    encoder: str | None = None


def _fingerprint(path: str) -> str:
    st = Path(path).stat()
    return f"{Path(path).resolve()}|{st.st_size}|{int(st.st_mtime_ns)}"


def _media(path: str) -> Media:
    if not Path(path).exists():
        raise MediaError(
            "asset_missing", f"Media file not found: {Path(path).name}", "Re-attach the file or update the plan."
        )
    info = probe_file(path)
    v = info.get("video")
    if not v:
        raise MediaError("bad_media", f"{Path(path).name} has no picture.", "Use a video or image file here.")
    return Media(
        path,
        v["displayWidth"],
        v["displayHeight"],
        bool(v.get("isImage")) or Path(path).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"),
        info["durationS"],
    )


def normalise_segments(plan: EditPlan, out_frames: int, fps: int) -> list[tuple[int, int, LayoutSegment]]:
    """Layout segments as output frame spans covering the whole video; gaps fall back to `full`."""
    segs = sorted(plan.layout.segments, key=lambda s: s.start)
    spans: list[tuple[int, int, LayoutSegment]] = []
    cursor = 0
    for s in segs:
        a = min(out_frames, to_frame(s.start, fps))
        b = min(out_frames, to_frame(s.start + s.dur, fps))
        a = max(a, cursor)
        if a > cursor:
            spans.append((cursor, a, LayoutSegment(mode="full", start=cursor / fps, dur=(a - cursor) / fps)))
        if b > a:
            spans.append((a, b, s))
            cursor = b
    if cursor < out_frames:
        spans.append(
            (cursor, out_frames, LayoutSegment(mode="full", start=cursor / fps, dur=(out_frames - cursor) / fps))
        )
    return spans


@cache
def _hardware_encoder() -> str | None:
    """A working hardware H.264 encoder (checked once with a tiny test encode), or None."""
    import subprocess

    from ..ffmpeg import ffmpeg_bin

    order = ["h264_videotoolbox"] if sys.platform == "darwin" else ["h264_nvenc", "h264_qsv", "h264_amf"]
    for name in order:
        if not has_encoder(name):
            continue
        probe = subprocess.run(
            [
                ffmpeg_bin(),
                "-v",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "color=s=256x256:d=0.2",
                "-c:v",
                name,
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
        )
        if probe.returncode == 0:
            return name
    return None


def resolve_encoder(pref: str) -> str:
    """auto/x264 → libx264 (deterministic and, measured on laptop CPUs, as fast as the hardware encoders for 9:16
    chunks); hardware → the platform encoder when one works, else libx264. Override with ATTENTIONOS_ENCODER."""
    pref = os.environ.get("ATTENTIONOS_ENCODER", pref)
    if pref == "hardware":
        return _hardware_encoder() or "libx264"
    return "libx264"


def _workers(requested: int | None, n_chunks: int) -> tuple[int, int]:
    cpu = os.cpu_count() or 4
    workers = requested or max(1, min(4, cpu // 3))
    workers = max(1, min(workers, n_chunks))
    return workers, max(2, cpu // workers)


def render(payload: dict) -> dict:
    t_start = time.monotonic()
    inp = RenderInput.model_validate(payload)
    try:
        plan = EditPlan.model_validate(inp.plan)
    except Exception as exc:
        raise BadInput(f"The edit plan is not valid: {exc}") from exc
    assets = {k: v.path for k, v in inp.assets.items()}
    work = Path(inp.work_dir)
    (work / "chunks").mkdir(parents=True, exist_ok=True)
    (work / "layers").mkdir(parents=True, exist_ok=True)
    ex = plan.export
    W, H, fps = ex.w, ex.h, ex.fps
    if inp.preview:
        W, H = W // 2 // 2 * 2, H // 2 // 2 * 2
    src = _media(plan.source.media.path)
    tm = TimeMap.from_keep_ranges(
        [(r.start, r.end) for r in plan.source.time_map.keep_ranges], fps, plan.source.media.duration_s
    )
    if tm.output_frames == 0:
        raise BadInput("The keep ranges leave nothing to render.")
    warnings: list[str] = []
    if plan.source.time_map.fps != fps:
        warnings.append(f"Plan time map is {plan.source.time_map.fps} fps; rendering at {fps} fps.")
    spans = normalise_segments(plan, tm.output_frames, fps)
    box = safe_box(plan.captions.safe_zone, W, H)

    # --- analysis (cached): faces and colour statistics of the source ------------------------------------------
    needs_faces = any(s.mode != "fullVisual" and s.speaker.focus == "face" for _, _, s in spans)
    needs_look = plan.look.color == "auto" or plan.look.grade != "none"
    analysis: VideoAnalysis | None = None
    if (needs_faces or needs_look) and not src.is_image:
        try:
            analysis = load_or_analyze(src.path, src.width, src.height, src.duration)
        except MediaError as exc:
            warnings.append(f"Couldn't analyse the footage ({exc.message}); framing is centred and colour untouched.")
    look = look_params(plan.look, analysis.look) if analysis and analysis.look else None
    look_expr = lutyuv_expr(look) if look else None
    _, _, full_cw, full_ch = crop_window(src.width, src.height, W, H, CENTER)
    keeps_frames = [(k.src_start, k.src_end) for k in tm.keeps]
    shots_by_track: dict[bool, list[ShotFraming]] = {}

    def shots_for(seg: LayoutSegment) -> list[ShotFraming] | None:
        if seg.speaker.focus != "face" or analysis is None or not analysis.found_ratio:
            return None
        key = bool(seg.speaker.track)
        if key not in shots_by_track:
            shots_by_track[key] = plan_shots(
                analysis,
                keeps_frames,
                fps,
                window_w_frac=full_cw / src.width,
                window_h_frac=full_ch / src.height,
                track=key,
            )
        return shots_by_track[key]

    # --- captions, overlays ------------------------------------------------------------------------------------
    seam = None
    for _, _, s in spans:
        if s.mode == "split":
            seam = round(H * s.split_ratio)
            break
    track = build_track(plan.captions, plan.source.transcript.words, tm, box, seam_y=seam, frame_h=H)
    caption_top = track.center_y - 80 if track.style else box.bottom
    band = track.band(H)
    octx = OverlayCtx(W, H, box, assets, caption_top)
    orender = OverlayRenderer(octx)
    overlays = [(i, ov, to_frame(ov.at, fps), to_frame(ov.at + ov.dur, fps)) for i, ov in enumerate(plan.overlays)]
    for _, ov, a, _ in overlays:
        if a >= tm.output_frames:
            warnings.append(f"The {ov.kind} overlay at {ov.at:.1f}s starts after the video ends; it will not show.")

    # --- motion: one zoom value per output frame ---------------------------------------------------------------
    emph = {_core(t) for e in plan.captions.emphasis_words for t in e.split() if _core(t)}
    words: list[CapWordRef] = []
    prev_end_sentence = True
    for w in plan.source.transcript.words:
        span = tm.map_word(w.start, w.end)
        ends = bool(re.search(r"[.?!]['\")\]]*$", w.text.strip()))
        if span is not None:
            words.append(
                CapWordRef(to_frame(span[0], fps), to_frame(span[1], fps), _core(w.text) in emph, prev_end_sentence)
            )
        prev_end_sentence = ends
    full_spans = [(a, b) for a, b, s in spans if s.mode == "full"]
    cam_spans = [(a, b) for a, b, s in spans if s.mode != "split"]
    zoom, punches = zoom_curve(
        tm.output_frames, fps, tm.joins_output_frames(), full_spans, cam_spans, words, plan.motion, plan.camera
    )
    for c in plan.camera:
        if any(a <= to_frame(c.at, fps) < b for a, b, s in spans if s.mode == "split"):
            warnings.append(f"Camera move at {c.at:.1f}s is ignored in the split layout.")

    # --- chunk specs ---------------------------------------------------------------------------------------------
    focus_info: dict[str, dict] = {}
    chunk_frames = max(fps, to_frame(inp.chunk_max_s, fps))
    specs: list[ChunkSpec] = []
    for si, (a, b, seg) in enumerate(spans):
        n_parts = max(1, -(-(b - a) // chunk_frames))
        bounds = [a + (b - a) * k // n_parts for k in range(n_parts + 1)]
        visual = None
        if seg.mode in ("split", "fullVisual", "inset"):
            if seg.visual is None:
                warnings.append(
                    f"The {seg.mode} segment at {seg.start:.1f}s has no visual; a plain background is used."
                )
            else:
                vpath = assets.get(seg.visual.asset_id)
                if not vpath:
                    raise MediaError(
                        "asset_missing",
                        f"Visual '{seg.visual.asset_id}' for the segment at {seg.start:.1f}s is not attached.",
                        "Attach the asset or change the segment's layout.",
                    )
                visual = _media(vpath)
        matte = None
        if seg.mode == "inset" and seg.inset and seg.inset.matte_asset_id and not seg.inset.key:
            mp = assets.get(seg.inset.matte_asset_id)
            if not mp:
                raise MediaError(
                    "asset_missing", "The inset matte is not attached.", "Attach the matte video or use a chroma key."
                )
            matte = _media(mp)
        shots = shots_for(seg) if seg.mode != "fullVisual" else None
        if seg.mode == "fullVisual":
            focus = CENTER
        elif isinstance(seg.speaker.focus, str):
            focus = focus_of(shots) if shots else CENTER
        else:
            focus = Focus(seg.speaker.focus.x, seg.speaker.focus.y, True, "plan")
        focus_info[str(si)] = {
            "x": round(focus.x, 3),
            "y": round(focus.y, 3),
            "found": focus.found,
            "method": (analysis.detector if focus.method == "track" and analysis else focus.method),
            "tracked": bool(shots and any(not s.static for s in shots)),
        }
        # Zoom centre in the composed frame: where the face sits after the crop.
        cx, cy, cw, ch = crop_window(src.width, src.height, W, H, focus, 0.40)
        zf = (
            min(0.8, max(0.2, (focus.x * src.width - cx) / cw)),
            min(0.7, max(0.2, (focus.y * src.height - cy) / ch)),
        )
        for k in range(n_parts):
            f0, f1 = bounds[k], bounds[k + 1]
            if f1 <= f0:
                continue
            pieces = tm.output_range_to_source(f0, f1)
            vstart = (seg.visual.in_ if seg.visual else 0.0) + (f0 - a) / fps
            if visual and not visual.is_image and seg.visual and not seg.visual.loop and visual.duration > 0:
                vstart = min(vstart, max(0.0, visual.duration - 1 / fps))
            brolls = []
            for b_ in plan.broll:
                ba, bb = to_frame(b_.at, fps), to_frame(b_.at + b_.dur, fps)
                if ba < f1 and bb > f0:
                    p = assets.get(b_.asset_id)
                    if not p:
                        raise MediaError(
                            "asset_missing",
                            f"B-roll '{b_.asset_id}' at {b_.at:.1f}s is not attached.",
                            "Attach it or remove it from the plan.",
                        )
                    brolls.append((b_, _media(p)))
            cams = [c for c in plan.camera if to_frame(c.at, fps) < f1 and to_frame(c.at + c.dur, fps) > f0]
            z = zoom[f0:f1]
            zf_chunk = (cams[0].focus.x, cams[0].focus.y) if cams and cams[0].focus else zf
            specs.append(
                ChunkSpec(
                    len(specs),
                    f0,
                    f1,
                    seg,
                    pieces,
                    focus,
                    visual,
                    vstart,
                    brolls,
                    cams,
                    None,
                    matte,
                    shots=shots,
                    zoom=[round(float(v), 5) for v in z] if np.any(np.abs(z - 1.0) > 1e-4) else None,
                    zoom_focus=zf_chunk,
                    # A chroma-keyed inset is keyed on the raw colours: the look would shift the key.
                    look=look_expr if seg.mode != "fullVisual" and not (seg.inset and seg.inset.key) else None,
                    sharpen=plan.look.sharpen != "off" and seg.mode != "fullVisual",
                )
            )

    # --- layers: each distinct on-screen state is drawn once (and cached across revisions) ----------------------
    caption_boxes: list[dict] = []
    overlay_boxes: list[dict] = []
    seen_caption: set = set()
    seen_overlay: set = set()
    log(f"Drawing captions and graphics for {len(specs)} part(s)")
    band_h = band[1] - band[0]
    for spec in specs:
        cap_runs: list[tuple[tuple | None, int]] = []
        ov_runs: list[tuple[tuple, int]] = []
        for f in range(spec.f0, spec.f1):
            cap = track.state_at(f) if band_h > 0 else None
            if cap_runs and cap_runs[-1][0] == cap:
                cap_runs[-1] = (cap, cap_runs[-1][1] + 1)
            else:
                cap_runs.append((cap, 1))
            active = tuple((i, min(f - a, anim_steps(ov))) for i, ov, a, b in overlays if a <= f < b)
            if ov_runs and ov_runs[-1][0] == active:
                ov_runs[-1] = (active, ov_runs[-1][1] + 1)
            else:
                ov_runs.append((active, 1))
        if any(c is not None for c, _ in cap_runs):
            entries = [
                (_caption_png(work, cap, W, band, track, caption_boxes, seen_caption, fps), run)
                for cap, run in cap_runs
            ]
            spec.caption_layer = _concat(work, f"chunk{spec.index:03d}.cap.ffconcat", entries, W, band_h, fps)
            spec.caption_y = band[0]
        if any(act for act, _ in ov_runs):
            entries = [
                (_overlay_png(work, act, W, H, orender, plan, overlay_boxes, seen_overlay, box), run)
                for act, run in ov_runs
            ]
            spec.layer = _concat(work, f"chunk{spec.index:03d}.ffconcat", entries, W, H, fps)

    workers, threads = _workers(inp.parallel, len(specs))
    pref = inp.encoder or ex.encoder
    encoder = resolve_encoder(pref) if not inp.preview else "libx264"
    enc = EncodeSpec(
        W,
        H,
        fps,
        ex.crf if not inp.preview else 28,
        inp.preset if not inp.preview else "ultrafast",
        ex.bitrate,
        threads,
        encoder,
    )
    src_fp = _fingerprint(src.path)
    results: list[dict] = []

    def chunk_hash(spec: ChunkSpec) -> str:
        def layer_desc(p: Path | None):
            return [ln for ln in p.read_text().splitlines() if ln.startswith(("file", "duration"))] if p else None

        desc = {
            "v": RENDER_VERSION,
            # threads are left out: libx264 output does not depend on them with these settings
            "enc": [enc.w, enc.h, enc.fps, enc.crf, enc.preset, enc.maxrate, enc.encoder],
            "n": spec.f1 - spec.f0,
            "src": src_fp,
            "pieces": spec.pieces,
            "seg": spec.segment.model_dump(mode="json", exclude={"start", "dur"}),
            "focus": [round(spec.focus.x, 4), round(spec.focus.y, 4)],
            "shots": [
                [s.src_f0, s.src_f1, [[k[0], round(k[1], 4), round(k[2], 4)] for k in s.keys]] for s in spec.shots
            ]
            if spec.shots
            else None,
            "zoom": spec.zoom,
            "zoomFocus": [round(spec.zoom_focus[0], 4), round(spec.zoom_focus[1], 4)],
            "look": spec.look,
            "sharpen": spec.sharpen,
            "visual": [_fingerprint(spec.visual.path), round(spec.visual_start, 4)] if spec.visual else None,
            "matte": _fingerprint(spec.matte.path) if spec.matte else None,
            "broll": [
                [b.model_dump(mode="json", exclude={"at"}), round(b.at - spec.f0 / fps, 4), _fingerprint(m.path)]
                for b, m in spec.broll
            ],
            "layer": layer_desc(spec.layer),
            "captions": [layer_desc(spec.caption_layer), spec.caption_y],
        }
        return hashlib.sha256(json.dumps(desc, sort_keys=True, default=str).encode()).hexdigest()[:24]

    def do_chunk(spec: ChunkSpec) -> dict:
        h = chunk_hash(spec)
        path = work / "chunks" / f"{h}.mp4"
        reused = path.exists()
        used = enc.encoder
        if not reused:
            used = encode_chunk(spec, src, enc, path, work)
        return {
            "index": spec.index,
            "startFrame": spec.f0,
            "endFrame": spec.f1,
            "mode": spec.segment.mode,
            "hash": h,
            "reused": reused,
            "encoder": used,
            "path": str(path),
        }

    log(f"Rendering {len(specs)} part(s) ({tm.output_duration_s:.1f}s of video, {workers} at a time)")
    # Audio runs alongside the picture (numpy and ffmpeg's audio filters, mostly outside the GIL).
    auto_sfx = _auto_sfx(plan, spans, punches, fps)
    with ThreadPoolExecutor(max_workers=workers + 1) as pool:
        mixed_f = pool.submit(audio_mix.mix, plan.source.media.path, tm, plan.audio, assets, inp.seed, auto_sfx)
        results = list(pool.map(do_chunk, specs))
        mixed = mixed_f.result()
    log("Mixing audio")
    warnings += mixed.warnings
    mix_path, stem_path = work / "mix.wav", work / "speech.wav"
    audio_mix.write_mix(mixed, mix_path, stem_path)

    out = Path(inp.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    concat = work / "chunks.ffconcat"
    concat.write_text("ffconcat version 1.0\n" + "".join(f"file '{r['path']}'\n" for r in results))
    tmp = out.with_suffix(".tmp.mp4")
    run_ffmpeg(
        [
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat),
            "-i",
            str(mix_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            ex.audio_bitrate,
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            str(tmp),
        ],
        what="join the parts into the final video",
    )
    tmp.replace(out)

    static = [
        {"start": round(a / fps, 3), "end": round(b / fps, 3), "reason": f"{s.mode} still image"}
        for a, b, s in spans
        if s.mode == "fullVisual"
        and s.visual
        and (assets.get(s.visual.asset_id, "").lower().endswith((".png", ".jpg", ".jpeg", ".webp")))
    ]
    for b_ in plan.broll:
        if assets.get(b_.asset_id, "").lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            static.append({"start": round(b_.at, 3), "end": round(b_.at + b_.dur, 3), "reason": "B-roll still"})
    manifest = {
        "renderer": RENDER_VERSION,
        "output": str(out),
        "width": W,
        "height": H,
        "fps": fps,
        "frames": tm.output_frames,
        "durationS": round(tm.output_duration_s, 4),
        "safeBox": box.to_json(),
        "captions": caption_boxes,
        "captionStyle": _caption_style_json(track),
        "overlays": overlay_boxes,
        "staticRanges": static,
        "joins": [round(f / fps, 4) for f in tm.joins_output_frames()],
        "chunks": [{k: v for k, v in r.items() if k != "path"} for r in results],
        "speechStem": str(stem_path),
        "layout": [{"start": round(a / fps, 4), "end": round(b / fps, 4), "mode": s.mode} for a, b, s in spans],
        "focus": focus_info,
        "motion": {"punchIns": [round(p / fps, 3) for p in punches], "maxZoom": round(float(zoom.max()), 4)},
        "look": {k: round(v, 4) for k, v in look.items()} if look else None,
        "audio": {
            "voiceChain": mixed.voice_chain,
            "sfx": mixed.sfx,
            "loudness": mixed.loudness.to_json() if mixed.loudness else None,
        },
        "encoder": encoder,
    }
    manifest_path = work / "render.json"
    manifest_path.write_text(json.dumps(manifest, indent=1))
    return {
        "output": str(out),
        "manifest": str(manifest_path),
        "durationS": manifest["durationS"],
        "frames": tm.output_frames,
        "width": W,
        "height": H,
        "fps": fps,
        "chunks": manifest["chunks"],
        "reusedChunks": sum(1 for r in results if r["reused"]),
        "speechStem": str(stem_path),
        "warnings": warnings,
        "elapsedS": round(time.monotonic() - t_start, 2),
        "encoder": encoder,
        "loudness": manifest["audio"]["loudness"],
    }


def _auto_sfx(plan: EditPlan, spans: list, punches: list[int], fps: int) -> list[tuple[str, float]]:
    """Code-placed sounds: on layout changes and/or punch-ins, rotating kinds, never closer than 1.2 s to another
    sound (plan sounds win), never in the first 0.3 s."""
    mode = plan.audio.auto_sfx
    if mode == "off":
        return []
    cands: list[tuple[float, str]] = []
    if mode in ("layout", "all"):
        for (_, _, prev), (a, _, s) in pairwise(spans):
            if s.mode != prev.mode:
                cands.append((a / fps, "presenter" if s.mode == "inset" else "layout"))
    if mode in ("punches", "all"):
        cands += [(p / fps + 0.25, "punch") for p in punches]
    taken = [fx.at for fx in plan.audio.sfx]
    out: list[tuple[str, float]] = []
    counters = dict.fromkeys(AUTO_SFX_KINDS, 0)
    for at, kind in sorted(cands):
        if at < 0.3 or any(abs(at - t) < 1.2 for t in taken):
            continue
        kinds = AUTO_SFX_KINDS[kind]
        out.append((kinds[counters[kind] % len(kinds)], at))
        counters[kind] += 1
        taken.append(at)
    return out


def _caption_style_json(track) -> dict | None:
    st = track.style
    if st is None:
        return None
    return {"text": list(st.text), "outline": st.stroke > 0, "shadow": st.shadow, "box": st.box is not None}


def _concat(work: Path, name: str, entries: list[tuple[str | None, int]], w: int, h: int, fps: int) -> Path:
    lines = ["ffconcat version 1.0"]
    blank = _blank_png(work, w, h)
    for p, frames in entries:
        lines += [f"file '{p or blank}'", f"duration {frames / fps:.6f}"]
    lines.append(f"file '{entries[-1][0] or blank}'")
    path = work / "layers" / name
    path.write_text("\n".join(lines) + "\n")
    return path


def _blank_png(work: Path, w: int, h: int) -> str:
    p = work / "layers" / f"blank_{w}x{h}.png"
    if not p.exists():
        Image.new("RGBA", (w, h), (0, 0, 0, 0)).save(p)
    return str(p)


def _name(desc: str) -> str:
    return hashlib.sha256(f"{RENDER_VERSION}|{desc}".encode()).hexdigest()[:24]


def _caption_png(
    work: Path, cap, w: int, band: tuple[int, int], track, caption_boxes: list, seen: set, fps: int
) -> str | None:
    if cap is None:
        return None
    p = work / "layers" / f"c_{_name(f'{w}|{band}|{track.describe(cap)}')}.png"
    need_box = cap[0] not in seen
    if p.exists() and not need_box:
        return str(p)
    canvas = Image.new("RGBA", (w, band[1] - band[0]), (0, 0, 0, 0))
    bbox = draw_caption(canvas, track, cap, origin_y=band[0], frame_w=w)
    if bbox and need_box:
        seen.add(cap[0])
        chunk = track.chunks[cap[0]]
        caption_boxes.append(
            {
                "start": round(chunk.start / fps, 3),
                "end": round(chunk.end / fps, 3),
                "text": " ".join(wd.text for wd in chunk.words),
                "box": list(bbox),
            }
        )
    if not p.exists():
        canvas.save(p, compress_level=1)
    return str(p)


def _overlay_png(
    work: Path,
    active: tuple,
    w: int,
    h: int,
    orender: OverlayRenderer,
    plan: EditPlan,
    overlay_boxes: list,
    seen: set,
    box,
) -> str | None:
    if not active:
        return None
    desc = json.dumps(
        [w, h, box.to_json(), [[i, step, plan.overlays[i].model_dump(mode="json")] for i, step in active]],
        sort_keys=True,
    )
    p = work / "layers" / f"g_{_name(desc)}.png"
    need = [i for i, step in active if i not in seen and step >= anim_steps(plan.overlays[i])]
    if p.exists() and not need:
        return str(p)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for idx, step in active:
        ov = plan.overlays[idx]
        bbox = orender.draw(canvas, idx, ov, step)
        if idx not in seen and step >= anim_steps(ov):
            seen.add(idx)
            overlay_boxes.append({"index": idx, "kind": ov.kind, "at": ov.at, "box": list(bbox)})
    if not p.exists():
        canvas.save(p, compress_level=1)
    return str(p)
