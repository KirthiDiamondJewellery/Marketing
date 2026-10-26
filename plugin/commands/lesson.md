---
description: Save a correction as a dated rule in brand/lessons.md so every agent follows it from now on
argument-hint: "<the correction, e.g. never open with a question>"
allowed-tools: Read, Glob, Grep
---

# Save a lesson

Chat is not memory. A correction only sticks once it is written down. Save this correction as a rule now, in this session:

`$ARGUMENTS`

If nothing was given, ask: "What should the team do differently from now on?"

## Steps

1. Read `brand/lessons.md`.
2. Rewrite the correction as one clear, testable rule in the imperative ("Open with the result, not a question"). Keep the owner's meaning; don't widen it.
3. Check for duplicates and conflicts with existing rules. If a rule already says the same thing, tell the owner and don't add a second one. If it contradicts an older rule, show both and ask which wins; mark the older one as replaced rather than deleting it.
4. Add the evidence: what happened that prompted it (the script, post or ref, such as `ap-7` or `rf-12 v2`), in a few words.
5. Show the line and ask for a quick yes. Then append it under the right heading in `brand/lessons.md` (create a heading for the area if none fits: Scripts, Hooks, Captions, Editing, Publishing, Replies, Strategy):

   ```
   - 2026-10-14 · Open with the result, not a question · ap-7: owner rejected two question hooks
   ```

   Use today's date in the workspace timezone (from `config/attentionos.config.ts`).
6. Confirm: "Saved. Every agent reads `brand/lessons.md` before working." If the same kind of rule has come up three or more times, suggest promoting it into the relevant file (`brand/voice.md`, `brand/house-style.md` or `brand/pillars.md`).

Only edit `brand/lessons.md` (and the promotion target if the owner agrees). Never put a client's name or private details in a lesson.
