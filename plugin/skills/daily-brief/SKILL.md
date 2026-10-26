---
name: daily-brief
description: Run and draft the "Film today" brief (or the weekly batch-day edition): what to film today, why, by when, with headers and shoot directions. Use for "what should I film today", the morning brief, or planning a filming session.
---

# Daily brief ("Film today")

The planner already decided **what** to film, in code: lanes by weekly quota, funnel stages that are behind, topic and proof cooldowns, rejected concepts, template rotation and the weights from learn. Your job is to make each piece easy to film in one take. You don't write scripts; the Copywriter does that next.

The slate is **remix first**: about 70% of it (`strategy.remixShare`) remakes posts that already proved themselves, competitor outliers and the owner's own breakouts, ranked by views, times their creator's normal, freshness, fit with the owner's niche, and whether a checked blueprint is ready. Each remix item carries `brief.remixOf` (`line`: "Based on @handle's reel, 1.2M views, 14x their normal") and a proof item for the owner's numbers. The rest is what the lanes require: the offer piece, fresh news, and talking heads when there aren't enough proven posts.

## Steps

1. `strategy_get_todays_brief` (pass `mode: "batch"` for the batch day). If it's empty, the brief hasn't been planned yet: say so, don't invent one.
2. Read `brand/voice.md`, `brand/icp.md` and `brand/pillars.md`. Skim `learn_list_post_mortems` for what to repeat or avoid. When a piece's topic feels familiar, `knowledge_search` it (`trust: "own"`) to see what was already filmed and how it did.
3. For every item, call `strategy_save_brief_item` with:
   - `header`: on-screen text, 60 characters max, the whole claim in a few words.
   - `hookIdea`: the first spoken line in plain language (the claim in the first 3 seconds).
   - `shootDirections`: 2–4 short, practical lines. Start from the format's directions already on the item, then add what this piece needs (props, location, what to show on screen).
4. Reply with the slate in this shape, soonest film-by first:
   `1. <header> · <lane> · <format> · film by <time>` and one line of why.

## Rules

- Numbers only from the item's `proof.numbers`. The save tool rejects any other number.
- If `nameClient` says there's no consent, describe the client without naming them.
- Banned phrases from `brand/brand.yaml` are rejected by the save tool.
- News pieces have a 24-hour deadline: put them first.
- Remixes stay close to the source post: same hook, beats, format and CTA mechanic, with the owner's topic, proof and words. For a remix, keep the header and shoot directions in the source's format (from the item's template) and put its `remixOf.line` in your one line of why. Don't open the source post's text here; the Copywriter works from its checked blueprint.
- If the user says no to an idea, call `strategy_reject_concept` with their reason so it never comes back.
