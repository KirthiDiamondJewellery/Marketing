---
name: cross-post
description: Repurpose a reel that's already on Instagram to TikTok, YouTube Shorts, Facebook and LinkedIn, or backfill recent reels. Swaps the comment-keyword call to action for a tracked link line, since keyword DMs only run on Instagram. Use when the user asks to cross-post, repurpose, backfill or "put this everywhere".
---

# Cross-post and backfill

A reel that worked on Instagram should travel. The keyword automation ("Comment STITCH and I'll send you the guide") only runs on Instagram, so off Instagram the call to action has to change, or viewers comment a word that does nothing.

## How to run it

1. **Pick the source.** One post (`postId`), one piece (`contentId`), or `backfill: N` for the newest N Instagram posts that weren't cross-posted yet (trial reels are never copied).
2. **Dry run first.** `publishing_cross_post` with the default `dryRun: true`. Read each preview back to the owner:
   - the platform and the slot (the next open slot in that platform's cadence),
   - the new caption, with the keyword line replaced.
3. **Confirm**, then run it again with `dryRun: false`. Each post then follows the normal approval rules, exactly like `publishing_schedule_post`.

## What changes in the caption

- Lines that ask people to comment or DM the keyword are removed.
- Where links in captions work (YouTube, Facebook, LinkedIn, X, Threads), the link line from settings is added with the tracked link for that platform (`utm_source=<platform>`, same `utm_content` as the original piece).
- Where they don't (TikTok), the "link in bio" line is used instead.
- The line goes last, before the hashtags. On X and Threads, hashtags are dropped first and then the text is trimmed, so the link line always survives.
- If a platform has its own caption in the captions package, that caption is used as the base.

## Good judgment

- Don't cross-post time-sensitive news reels after they've gone stale; ask the owner.
- LinkedIn takes video one or two days a week: the cadence enforces it, so tell the owner when a piece doesn't fit this week.
- If the source was posted by hand and has no file on record, ask the owner for the file or a link to it.
- Never re-post the same piece to a platform it's already on; the tools refuse, and that's correct.
