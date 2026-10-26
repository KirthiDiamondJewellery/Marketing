# Editing

The Art Director turns raw footage into a finished vertical video. The model writes a plan; deterministic code does the cutting, rendering and checking. That keeps quality consistent and cost low: the target is **under $0.50 of model use per reel**.

| | |
|---|---|
| Agent | Art Director (`Ad`) |
| Tier | Default (on after setup); the motion engine is opt-in |
| Setup level | [Level 2](../setup/level-2.md) |
| Needs | ffmpeg, uv, a speech-to-text model (whisper.cpp by default) |
| Brand Kit files | `brand/house-style.md` |

## What it does

### Prep

- A proxy, a word-level transcript, a silence map and contact sheets.
- **Dual-threshold silence detection with word protection.** A cut is only made where a strict and a broad detector agree, and the hook is protected, so words are never clipped. The proposed cuts are saved as a reviewable `edit.json`.
- **Last full take wins.** Spoken edit notes ("editor, cut that") are obeyed. Restarts and stutters inside a sentence keep the last attempt.
- **Fillers go.** "Um" and "uh" always; "like", "you know" and "I mean" only when they stand apart from the sentence. Short wordless sounds between pauses go too.
- **Zero dead space**, with a natural breath (about 0.1 s) kept after each full stop.
- One low-rate pass over the picture finds faces and measures colour; the result is cached, so renders and revisions never analyze the footage again. Footage that is already edit-ready (H.264 or HEVC, 30 fps, SDR) is used as is instead of being re-encoded.
- A **time map** converts source time to output time, so captions, overlays, sound effects and camera moves all land on the right frame.

### Plan

The Art Director writes an **edit plan** from a format template: layout segments, caption style and emphasis words, overlays, b-roll with provenance and license, sound, camera moves and export settings. Templates include raw talking head, split demo, news green screen and pop-up presenter. Each template carries **shoot directions**, which the daily brief shows you before you film.

### Render

- **Cut engine** (default): word-by-word captions in your brand colour, programmatic graphics, face-tracked framing for horizontal footage (smoothed, still unless you move), jump-cut zooms and eased punch-ins on key words, automatic levels and white balance, voice clean-up (denoise, de-ess, gentle compression), crossfaded cuts, synthesized sound effects, a ducked music bed, green-screen inset and loudness normalization. Each part of the video renders in one ffmpeg pass and is reused on revisions when it didn't change. See [the engine notes](../editing/engine.md).
- **Motion engine** (opt-in, planned for v0.4): Remotion-based motion graphics. Remotion requires a paid company license for companies with more than three people; you must acknowledge this before enabling it.

### Finish and quality checks

No model is involved:

- loudness to −14 LUFS and −1 dBTP (the render already hits it; finishing verifies, and runs two-pass normalization only when needed);
- checks for a black or blank first frame, black frames, freezes, a dead tail, clipping, pauses over 0.15 seconds, caption safe zone, caption contrast, top-band brightness and busyness, and 1080×1920 at 30 fps;
- stream-hash checks so audio-only revisions don't silently change the picture.

**Preflight gates** run at plan, render and final: structure, assets exist, every claim on screen has evidence, layout ratios, and your sign-offs.

### Revision loop

Each edit has a reference like `rf-12`. Reply to the video in Telegram, or type `rf-12 v2 <notes>` anywhere, and the same agent session resumes with your notes. Approved segments stay byte-for-byte the same. Everything inherits `brand/house-style.md`.

## What you'll see

- `/attention:edit <file>` in Claude Code.
- The finished video in Telegram or Discord with the QC report and Approve, Reject buttons.

## Approvals

Every finished edit waits for your approval before it can be scheduled.

## Settings

`modules.editing.settings` holds the default format template and export settings. Each format sets the engine defaults (motion, look, voice clean-up, sound effects); a plan can override any of them, and so can a revision note ("too many zooms", "bigger captions"). Set `ATTENTIONOS_ENCODER=hardware` to use VideoToolbox, NVENC or Quick Sync when present (libx264 is the default: it is deterministic and, on laptop CPUs, as fast for vertical video). `providers.asr` chooses the speech-to-text engine; `providers.renderer` chooses `cut` or `motion`.

## Limits

- Footage should be vertical. Horizontal footage is reframed, which can crop.
- Music and sound effects must be CC0 or synthesized; nothing else ships with AttentionOS.
