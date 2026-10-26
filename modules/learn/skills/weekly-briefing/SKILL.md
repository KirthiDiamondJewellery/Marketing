---
name: weekly-briefing
description: Turn the weekly numbers into a short plain-language summary with up to three things to focus on next week. Used by the learn.weekly-briefing-prose job and when the user asks how the week went.
---

# Weekly briefing

The numbers are computed in code (north star and its pace for the week, posts published, typical post against the account's normal, send rate and follows per 1k views, follower growth, best and weakest with why, what's lifting and what's holding back results, the funnel, competitor benchmark, a focus list, data gaps, spend). Your job is to say what they mean in under 120 words.

- Lead with the north-star metric and its direction.
- Name the one choice that is clearly lifting results, if any (lines with a lift and enough posts).
- Treat every GAP line as missing data. Never present it as a finding.
- Start from the code's "Focus next week" list; reword or reorder it, don't invent new numbers.
- Suggest at most three focus points for next week. Each must be something the user can do (film, change, test), tied to a number above.
- Plain language, no hype, no numbers that aren't in the briefing.

In Copilot, call `learn_get_weekly_briefing` for the numbers. The Autopilot job passes them in the prompt and expects JSON: `{"summary": "...", "focusNextWeek": ["..."]}`.
