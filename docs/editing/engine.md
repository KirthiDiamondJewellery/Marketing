# The cut engine

How `media-py` turns a raw take into a finished 1080×1920 reel, and why each choice was made. The LLM only writes
the plan; everything below is deterministic code with defaults set per format, so a plan stays small (cost under
$0.50 per reel) and quality comes from the code.

## Pipeline

```
prep ──► cut-plan ──► (review) ──► plan ──► render ──► finish ──► qc
 │         │                                 │           │          │
 │         └ edit.json (source seconds)      │           │          └ checks on the real MP4
 ├ proxy (linked when edit-ready)            │           └ verify loudness; 2-pass loudnorm only if needed
 ├ analysis.json (faces, colour, sheet)      └ chunks: one ffmpeg graph each, reused when unchanged
 └ audio.wav, silence.json, transcript
```

## Feature matrix

| Area | Feature | How it works |
|---|---|---|
| Cutting | Dual-threshold silence | Strict and broad detectors must agree |
| | Word guards | Nothing within a pad of a word is cut; word tails run to silence |
| | Approval-gated cut list | A reason for every cut |
| | Source → output time map | Shared by every layer |
| | Spoken edit notes ("cut that") | Supported |
| | Last full take wins | Fuzzy take matching with rapidfuzz (Indel), difflib fallback |
| | Restarts and stutters inside a sentence | Last attempt kept; intentional doubles ("very very") kept |
| | Filler words | "um/uh" always; "like / you know / I mean" only when set off by punctuation or pauses |
| | Wordless sound between pauses (missed "um", breath, lip smack) | Cut when short and voiced; flagged when long |
| | Zero dead space | No pause over 0.15 s (p90 0.10 s), with a natural micro-pause (0.10 s) kept after full stops |
| | Audio at joins | Equal-power crossfade, 16 ms default |
| Framing | Face detection (YuNet, Haar fallback) | Tracked: Kalman + RTS smoothing, outlier gate, dead zone, pan-speed cap; static unless the speaker moves; jump cuts hold framing |
| | Jump-cut zoom alternation | 1.0 / 1.07 |
| | Punch-ins on emphasis words or sentence starts | Eased (smoothstep), spaced, never within 0.6 s of a cut |
| | Hook push | +4% across the first shot |
| Captions | Word-by-word highlight | Active word in the brand colour, every reel style; `captions.activeColor` |
| | 1–3 words per line | Safe-zone aware, emphasis bolder; commas left by removed fillers are cleaned |
| | Rendering | PIL band PNGs (only the caption rows), cached by content; works without libass |
| Audio | High-pass, compressor | Compressor at a measured operating point |
| | Denoise | `afftdn`, strength from the measured speech-to-room ratio, skipped on clean rooms |
| | De-esser | `deesser` |
| | Loudness −14 LUFS / −1 dBTP | BS.1770 in numpy inside the render (+ true-peak limiter); finish verifies and copies |
| | Music bed with ducking | Sidechain envelope, −10 dB |
| | Synthesised SFX (CC0 by construction) | 12 kinds, ±1 semitone re-pitch per use; code-placed on layout changes and punch-ins (`audio.autoSfx`) |
| Look | Colour | Automatic levels + white balance from measured statistics (one LUT, same for every take) + optional grade |
| | Sharpen | Light luma unsharp only when a crop is upscaled |
| | HDR → SDR tone map | Applied when the source is HDR |
| QC | Format, black, freeze, clipping, dead tail, pauses, loudness | Checked on the real MP4 |
| | Caption safe zone | Checked |
| | Caption contrast on the real frames | WCAG ratio behind each caption; outlined/boxed styles pass |
| | Top band | Brightness and busyness (54×9 grid spread) |
| | First frame | Not black or blank |
| | Stream hash on audio-only revisions | Checked |
| Speed | Edit-ready source used as the proxy | H.264/HEVC 8-bit, 30 fps, SDR, ≤1920 |
| | Proxy encode | x264 ultrafast CRF 16 (near-lossless intermediate) |
| | Analysis cached by content hash | `analysis.json` + cache dir |
| | One ffmpeg graph per chunk | Chunks reused across revisions; parallelism sized to the CPU; audio mixed alongside the video |
| | Hardware encoders | Opt-in (`export.encoder: "hardware"` / `ATTENTIONOS_ENCODER`), automatic fallback to libx264 |
| | QC passes | 1 video decode + 1 audio decode |

## Plan fields (all optional)

| Field | Default | What it does |
|---|---|---|
| `motion.jumpCutZoom` | 0.07 | zoom alternation at cuts (`full` segments) |
| `motion.punchIns` | `"emphasis"` | `off` / `emphasis` (on `captions.emphasisWords`) / `sentences` |
| `motion.punchScale`, `minGapS`, `hookPush`, `maxZoom` | 0.06, 4 s, true, 1.18 | punch size and spacing, hook push, zoom cap |
| `look.color`, `strength`, `grade`, `sharpen` | auto, 0.7, none, auto | automatic correction, grade (`pop`, `vivid`, `warm`, `cool`, `mono`) |
| `audio.voice.denoise`, `deess`, `compress`, `highpassHz` | auto, true, true, 80 | voice clean-up |
| `audio.crossfadeMs` | 16 | equal-power crossfade at joins |
| `audio.autoSfx` | off | `layout` / `punches` / `all` |
| `captions.activeColor`, `emphasisColor`, `scale` | style | brand colour, emphasis colour, size |
| `layout.segments[].speaker.track` | true | follow the face inside a shot |
| `export.encoder` | auto (libx264) | `hardware` for VideoToolbox / NVENC / QSV with fallback |

Formats set these per format (`motion`, `look`, `audio.voice` in `templates/formats/*/format.json`); `draftPlan`
copies them into the draft so the LLM rarely touches them.

## Speed

60 s synthetic talking head on an 8-core laptop (Apple M3), the whole chain prep → cut-plan → render → finish →
QC, measured while other jobs shared the machine (`ATTENTIONOS_PERF=1 uv run pytest -k perf -s`):

| Source (60 s, 44.5 s output) | Wall (CPU) |
|---|---|
| H.264 1080p landscape, reframed to 9:16 | 16.5 s (64 CPU-s) |
| HEVC 1080×1920, 30 fps | 16.5 s (68 CPU-s) |
| HEVC at 29.97 fps (needs a real proxy) | ~26 s (proxy encode ≈ 10 s) |

Per stage (landscape): prep 2.3 s, cut-plan 0.9 s, render 10.2 s, finish 0.5 s, QC ≈ 2.5 s. The engine does a lot
per reel (face analysis, the look, zoom curves, the voice chain) and stays fast because the proxy is linked or
encoded at ultrafast, analysis runs once alongside it, audio mixes while the video encodes, finish verifies instead
of re-encoding the audio, and QC decodes the file once.

Most of the remaining time is the per-chunk encode (libx264 veryfast at 1080×1920) and, for footage that needs a
proxy, the proxy encode.

## Dependencies

Core: numpy, scipy (filters, true-peak resampling), rapidfuzz, Pillow, pydantic. Extras: `vision`
(opencv-python-headless: YuNet face detection via OpenCV DNN, model fetched by `models download face-yunet`, MIT),
`asr`, `parakeet`, `embed`. MediaPipe was not used: YuNet through OpenCV installs cleanly on macOS and linux/arm64.
