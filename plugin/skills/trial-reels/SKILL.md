---
name: trial-reels
description: Turn clean reels (no captions, no title) into a day of Instagram trial reel variations and schedule them as TRIAL reels only. Each variation is the same video with a different speed (up to 1.1x), colour, caption style, title style and wording, position and hashtag set. Renders and checks them automatically; schedules only after the owner approves the preview. Use when the owner says "make trial reels", "trial reel this", "make trial reels from yesterday's video", "make the variations", "schedule the trial reels" or "cancel the trial reels".
---

# Trial reels: clean reels in, a day of trial reels out

The owner posts their main-feed reel as usual. This skill makes the trial copies: `dailyTotal` a day in total (9 by default), split evenly across the clean reels of that day (2 reels = 5 + 4). Instagram shows trial reels to non-followers first; they never appear on the main grid.

A clean reel is a reel without burned-in captions or title. It comes from either:
- **a finished or approved edit** (`rf-12`): AttentionOS renders it again without captions or on-screen text (same cuts, framing, sound and colour), or
- **a clean reel the owner uploaded for trial reels** (Studio: Edit → upload with "These are clean reels for trial reels").

## Hard rules

1. **Trial reels only.** Never a main-feed post. Graduation (showing it to followers) stays manual unless the owner set `graduation: "auto"` in the trial-reels settings themselves.
2. **Nothing is scheduled without the owner's OK** on the batch, after they have seen the preview. `trial_reels_schedule` with `dryRun: false` only asks for that approval; you cannot approve it. In Studio the owner presses "Schedule N trial reels".
3. **Never more than 50 posts in 24 hours** on the account, counting every other post. The tools enforce it.
4. **The owner's words only.** The title is the owner's own title, plus at most 3 light reorders of the same words (the tool refuses other words). The caption line is theirs, word for word. Never invent a hook, a title or a call to action. If they didn't give a title, ask for it, or use none.
5. **Five topical hashtags per post**, reshuffled per variation, about the video's topic (a puppy-training video gets puppy-training tags). Give 5 to 10. Prefer the piece's own Instagram hashtags (`suggestedHashtags`) and the owner's `hashtagSets`.
6. **Prove trial posting once per account.** Until the owner has confirmed that one live trial reel stayed off their grid, a batch sends exactly one, right away. Only the owner can confirm it (Studio: Calendar → that post → "It stayed off my grid", or `publishing_confirm_trial_proof` when they tell you it's off the grid). Never confirm it for them.

## Steps

1. **Find the video.** `trial_reels_sources` lists finished/approved edits and uploaded clean reels with dates ("yesterday's video" = the newest one finished yesterday), the piece's title, suggested hashtags and, when the video asks for a comment, the owner's caption line with the keyword.
2. **Get the inputs.** For each video: the owner's title, optional reorders, the caption line (required with the keyword when the video asks for a comment), 5 to 10 topical hashtags, the layout (`talking-head`: title above the head the whole video; `split-screen`: title in the top bar for 3.5 seconds), an optional end ask shown on screen near the end. Confirm the day (default: tomorrow).
3. **Make them.** `trial_reels_make`. It renders in the background (a few minutes for 9) and checks every file: format, length for its speed, captions on screen at the right moments, the title on and off at the right time, the end ask only near the end, no identical files or looks. Follow it with `trial_reels_status`.
4. **Show the owner, then stop.** When the status is `ready`: the preview image (one frame per variation), how many per video, the titles, the posting times and one sample caption per video (`trial_reels_schedule` with `dryRun: true` gives the plan). If the check failed, say what failed in plain words and don't schedule.
5. **Ask for the OK.** Only when the owner says go: `trial_reels_schedule` with `dryRun: false`. Tell them the approval ref and that nothing goes out until they approve it.
6. **First time on an account**, one trial reel goes out right away. Ask the owner to look at their profile once it's live and confirm it is NOT on their grid. If it IS on the grid, stop, tell them, and don't confirm.

Posts take turns between videos and are spread evenly across the window (08:00 to 21:00 in the workspace timezone by default). Re-running never posts anything twice; a variation whose send was never confirmed is shown, not resent.

## Cancel

`trial_reels_cancel` with the batch ref (or post ids) removes trial reels that aren't live yet, also from the publisher. Live ones must be deleted on Instagram.

## Settings

`modules["trial-reels"].settings`: `dailyTotal` (9), `dailyCap` (50), `speeds` (1.03 to 1.10), `window` (`08:00`–`21:00`), `graduation` (`manual`), `hashtagSets`. Scheduling also needs the trial-reels risk notice (`acknowledgements.trialReelsRisk`), which only the owner accepts.

Whether Instagram treats each copy as a new video is something AttentionOS can't verify. Suggest the owner watches reach and Account Status the first week, and stops if either drops.
