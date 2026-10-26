/**
 * Prompts for the Art Director's LLM jobs. The LLM only writes the plan (plan, then a deterministic
 * render), which is what keeps a reel under $0.50 of LLM spend. Prompts reference Brand Kit files by path and never
 * embed a brand's words.
 */

const PLAN_RULES = [
  "- layout.segments: cover 0 to outputDurationS with no gaps or overlaps, using only the format's modes; time is OUTPUT seconds.",
  "- captions: keep the format's style; set 1 to 2 emphasisWords per line (the words that carry the meaning). If the house style names a brand colour, set captions.activeColor to it (#RRGGBB).",
  "- overlays: a hook headline on frame 1 when the format has a headline slot. The draft's headline is just the first spoken line: rewrite it as the claim in at most 8 words, or remove it. Charts, screenshots, post cards and any number on screen need an evidenceId from the claims list. Never invent a number.",
  "- motion, look, audio.voice and audio.autoSfx come pre-filled from the format, and the code does the rest (face tracking, jump-cut zooms, colour, denoise, loudness). Change them only when the house style or a note asks.",
  "- broll: only attached assets with a license and provenance; at most 8 stills and 6 loops.",
  "- audio.sfx: follow the format's audio rule (none, sparse or beats); never the same kind twice in a row, at most one every 1.2 s, never on a cut inside a sentence.",
  "- camera: punch-ins or pushes only where the format allows.",
  "- keepRanges: leave them as approved unless the format's length or a note needs a trim; never cut inside a word.",
  "- Frame 1 must work as a thumbnail and the claim must land by the format's hookBy second.",
].join("\n");

export function planPrompt(ref: string): string {
  return [
    `Write the edit plan for ${ref}.`,
    "",
    "1. Read brand/house-style.md (the editing taste every edit inherits) and brand/lessons.md if it exists. Follow them; never put their wording on screen.",
    `2. Call editing_get_plan with {"ref": "${ref}"}. It returns the format's rules, the transcript in OUTPUT seconds, the claim ids you may cite, attached media and a draft plan.`,
    "3. Edit the draft only where the format and house style call for it:",
    PLAN_RULES,
    `4. Save with editing_save_plan {"ref": "${ref}", "plan": {...}}. Omit "source" (the tool fills it). If it reports problems, fix exactly those and save again, at most 3 times.`,
    `5. Call editing_request_render {"ref": "${ref}"}.`,
    "",
    'Reply with JSON only: {"ref": "...", "saved": true, "summary": "one line: format, length, layout, and what the first 3 seconds do"}.',
  ].join("\n");
}

export function revisePrompt(input: { ref: string; fromVersion: number; notes: string; attachments?: { kind: string; url?: string; fileName?: string }[] }): string {
  const hasTake = (input.attachments ?? []).some((a) => a.kind === "video");
  return [
    `Revise ${input.ref} from v${input.fromVersion}. The owner's notes:`,
    `"""${input.notes.trim() || "(no notes)"}"""`,
    "",
    `1. Call editing_get_plan with {"ref": "${input.ref}"} (it has the current plan, the transcript in OUTPUT seconds and the earlier notes). Re-read brand/house-style.md if the notes touch taste.`,
    "2. Make the smallest change that does what the notes ask. Leave every other field exactly as it is: unchanged parts of the video are reused byte for byte, and an audio-only change (music, sound effects, levels) must touch only `audio`.",
    '   "Tighten the hook" means trimming keepRanges or pauses in the first seconds; "bigger captions" means captions.scale (1.15) or maxWords; "too many zooms" means motion (punchIns "off", jumpCutZoom 0); "too dark" or "washed out" means look (strength, grade); "noisy" or "echo" means audio.voice.denoise "strong"; keep everything else.',
    PLAN_RULES,
    hasTake
      ? "3. The owner attached a new take. This version can't splice new footage automatically: apply the notes that don't need it, and say in your summary that the new take needs a new edit (editing_start_edit with the file path)."
      : "3. If a note can't be done with the plan alone (it needs new footage), say so in your summary instead of guessing.",
    `4. Save with editing_save_plan {"ref": "${input.ref}", "plan": {...}} (omit "source"); fix what it reports, at most 3 tries. Then call editing_request_render {"ref": "${input.ref}"}.`,
    "",
    'Reply with JSON only: {"ref": "...", "saved": true, "summary": "one line: what changed"}.',
  ].join("\n");
}
