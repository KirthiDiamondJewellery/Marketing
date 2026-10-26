---
name: text-posts
description: Write the weekly batch of text posts for X, Threads and LinkedIn from what the business already said and proved this week, checked in code before review. Use for the scripting.text-posts job or when the owner asks for this week's text posts.
---

# Weekly text posts

The text batch repurposes the week's best ideas into posts that stand on their own. It never introduces a claim the business can't back.

## Inputs

1. `scripting_list_recent_scripts`: what was scripted this week (hooks, angles, numbers used).
2. `scripting_get_claim_sources`: the only allowed numbers.
3. `brand/voice.md`, `brand/icp.md`, `brand/pillars.md`, `brand/lessons.md`.

## X and Threads

- One idea per post. The first line is the whole point; the rest earns it.
- X: 280 characters including hashtags (links count as 23), zero to two hashtags. Threads: 500 characters, at most one tag.
- No comment-keyword CTAs (no automation runs there); a link line or no CTA.
- Vary the angle across the batch: a myth, a number, a story, a how-to. Don't reuse a hook pattern twice in one week where you can avoid it.

## LinkedIn

Follow the `linkedin-longform` skill, including the rubric.

## Rules for every post

- Owner's voice; run the `spoken-humanizer` checks that apply to writing and the `specificity-ladder`.
- Every number is in the claim sources; outside single-source claims say whose claim it is.
- Never name a client without consent.
- No banned phrases, no long dashes, hashtags only in the hashtags list.

Save the whole batch with `scripting_save_text_posts` and the week's Monday as `weekOf`. Fix and resave anything it rejects. Summarise in plain words: how many posts per platform were saved for review and what, if anything, needs the owner.
