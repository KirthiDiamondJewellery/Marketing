# Scripting (Copywriter)

Core module, setup level 1. Turns a content idea into a script the owner can film, in their own voice, with every hook traced to its source and every number traced to evidence. The model does the writing; the gates in `@attentionos/guardrails` decide whether it ships.

## What it does

- **Remix first.** A content item with an `external_post` source is a remix: the Copywriter remakes that proven post closely (same hook wording and pattern, beats, length, format and CTA mechanic; the owner's topic specifics, proof and words). It works from the source's remix blueprint (research teardown, tool-less and checked in code), never the transcript. The validator gets `rules.remix` (guardrails `checkRemix`): the source creator's handle and `swapOut` terms, their numbers without a `proof:` source, and long copied passages after the hook fail; drifting from the source's hook, length or beat count warns. `brief.remixOf.line` ("Based on @handle's reel, 1.2M views, 14x their normal") is what Studio shows. Without a source, the Copywriter looks for one first (`scripting_find_remix_sources`, `scripting_use_remix_source`). `scripting.remix-ready` starts a remix script that was waiting for its source's teardown. Every brief carries `ownWinners`, the owner's best posts against their own normal.
- **Hook banks.** `scripting.harvest-hooks` (daily) adds the owner's openers that beat their own median by 3x or more (own bank) and the spoken hooks of competitor outliers (competitor bank, capped at 300, scores halve every 60 days). Competitor hooks are untrusted text: tool-using agents only see their structure, written by the tool-less `scripting.classify-hooks` job and validated in code.
- **Pattern taxonomy.** 16 named, niche-free hook patterns with definitions and abstract templates (`src/taxonomy.ts`), plus a regex pre-classifier.
- **Hook selection.** Weighted by the `learn` module's hook-pattern weights when it is installed (`getFeatureWeights(ws, "hook_pattern")`), uniform otherwise, with 20% exploration.
- **Scripts.** `scripting.write-script` writes the 6-beat script (hook, turn, proof, rehook, play, close) with a claim ledger and per-platform captions, saves a new version with the validator report, revises from the exact fixes (at most 2 revisions) and asks for human approval. Only a person can approve, and never while a check fails.
- **Approvals.** Every passing script asks for the owner's OK (kind `script`) unless the Copywriter is on `autopilot`, in which case it is approved straight away. The decision works the same from every surface (migration `20261021000000_scripting_approval_effects.sql`): approve makes the version the approved script and the piece ready to film; reject sends the piece back to the ideas list; "request changes" with notes queues `scripting.write-script` with `{ contentId, revise: { approvalRef, fromVersion, notes } }` (dedupe `write-script:<content id>:revise:<ref>`), and the brief's `latestScript` carries the previous version and the note.
- **Brief hand-off.** The Strategist queues `scripting.write-script` for the day's filmable ideas (see the strategy module's `autoScripts` setting), and Studio's Film page asks for more on demand.
- **Captions.** `scripting.captions`: one transcript to strict per-platform JSON.
- **Text posts.** `scripting.text-posts` (weekly): X, Threads and LinkedIn; LinkedIn long-form passes a rubric (8 overall, 7 floor) enforced in code.

## MCP tools

| Tool | Purpose |
|---|---|
| `scripting_get_content_brief` | Brief, CTA type, keyword, length window, Brand Kit files to read; the remix source and blueprint; the owner's best posts |
| `scripting_find_remix_sources` | Proven posts (competitor outliers, own breakouts) for a topic, ranked by match and times-normal; facts only |
| `scripting_use_remix_source` | Make a content item a remix of one proven post |
| `scripting_list_hooks` | Hook banks by bank and pattern (competitor hooks as structure only) |
| `scripting_pick_hooks` | Weighted picks with exploration |
| `scripting_validate_script` | Dry-run the validator |
| `scripting_save_script` | Save a version with its report; request approval when it passes |
| `scripting_reserve_keyword` | Keyword ledger rules enforced under a lock; suggestions |
| `scripting_get_claim_sources` | Proof inventory, cited sources, spent stats |
| `scripting_list_recent_scripts` | Recent scripts and the numbers they used |
| `scripting_save_captions` | Validate and attach captions |
| `scripting_save_text_posts` | Validate and save the weekly text posts |

## Skills

`write-script`, `voice-profile`, `hook-audit`, `spoken-humanizer`, `specificity-ladder`, `claim-ledger`, `captions`, `linkedin-longform`, `text-posts`. They reference the Brand Kit by path (`brand/voice.md`, `brand/proof-inventory.yaml`, ...) and never contain brand literals.

## Settings (`config.modules.scripting.settings`)

`wpm` (160), `minSeconds` (15), `maxSeconds` (60), `hookMaxSeconds` (3), `maxRevisions` (2), `exploration` (0.2), `ownBankMultiplier` (3), `competitorBankCap` (300), `competitorHalfLifeDays` (60), `hookCooldownDays` (14), `spentStatWindow` (10), `allowedCaps`, `ctaLines` (per CTA type, `{word}` = keyword), `textPosts` counts.

## Data

Writes `scripts` (versioned), `hooks`, `keywords`, `approvals` (kind `script` or `post`), and updates `content`. Migration `migrations/20261014000000_scripting_hooks.sql` adds `hooks.abstract` and the indexes that make harvesting idempotent.
