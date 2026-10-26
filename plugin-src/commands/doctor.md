---
description: Check your setup (keys, tools, database, Brand Kit) and explain how to fix anything that fails
argument-hint: "[--fix]"
allowed-tools: Read, Glob, Grep, Bash(attentionos doctor:*), Bash(../aos doctor:*)
---

# Doctor

Check this workspace's setup and explain the results to a non-technical owner.

1. Run `attentionos doctor $ARGUMENTS` with the Bash tool from the workspace root. If the `attentionos` command isn't found (Claude Code running on the computer rather than inside AttentionOS), run `../aos doctor $ARGUMENTS` from the workspace root instead; if that isn't there either, ask the owner to run `./aos doctor` in their AttentionOS folder and paste the result.
2. Read the checklist it prints. For each item:
   - **Pass:** group these into one line ("12 checks passed").
   - **Fail or warning:** say what it means in plain words, why it matters, and the exact fix (which key goes in `.env`, which app to install, which link to open). Never print the value of a secret.
3. Point to the setup guide for the level they are on (Level 1: research and scripts; Level 2: edit; Level 3: publish and engage; Level 4: Autopilot), which lives in the AttentionOS docs under `docs/setup/`.
4. If `--fix` can solve something automatically (for example installing `uv` or the speech-to-text model), say what it will download and how big it is, and ask before running it.
5. Finish with the single most useful next step.

If the doctor reports a Brand Kit error (for example `brand/brand.yaml: funnelMix: funnel mix must sum to 100`), open the file, show the line, and offer to fix it.
