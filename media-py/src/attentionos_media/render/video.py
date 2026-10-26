"""Builds and runs the ffmpeg graph for one render chunk (a span of output frames inside one layout segment).

One ffmpeg process per chunk does everything in a single filter graph (no intermediate encodes): speaker frames
are picked from the source by keep range (frame-accurate `select` on a 30 fps grid); a face-tracked crop moves per
frame (`crop` with piecewise-linear x/y expressions from `framing.py`); the automatic look (a `lutyuv` levels /
white-balance / grade table) runs on the small crop before the upscale; light luma sharpening (`unsharp`) follows an
upscale; the visual is composited per layout mode (split / fullVisual / inset with chroma key, matte or a rounded
window); camera zoom (jump-cut alternation, eased punch-ins, the hook push and plan moves, one per-frame zoom
curve) runs through `zoompan` at output resolution; B-roll is cut in; and two pre-rendered PNG layers go on top:
graphics (full frame, few states) and captions (a band of the frame, one image per distinct caption state).
Each chunk is encoded on its own so unchanged chunks can be reused byte for byte on a revision."""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw

from ..errors import MediaError
from ..ffmpeg import BT709_TAGS, run_ffmpeg
from ..schemas import Broll, CameraMove, LayoutSegment
from .face import Focus, crop_window
from .framing import ShotFraming, piecewise_expr


@dataclass
class Media:
    path: str
    width: int
    height: int
    is_image: bool
    duration: float


@dataclass
class ChunkSpec:
    index: int
    f0: int  # output frames [f0, f1)
    f1: int
    segment: LayoutSegment
    pieces: list[tuple[int, int]]  # source frames played, in order
    focus: Focus
    visual: Media | None
    visual_start: float  # seconds into the visual at f0
    broll: list[tuple[Broll, Media]] = field(default_factory=list)
    camera: list[CameraMove] = field(default_factory=list)
    layer: Path | None = None  # concat list of graphics states (full frame)
    matte: Media | None = None
    shots: list[ShotFraming] | None = None  # face-tracked framing per keep range (None = static `focus`)
    zoom: list[float] | None = None  # zoom per output frame of the chunk (None = no camera)
    zoom_focus: tuple[float, float] = (0.5, 0.4)  # zoom centre in the composed frame
    caption_layer: Path | None = None  # concat list of caption states (a band of the frame)
    caption_y: int = 0
    look: str | None = None  # lutyuv expression for the speaker's picture
    sharpen: bool = False


@dataclass
class EncodeSpec:
    w: int
    h: int
    fps: int
    crf: int
    preset: str
    maxrate: str
    threads: int
    encoder: str = "libx264"


def compress_curve(values: list[float], tol: float) -> list[tuple[int, float, int, float]]:
    """Piecewise-linear segments (n0, v0, n1, v1) that reproduce `values` within `tol` (greedy, keeps steps)."""
    out: list[tuple[int, float, int, float]] = []
    n = len(values)
    i = 0
    while i < n:
        j = i
        while j + 1 < n:
            k = j + 1
            if abs(values[k] - values[k - 1]) > max(tol * 8, 2.0) and k - i > 0:
                break  # a jump (a cut to a new framing): start a new segment
            ok = True
            span = k - i
            for m in range(i + 1, k):
                est = values[i] + (values[k] - values[i]) * (m - i) / span
                if abs(est - values[m]) > tol:
                    ok = False
                    break
            if not ok:
                break
            j = k
        out.append((i, values[i], j, values[j]))
        i = j + 1
    return out


def _even(v: float) -> int:
    return max(2, round(v / 2) * 2)


def _select_expr(pieces: list[tuple[int, int]], s_frame: int, fps: int) -> str:
    half = 0.5 / fps
    parts = [f"between(t,{(a - s_frame) / fps - half:.6f},{(b - s_frame) / fps - half:.6f})" for a, b in pieces]
    return "+".join(parts)


def _fit(label_in: str, label_out: str, bw: int, bh: int, fit: str, tag: str) -> str:
    if fit == "contain":
        return (
            f"[{label_in}]split=2[{tag}a][{tag}b];"
            f"[{tag}a]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},boxblur=24:2,eq=brightness=-0.12[{tag}bg];"
            f"[{tag}b]scale={bw}:{bh}:force_original_aspect_ratio=decrease:flags=bicubic[{tag}fg];"
            f"[{tag}bg][{tag}fg]overlay=(W-w)/2:(H-h)/2,setsar=1[{label_out}]"
        )
    return f"[{label_in}]scale={bw}:{bh}:force_original_aspect_ratio=increase:flags=bicubic,crop={bw}:{bh},setsar=1[{label_out}]"


def _mask_png(path: Path, w: int, h: int, r: int) -> Path:
    if not path.exists():
        m = Image.new("L", (w, h), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
        m.save(path)
    return path


def build_command(spec: ChunkSpec, src: Media, enc: EncodeSpec, out: Path, work: Path) -> list[str]:
    W, H, fps = enc.w, enc.h, enc.fps
    n = spec.f1 - spec.f0
    dur = n / fps
    t0 = spec.f0 / fps
    seg = spec.segment
    inputs: list[list[str]] = []
    graph: list[str] = []

    def add_input(args: list[str]) -> int:
        inputs.append(args)
        return len(inputs) - 1

    def visual_input(m: Media, start: float, d: float, loop: bool) -> int:
        if m.is_image:
            return add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{d + 0.2:.4f}", "-i", m.path])
        args = ["-stream_loop", "-1"] if loop else []
        return add_input([*args, "-ss", f"{start:.4f}", "-t", f"{d + 0.2:.4f}", "-i", m.path])

    def speaker(label: str, bw: int, bh: int, eye_at: float = 0.40) -> None:
        a0 = spec.pieces[0][0]
        last = spec.pieces[-1][1]
        idx = add_input(["-ss", f"{a0 / fps:.6f}", "-t", f"{(last - a0) / fps + 0.3:.6f}", "-i", src.path])
        cx, cy, cw, ch = crop_window(src.width, src.height, bw, bh, spec.focus, eye_at)
        xe, ye = str(cx), str(cy)
        if spec.shots:
            xe, ye = tracked_crop(spec, src, cw, ch, eye_at)
        sel = _select_expr(spec.pieces, a0, fps)
        look = f"lutyuv={spec.look}," if spec.look else ""
        sharpen = ",unsharp=5:5:0.45:5:5:0" if spec.sharpen and bh / ch >= 1.3 else ""
        graph.append(
            f"[{idx}:v]fps={fps},select='{sel}',setpts=N/({fps}*TB),crop={cw}:{ch}:x='{xe}':y='{ye}',{look}"
            f"scale={bw}:{bh}:flags=bicubic{sharpen},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=1[{label}]"
        )
        if spec.matte is not None:
            midx = add_input(["-ss", f"{a0 / fps:.6f}", "-t", f"{(last - a0) / fps + 0.3:.6f}", "-i", spec.matte.path])
            graph.append(
                f"[{midx}:v]fps={fps},select='{sel}',setpts=N/({fps}*TB),crop={cw}:{ch}:{cx}:{cy},"
                f"scale={bw}:{bh},format=gray,tpad=stop_mode=clone:stop_duration=1[{label}m]"
            )

    def visual(label: str, bw: int, bh: int) -> None:
        if spec.visual is None:
            graph.append(f"color=c=0x101014:s={bw}x{bh}:r={fps}:d={dur + 0.2:.4f},format=yuv420p[{label}]")
            return
        vloop = bool(seg.visual and seg.visual.loop)
        vi = visual_input(spec.visual, spec.visual_start, dur, vloop)
        graph.append(
            f"[{vi}:v]fps={fps},setpts=PTS-STARTPTS,format=yuv420p,tpad=stop_mode=clone:stop_duration={dur + 0.2:.4f}[{label}raw]"
        )
        graph.append(_fit(f"{label}raw", label, bw, bh, seg.fit, label))

    mode = seg.mode
    if mode == "full":
        speaker("base0", W, H)
    elif mode == "fullVisual":
        visual("base0", W, H)
    elif mode == "split":
        top_h = _even(H * seg.split_ratio)
        bot_h = H - top_h
        if seg.speaker.position == "top":
            speaker("spk", W, top_h, eye_at=0.45)
            visual("vis", W, bot_h)
            graph.append("[spk][vis]vstack=inputs=2[base0]")
        else:
            visual("vis", W, top_h)
            speaker("spk", W, bot_h, eye_at=0.42)
            graph.append("[vis][spk]vstack=inputs=2[base0]")
    elif mode == "inset":
        inset = seg.inset
        scale = inset.scale if inset else 0.45
        anchor = inset.anchor if inset else "bottom-center"
        visual("bg", W, H)
        if inset and (inset.key or inset.matte_asset_id):
            sw, sh = _even(W * scale), _even(H * scale)
            speaker("spk", sw, sh)
            if inset.key:
                k = inset.key
                col = k.color.lstrip("#")
                graph.append(
                    f"[spk]chromakey=color=0x{col}:similarity={k.similarity}:blend={k.blend},format=yuva420p[spka]"
                )
            else:
                graph.append("[spk]format=yuva420p[spkf];[spkf][spkm]alphamerge[spka]")
            margin = 0
        else:
            sw = _even(W * scale)
            sh = _even(sw * 1.25)
            speaker("spk", sw, sh, eye_at=0.38)
            r = inset.radius if inset else 36
            mask = _mask_png(work / f"mask_{sw}x{sh}_{r}.png", sw, sh, r)
            mi = add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{dur + 0.2:.4f}", "-i", str(mask)])
            graph.append(f"[{mi}:v]format=gray[mask];[spk]format=yuva420p[spkf];[spkf][mask]alphamerge[spka]")
            margin = _even(H * 0.03)
        x = {"bottom-left": f"{_even(W * 0.04)}", "bottom-right": f"W-w-{_even(W * 0.04)}"}.get(anchor, "(W-w)/2")
        graph.append(f"[bg][spka]overlay=x={x}:y=H-h-{margin}:format=auto,format=yuv420p[base0]")
    cur = "base0"
    if spec.zoom and mode != "split" and any(abs(z - 1.0) > 1e-4 for z in spec.zoom):
        fx, fy = spec.zoom_focus
        z = piecewise_expr(compress_curve(spec.zoom, 0.0004), "in", digits=4)
        graph.append(
            f"[{cur}]zoompan=z='{z}':x='clip({fx:.4f}*iw-iw/zoom/2,0,iw-iw/zoom)':"
            f"y='clip({fy:.4f}*ih-ih/zoom/2,0,ih-ih/zoom)':d=1:s={W}x{H}:fps={fps},setsar=1[cam]"
        )
        cur = "cam"
    for i, (b, m) in enumerate(spec.broll):
        off = max(0.0, b.at - t0)
        start_in = b.in_ + max(0.0, t0 - b.at)
        d = min(b.at + b.dur, t0 + dur) - max(b.at, t0)
        if d <= 0:
            continue
        bi = visual_input(m, start_in, d, False)
        graph.append(
            f"[{bi}:v]fps={fps},setpts=PTS-STARTPTS,format=yuv420p,tpad=stop_mode=clone:stop_duration={d:.4f}[br{i}raw]"
        )
        graph.append(_fit(f"br{i}raw", f"br{i}fit", W, H, b.fit, f"br{i}"))
        graph.append(f"[br{i}fit]setpts=PTS+{off:.4f}/TB[br{i}]")
        eps = 0.5 / fps
        graph.append(
            f"[{cur}][br{i}]overlay=enable='between(t,{off - eps:.4f},{off + d - eps:.4f})':eof_action=pass[b{i}]"
        )
        cur = f"b{i}"
    if spec.layer is not None:
        li = add_input(["-f", "concat", "-safe", "0", "-i", str(spec.layer)])
        graph.append(f"[{li}:v]setpts=PTS-STARTPTS,format=rgba[lay]")
        graph.append(f"[{cur}][lay]overlay=0:0:format=auto:eof_action=repeat[ov]")
        cur = "ov"
    if spec.caption_layer is not None:
        ci = add_input(["-f", "concat", "-safe", "0", "-i", str(spec.caption_layer)])
        graph.append(f"[{ci}:v]setpts=PTS-STARTPTS,format=rgba[cap]")
        graph.append(f"[{cur}][cap]overlay=0:{spec.caption_y}:format=auto:eof_action=repeat[cv]")
        cur = "cv"
    graph.append(f"[{cur}]format=yuv420p,setsar=1,tpad=stop_mode=clone:stop_duration=1[out]")
    args: list[str] = []
    for a in inputs:
        args += a
    args += [
        "-filter_complex",
        ";".join(graph),
        "-map",
        "[out]",
        "-an",
        "-frames:v",
        str(n),
        *encoder_args(enc),
        "-pix_fmt",
        "yuv420p",
        "-g",
        str(fps * 2),
        "-r",
        str(fps),
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-map_metadata",
        "-1",
        *BT709_TAGS,
        str(out),
    ]
    return args


def encoder_args(enc: EncodeSpec) -> list[str]:
    bufsize = _double(enc.maxrate)
    if enc.encoder == "h264_videotoolbox":
        return [
            "-c:v",
            "h264_videotoolbox",
            "-b:v",
            enc.maxrate,
            "-maxrate",
            enc.maxrate,
            "-bufsize",
            bufsize,
            "-profile:v",
            "high",
            "-realtime",
            "0",
            "-allow_sw",
            "1",
        ]
    if enc.encoder.startswith("h264_"):  # nvenc, qsv, amf, vaapi-less hardware encoders
        return [
            "-c:v",
            enc.encoder,
            "-b:v",
            enc.maxrate,
            "-maxrate",
            enc.maxrate,
            "-bufsize",
            bufsize,
            "-profile:v",
            "high",
            "-bf",
            "0",
        ]
    return [
        "-c:v",
        "libx264",
        "-preset",
        enc.preset,
        "-tune",
        "film",
        "-crf",
        str(enc.crf),
        "-maxrate",
        enc.maxrate,
        "-bufsize",
        bufsize,
        "-profile:v",
        "high",
        "-bf",
        "0",
        "-threads",
        str(enc.threads),
    ]


def tracked_crop(spec: ChunkSpec, src: Media, cw: int, ch: int, eye_at: float) -> tuple[str, str]:
    """Per-frame crop position (source pixels) for the chunk's output frames, as ffmpeg expressions of `n`."""
    assert spec.shots is not None
    starts = [s.src_f0 for s in spec.shots]
    xs: list[float] = []
    ys: list[float] = []
    for a, b in spec.pieces:
        k = max(0, bisect.bisect_right(starts, a) - 1)
        shot = spec.shots[k]
        for f in range(a, b):
            while k + 1 < len(spec.shots) and f >= spec.shots[k + 1].src_f0:
                k += 1
                shot = spec.shots[k]
            fx, fy = shot.at(f)
            xs.append(min(max(0.0, fx * src.width - cw / 2), src.width - cw))
            ys.append(min(max(0.0, fy * src.height - ch * eye_at), src.height - ch))
    x_expr = piecewise_expr(compress_curve(xs, 0.6), "n")
    y_expr = piecewise_expr(compress_curve(ys, 0.6), "n")
    return x_expr, y_expr


def _double(rate: str) -> str:
    unit = rate[-1] if rate and rate[-1].isalpha() else ""
    num = float(rate[:-1] if unit else rate)
    return f"{num * 2:g}{unit}"


def encode_chunk(spec: ChunkSpec, src: Media, enc: EncodeSpec, out: Path, work: Path) -> str:
    """Encodes one chunk; a hardware encoder that fails falls back to libx264. Returns the encoder used."""
    tmp = out.with_suffix(".tmp.mp4")
    try:
        run_ffmpeg(build_command(spec, src, enc, tmp, work), what=f"render part {spec.index + 1} of the video")
    except MediaError:
        if enc.encoder == "libx264":
            raise
        enc = EncodeSpec(enc.w, enc.h, enc.fps, enc.crf, enc.preset, enc.maxrate, enc.threads, "libx264")
        run_ffmpeg(build_command(spec, src, enc, tmp, work), what=f"render part {spec.index + 1} of the video")
    tmp.replace(out)
    return enc.encoder
