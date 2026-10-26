---
name: post-mortem
description: Write a post-mortem for one post (breakout, flop or new best) with wins and losses at the same depth. Used by the learn.post-mortem job and when the user asks why a post did well or badly.
---

# Post-mortem

Every breakout (2x or more the account's normal), every flop (under 0.6x, or a skip rate of 70% or more) and every new best gets a post-mortem. Wins get the same scrutiny as losses: a win you can't explain can't be repeated.

## Gather

1. `learn_get_post_context`: numbers over time (1h → 30d), `x` against the account's normal, the rate family (send rate, follows per 1k views, engagement), velocity (first-day views vs usual), 3-second hold and retention curve when known, the code-computed "why" lines, the plan behind the post (lane, angle, hook pattern, format, CTA), and the script.
2. `learn_get_feature_stats`: how the post's lane, hook pattern and format usually perform. A breakout in a lane that always does well is less surprising than one in a weak lane.
3. Read `brand/lessons.md` so you don't restate a rule that already exists.

## Write

Save with `learn_save_post_mortem`. `bodyMd` has exactly these sections:

```
## What happened
The numbers in one paragraph: x, views, send rate, follows per 1k, skip rate or 3-second hold if known, and how fast it moved (velocity, 1h vs 24h).
Then the first 3 seconds: the opening frame, any on-screen text and the first spoken line (from the script), with timestamps where you have them.

## Why we think it happened
2–4 specific reasons tied to choices in the plan or script (the hook's first line, the format, the topic, the CTA, the posting slot).
Mark each as "likely" or "possible". One post is a data point, not proof.

## What to repeat
Concrete choices to reuse, phrased so the Strategist or Copywriter can act on them.

## What to change
Concrete choices to drop or test differently. For a win, what would make the next one better.
For a miss, also say where in the process it slipped through (plan, script, edit, schedule) and the next action
(for example: repost as a trial reel in the winning format, or rewrite the hook against the last winner's opening).
```

`lessons`: 1–3 short rules in plain language ("Lead proof posts with the number in the first line"). They are proposed for `brand/lessons.md`; the user approves them.

## Rules

- Only numbers returned by the tools. If something wasn't measured, say "not measured".
- If the feature stats say GAP for a choice, say the evidence is thin instead of drawing a conclusion.
- Never blame the audience or the algorithm. Explain what we can control.
- Judge the opening against the account's recent winners, not gut feel: compare its first 3 seconds with the best post's.
- Rank causes from most to least likely. Fewer than 5 posts behind a pattern is a hunch, not a finding: say so.
