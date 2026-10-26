"""`prep`: everything the planner needs from raw footage, written to a work dir. Re-runnable: finished steps are
skipped when the source has not changed.

- `proxy.mp4`: 30 fps CFR H.264, BT.709 SDR, rotation applied, aspect kept (long side ≤ 1920), keyframe every
  second so the renderer can seek fast. The renderer frames it (face-aware) per layout. A source that already is
  all of that (8-bit 4:2:0 H.264 or HEVC at the target rate, SDR, no rotation, ≤ 1920) is linked instead of
  re-encoded. Otherwise (HDR, rotated, 4K, 29.97 or VFR phone footage) the proxy is a near-lossless intermediate
  (x264 ultrafast, CRF 16).
- `analysis.json`: faces, colour statistics and contact-sheet frames from ONE low-rate decode (`analysis.py`),
  run while the proxy encodes; the renderer reads it instead of decoding again.
- `audio.wav`: 16 kHz mono for ASR and silence analysis.
- `silence.json`: the loudness-derived dual-threshold silence map.
- `sheet.jpg`: a contact sheet, one frame every few seconds with timestamps.
- `transcript.json`: word-level ASR (engine from the input; `none` skips it).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

import numpy as np
from PIL import Image, ImageDraw, ImageOps
from pydantic import Field

from .analysis import analyze_video, write_sidecar
from .asr import AsrInput, transcribe
from .audio import SR, SilenceOptions, measure_loudness, silence_map
from .errors import BadInput, MediaError, NotFound
from .ffmpeg import BT709_TAGS, decode_audio, has_filter, log, run_ffmpeg
from .fonts import font
from .probe import probe_file
from .schemas import Wire, Word


class PrepAsr(Wire):
    engine: Literal["whispercpp", "parakeet", "stub", "none"] = "whispercpp"
    model: str | None = None
    language: str | None = None
    prompt: str | None = None
    cache_dir: str | None = None
    stub_words: list[Word] | None = None


class PrepInput(Wire):
    source: str
    work_dir: str
    fps: int = Field(default=30, ge=1, le=120)
    proxy: bool = True
    # link: reuse an edit-ready source as the proxy (no re-encode); encode: always make one.
    proxy_mode: Literal["auto", "encode"] = "auto"
    contact_sheet: bool = True
    asr: PrepAsr = Field(default_factory=PrepAsr)
    silence: dict = Field(default_factory=dict)
    force: bool = False


def to_bt709_filter(video: dict) -> str:
    """Lands any source (HLG/PQ HDR, BT.2020, BT.601) in BT.709 SDR with the filters this ffmpeg has."""
    trc, prim = video.get("colorTransfer") or "", video.get("colorPrimaries") or ""
    if trc in ("arib-std-b67", "smpte2084"):
        if has_filter("zscale") and has_filter("tonemap"):
            return (
                "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:desat=0,"
                "zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
            )
        return "colorspace=all=bt709:iall=bt2020:itrc=bt2020-10:format=yuv420p"
    if prim == "bt2020":
        return "colorspace=all=bt709:iall=bt2020:format=yuv420p"
    return "scale=in_color_matrix=auto:out_color_matrix=bt709:out_range=tv,format=yuv420p"


def proxy_ready(info: dict, fps: int) -> bool:
    """True when the source already is what the proxy would be, so it can be linked instead of re-encoded."""
    v = info.get("video") or {}
    return (
        v.get("codec") in ("h264", "hevc")
        and v.get("pixFmt") in ("yuv420p", "yuvj420p")
        and v.get("rotation", 0) == 0
        and v.get("fps") is not None
        and abs(v["fps"] - fps) < 0.01
        and v.get("colorTransfer") not in ("arib-std-b67", "smpte2084")
        and v.get("colorPrimaries") not in ("bt2020",)
        and max(v.get("width", 0), v.get("height", 0)) <= 1920
        and v.get("width", 1) % 2 == 0
        and v.get("height", 1) % 2 == 0
    )


def make_proxy(src: str, dst: Path, info: dict, fps: int) -> None:
    v = info["video"]
    # Long side at most 1920, both sides even (H.264 4:2:0 needs even dimensions), aspect kept.
    chain = (
        f"fps={fps},{to_bt709_filter(v)},"
        "scale='if(gte(iw,ih),min(1920,trunc(iw/2)*2),-2)':'if(gte(iw,ih),-2,min(1920,trunc(ih/2)*2))':flags=bicubic,format=yuv420p"
    )
    tmp = dst.with_suffix(".tmp.mp4")
    # A near-lossless intermediate: ultrafast at CRF 16 encodes ~2.5x faster than veryfast at the same quality
    # target; only the renderer reads it.
    tail = [
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        chain,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "16",
        "-g",
        str(fps),
        "-keyint_min",
        str(fps),
        "-sc_threshold",
        "0",
        *BT709_TAGS,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        str(tmp),
    ]
    # Hardware decode (VideoToolbox) saves CPU but measured slower wall-clock than software decode on Apple
    # silicon for 1080p, so it is opt-in.
    hw = (
        sys.platform == "darwin"
        and v.get("codec") in ("hevc", "h264", "prores")
        and os.environ.get("ATTENTIONOS_HWDECODE") == "1"
    )
    try:
        run_ffmpeg([*(["-hwaccel", "videotoolbox"] if hw else []), "-i", src, *tail], what="make the edit proxy")
    except MediaError:
        if not hw:
            raise
        run_ffmpeg(["-i", src, *tail], what="make the edit proxy")
    tmp.replace(dst)


def link_proxy(src: str, dst: Path) -> bool:
    """Points proxy.mp4 at an edit-ready source (hard link, else symlink). False when neither works."""
    tmp = dst.with_suffix(".tmp.mp4")
    tmp.unlink(missing_ok=True)
    for make in (os.link, os.symlink):
        try:
            make(str(Path(src).resolve()), str(tmp))
            tmp.replace(dst)
            return True
        except OSError:
            continue
    return False


def extract_wav(src: str, dst: Path, has_audio: bool, duration: float) -> None:
    tmp = dst.with_suffix(".tmp.wav")
    if has_audio:
        run_ffmpeg(
            ["-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(tmp)], what="extract the audio"
        )
    else:  # silent screen recording: a silent track keeps silence analysis and ASR simple
        run_ffmpeg(
            ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", f"{duration:.3f}", "-c:a", "pcm_s16le", str(tmp)],
            what="make a silent track",
        )
    tmp.replace(dst)


def contact_sheet(frames: list[tuple[float, np.ndarray]], dst: Path, cols: int = 6) -> None:
    """A grid of the analysis pass's sample frames (RGB) with timestamps."""
    tw, th = 216, 384
    tiles = []
    for t, rgb in frames:
        im = ImageOps.pad(Image.fromarray(rgb), (tw, th), color=(0, 0, 0))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, 74, 26), fill=(0, 0, 0))
        d.text((5, 4), f"{t:.1f}s", fill=(255, 220, 0), font=font("geist", 16, 600))
        tiles.append(im)
    if not tiles:
        return
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (tw * min(cols, len(tiles)), th * rows), (0, 0, 0))
    for i, im in enumerate(tiles):
        sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
    sheet.save(dst, quality=85)


def _fingerprint(path: str) -> str:
    st = Path(path).stat()
    return hashlib.sha256(f"{Path(path).resolve()}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:16]


def prep(payload: dict) -> dict:
    inp = PrepInput.model_validate(payload)
    src = Path(inp.source)
    if not src.exists():
        raise NotFound("Source", inp.source)
    work = Path(inp.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    state_path = work / "prep.json"
    fp = _fingerprint(inp.source)
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if state.get("fingerprint") != fp or inp.force:
        state = {"fingerprint": fp}
    info = probe_file(src)
    if not info["video"] and not info["audio"]:
        raise BadInput("The source has no video or audio stream.")
    duration = info["durationS"]
    out: dict = {"source": str(src), "workDir": str(work), "probe": info}

    proxy = work / "proxy.mp4"
    is_video = bool(info["video"]) and not info["video"].get("isImage")
    pool = ThreadPoolExecutor(max_workers=2)
    proxy_job = None
    if inp.proxy and is_video and (not proxy.exists() or "proxy" not in state):
        if inp.proxy_mode == "auto" and proxy_ready(info, inp.fps) and link_proxy(str(src), proxy):
            state["proxy"] = "linked"
            log("The source is edit-ready: linked it as the proxy")
        else:
            log("Making the edit proxy")
            proxy_job = pool.submit(make_proxy, str(src), proxy, info, inp.fps)
            state["proxy"] = "encoded"

    # One low-rate decode of the source for faces, colour and the contact sheet, alongside the proxy encode.
    sheet = work / "sheet.jpg"
    analysis_job = None
    want_sheet = inp.contact_sheet and is_video and (not sheet.exists() or "sheet" not in state)
    sheet_frames: list = []
    if is_video and (not (work / "analysis.json").exists() or "analysis" not in state or want_sheet):
        n_sheet = max(4, min(24, int(duration // 3) or 4)) if want_sheet else 0
        v = info["video"]
        analysis_job = pool.submit(
            analyze_video,
            str(src),
            v["displayWidth"],
            v["displayHeight"],
            duration,
            sheet_frames=n_sheet,
            sheet_sink=sheet_frames,
        )

    wav = work / "audio.wav"
    if not wav.exists() or "audio" not in state:
        extract_wav(str(src), wav, info["audio"] is not None, duration)
        state["audio"] = True
    out["audio"] = str(wav)

    so_raw = {"strict_db": -42.0, "broad_db": -35.0, **{_snake(k): v for k, v in inp.silence.items()}}
    so = SilenceOptions(**{k: v for k, v in so_raw.items() if k in SilenceOptions.__dataclass_fields__})
    x = decode_audio(wav, SR)
    loud = measure_loudness(wav) if info["audio"] else None
    smap, _ = silence_map(x, SR, loud, so)
    (work / "silence.json").write_text(json.dumps(smap.to_json(), indent=1))
    out["silenceMap"] = smap.to_json()

    if analysis_job is not None:
        try:
            analysis = analysis_job.result()
            # Next to the proxy (the renderer's source); never next to the user's raw file.
            write_sidecar(analysis, proxy if inp.proxy else work / src.name)
            state["analysis"] = True
            if want_sheet and sheet_frames:
                contact_sheet(sorted(sheet_frames, key=lambda f: f[0]), sheet)
                state["sheet"] = True
        except MediaError as exc:
            log(f"Skipped the picture analysis: {exc.message}")
    if (work / "analysis.json").exists():
        out["analysis"] = str(work / "analysis.json")
    if proxy_job is not None:
        proxy_job.result()
    pool.shutdown()
    if inp.proxy and is_video and proxy.exists():
        out["proxy"] = str(proxy)
        out["proxyMode"] = state.get("proxy") if isinstance(state.get("proxy"), str) else "encoded"
    if inp.contact_sheet and sheet.exists():
        out["contactSheet"] = str(sheet)

    tpath = work / "transcript.json"
    asr_key = f"{inp.asr.engine}:{inp.asr.model}:{inp.asr.language}"
    if inp.asr.engine != "none":
        if not tpath.exists() or state.get("asr") != asr_key:
            asr_in = AsrInput(
                path=str(wav),
                engine=inp.asr.engine,
                model=inp.asr.model,
                language=inp.asr.language,
                prompt=inp.asr.prompt,
                cache_dir=inp.asr.cache_dir,
                stub_words=inp.asr.stub_words,
            )
            transcript = transcribe(asr_in.dump())
            tpath.write_text(json.dumps(transcript, indent=1))
            state["asr"] = asr_key
        out["transcript"] = json.loads(tpath.read_text())
        out["transcriptPath"] = str(tpath)
    state_path.write_text(json.dumps(state, indent=1))
    return out


def _snake(k: str) -> str:
    return "".join("_" + c.lower() if c.isupper() else c for c in k)
