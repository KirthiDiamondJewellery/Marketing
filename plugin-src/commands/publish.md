---
description: Schedule approved content across your platforms, with tracked links and keyword DMs
argument-hint: "[content id or 'this week']"
allowed-tools: Read, Glob, Grep, mcp__attentionos__ops_list_approvals
---

# Publish and schedule

Have the Publisher schedule approved content. Scope: `$ARGUMENTS` (default: everything approved and not yet scheduled).

## Rules

- **Nothing goes public without an approved approval.** Only schedule pieces whose script and edit approvals are `approved` (check with `ops_list_approvals` and the `publishing_*` tools). If something is still pending, say which ref is waiting.
- **Dry run first.** Build the week manifest and validate every payload with the `publishing_*` tools before any real API call. Show the dry-run result.
- Idempotency keys mean nothing is posted twice; never work around a duplicate warning.
- Instagram main feed defaults to **assist**: the owner gets the file and caption to post by hand (trending audio can't be added by API), unless the config switches it to autopost.
- Every post gets a tracked link (`utm_content=<keyword>_<post#>`). Comment-keyword CTAs are swapped for a link line on platforms without comment-to-DM.

## Steps

1. Read `brand/brand.yaml` (platforms, CTA model, timezone) and the cadence and slots in the config.
2. List what's ready: piece, platforms, proposed slot, caption per platform, keyword and lead magnet.
3. Run the dry run and show any validation errors in plain words with the fix.
4. Ask the owner to confirm the schedule ("Schedule these 5 posts?"). Only after a clear yes, schedule through the `publishing_*` tools and set up keyword DM automations through the `community_*` tools.
5. Report: "Scheduled 5 posts for Tuesday to Friday on Instagram, TikTok and LinkedIn." List anything left in assist mode with what the owner needs to do.
