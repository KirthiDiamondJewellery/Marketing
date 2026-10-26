---
description: Write a validated script for an idea or a planned piece of content
argument-hint: "<idea in a few words | content id>"
allowed-tools: Read, Glob, Grep
---

# Write a script

Have the Copywriter write a script for: `$ARGUMENTS`

If that looks like a content id, load the piece with the `scripting_*` or `strategy_*` tools from the attentionos MCP server (its lane, angle, funnel stage, source refs and brief). If it is a free-text idea, ask which lane from `brand/pillars.md` it belongs to only if that is unclear.

## Read first

- `brand/voice.md` (the owner's voice profile and banned words), `brand/icp.md`, `brand/offers.md`, `brand/pillars.md`, `brand/proof-inventory.yaml`, `brand/house-style.md` and `brand/lessons.md`.
- The scripting skills that came with this plugin (hook banks, hook audit, spoken humanizer, claim ledger). Follow them.

## Method

1. **Copy what works first.** Look for a proven post on this topic (`scripting_find_remix_sources`: competitor outliers and the owner's own breakouts). If one fits, attach it (`scripting_use_remix_source`) and remake it closely from its blueprint: same hook wording and pattern, beats, length, format and call-to-action mechanic; only the niche specifics, the owner's proof and voice change. Never the creator's name, @handle, brand, stories or numbers. Say which post it's based on.
2. **Otherwise, hook first.** Pick a hook pattern from the hook banks (`scripting_*` tools: the owner's own winning openers first, then competitor patterns). Record where it came from (`hook_source`).
3. **Six beats** (originals; a remix follows its source's beats): hook (the whole claim in 0–3 seconds) → turn → proof with a number → rehook at 25–40% → the play → close that calls back to the hook.
4. **Numbers** come only from `brand/proof-inventory.yaml` or a cited source. Build a claim ledger: every factual claim is PASS, FIX or CUT, with its source. Single-source claims get "they say" framing.
5. **CTA** matches the funnel stage and the CTA model in `brand/brand.yaml`. If it uses a comment keyword, reserve one through the keyword tools (the ledger enforces the rules).
6. **Spoken words only.** Read it aloud in your head. It should sound like `brand/voice.md`, not like an essay.
7. **Validate.** Run the script validator through the `scripting_*` tools. It is a hard gate written in code: if it fails, fix the script and validate again. Never argue with it and never edit it.
8. **Captions.** Draft per-platform captions from the script if the tools support it.

## Save and approve

Save the script with the `scripting_*` tools (this creates a new version and an approval request). Show the owner:

- the script, beat by beat,
- the hook source and pattern,
- the claim ledger,
- the validator result,
- the approval ref (for example `ap-12`).

Ask: approve, or tell me what to change. Any correction the owner gives that should apply next time: offer to save it with `/attention:lesson`.
