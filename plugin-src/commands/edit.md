---
description: Turn raw footage into a post-ready reel with captions, cuts and quality checks
argument-hint: "<path to raw video, e.g. media/raw/take-01.mp4>"
allowed-tools: Read, Glob, Grep
---

# Edit a video

Have the Art Director edit: `$ARGUMENTS`

If no file was given, list recent files in `media/raw/` and ask which one.

## Read first

- `brand/house-style.md` (editing taste every edit inherits) and `brand/lessons.md`.
- The editing skills that came with this plugin. Follow them.
- The content piece this footage belongs to, if the owner names one (the `editing_*` and `scripting_*` tools can look it up), so the edit matches the approved script.

## Method

1. **Prep** with the `editing_*` tools from the attentionos MCP server: transcript with word timings, silence map and contact sheets. Spoken edit notes in the take ("editor, cut that") are obeyed. The last full take wins.
2. **Cuts.** Propose the cut list (`edit.json`). Silence cuts happen only where both detectors agree; the hook is protected. Show the owner what will be removed if anything is unusual.
3. **Plan.** Pick a format template and write the edit plan (captions, overlays, b-roll with provenance and license, sound, camera moves). Every on-screen claim needs evidence.
4. **Render and QC** through the tools. Quality checks (loudness, black frames, freezes, pauses over 0.15s, caption safe zone, 1080×1920 at 30fps) are deterministic code. If QC fails, fix the plan and render again.
5. **Review.** Share the output path, the edit ref (for example `rf-12`), the QC summary and the approval ref. Revisions: the owner can reply with notes here or in chat as `rf-12 v2 <notes>`.

Keep LLM work to the plan; rendering and finishing are done by code. Never use music, sound effects, fonts or footage without a clear license.
