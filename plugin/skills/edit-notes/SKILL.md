---
name: edit-notes
description: How the owner gives edit notes and how the Art Director applies them. Covers spoken notes while filming ("cut that", "editor, cut"), cut-list review, and revision notes by reference ("rf-12 v2 tighten the hook") from chat, Telegram or Claude Code. Use for editing.revise runs and whenever someone asks how to change an edit.
---

# Edit notes: from the camera to v2

Every edit has a reference like `rf-12` and versions `v1`, `v2`, … Notes always name the reference, so they reach the
right edit from any channel.

## 1. While filming (spoken notes)

The cut planner listens for edit notes in the recording and obeys them:

- **"Cut that"**, **"editor, cut"**, **"scratch that"**, **"let me redo that"**, **"start over"**, **"take that out"**:
  the take just before the phrase and the phrase itself are removed. Say it, pause, and redo the line.
- **Redo a line as often as you like**: the last full take wins. If the later take trails off, both stay and the
  cut list asks you to pick.
- **Fillers and restarts go on their own**: "um", "uh" and the like always; "like", "you know", "I mean" only when
  they stand apart ("it was, like, huge", not "I like it"); a restart inside a sentence ("we tested, we tested this")
  keeps the last attempt; a doubled word ("the the") keeps one. A short sound with no word in it between two pauses
  is cut; a longer one is kept and flagged so a missed line is never lost.
- Workspaces can change the phrases in `config.modules.editing.settings.editNotePhrases`.

Every cut is listed with its reason ("Spoken edit note “cut that” removes the take before it").

## 2. Reviewing the cut list

After prep the owner gets the cut list (when "Review cuts before editing" is on in Studio; otherwise it is approved
for them and they only see the video): pauses, fillers, retakes, spoken notes, lead-in and dead tail, each numbered
with a reason. They can approve it as is, or:

- put cuts back: "restore 3 and 7" → `editing_approve_cut_list {"ref", "restore": [3, 7]}`
- remove more: "also cut 12.4 to 13.1" → `"add": [{"start": 12.4, "end": 13.1}]` (raw-footage seconds)

Only a person approves the cut list (unless the Art Director runs on autopilot).

## 3. After the render (revision notes)

Reply to the video message, or write anywhere: **`rf-12 v2 tighten the hook`**. In Claude Code:
`editing_add_revision_note {"ref": "rf-12", "note": "tighten the hook"}`. The Art Director resumes the edit's session
and makes the smallest change that does what the note says.

How notes map to plan changes:

| Note | Change |
|---|---|
| "tighten the hook", "start faster" | trim the first keep range or drop a throat-clearing first line |
| "less dead air" | add cuts at the pauses QC flagged |
| "bigger / fewer words on captions" | `captions.scale` (1.15) or `maxWords` |
| "use my brand colour on the captions" | `captions.activeColor` |
| "too many zooms", "it's jumpy" | `motion.punchIns: "off"`, `motion.jumpCutZoom: 0` |
| "more energy" | `motion.punchIns: "sentences"`, `audio.autoSfx: "all"` |
| "too dark", "washed out", "warmer" | `look.strength` or `look.grade` |
| "it sounds noisy / echoey" | `audio.voice.denoise: "strong"` (audio only) |
| "the framing drifts" | `speaker.track: false` on that segment |
| "no music", "quieter sounds", "drop the whoosh" | `audio` only (the picture is reused byte for byte) |
| "show the dashboard at the part about results" | a `split` or `fullVisual` segment with that asset |
| "the number on screen is wrong" | fix or remove the overlay; numbers need evidence |

Rules for the Art Director:

- Change only what the note asks. Unchanged segments are reused byte for byte; an audio-only note must leave the
  picture's stream hash identical (QC checks it).
- If a note needs new footage, say so; send it as a new take with `editing_start_edit`.
- A note that corrects taste ("never use a whoosh on my face cuts") is a lesson: it belongs in `brand/lessons.md`
  the same day, so the next edit inherits it. Chat is not memory.
- Save with `editing_save_plan` (a new version is created automatically), then `editing_request_render`.
