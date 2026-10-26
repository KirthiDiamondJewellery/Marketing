# Learn

The learning loop is what makes AttentionOS get better every week. Every post records what went into it; performance flows back; and the team re-weights what it makes next. Every correction you make becomes a written rule.

| | |
|---|---|
| Agent | Analyst (`An`) |
| Tier | Core (always on) |
| Setup level | [Level 1](../setup/level-1.md) for lessons; [Level 3](../setup/level-3.md) for full measurement |
| Needs | Your own post metrics (from your publish provider); optionally website events for business attribution |
| Brand Kit files | `brand/lessons.md` |

## What it does

Every formula, data source and method is documented in [Analytics](../analytics.md).

### Snapshots

Each post's numbers are captured at 1 hour, 24 hours, 72 hours, 7 days and 30 days. Every post gets an `x` score against **your own** rolling baseline, so a good post means good for you, not good compared to someone with ten times your audience. Alongside `x`: velocity (first-day views against your usual first day), send rate (shares + saves per view), follows per 1,000 views, engagement per view and per reach, and the 3-second hold when a skip rate or retention curve is known. Trial-reel variants count once, by their best variant.

### Followers

Follower counts per account are recorded daily (Zernio follower stats, or a follower CSV) for the growth chart and the weekly report.

### Feature attribution

For each of these dimensions, the Analyst reports the median `x`, the lift, the sample size `n` and a confidence range:

hook pattern · lane · format · angle · funnel stage · call-to-action type · length · posting slot · story structure

Each value gets a verdict (clearly better, leaning better, about usual, leaning worse, clearly worse) and is measured on three outcomes: `x`, send rate and follows per 1k views. When there isn't enough data, the report prints an explicit **`GAP:`** line instead of guessing.

### When to post

A day × time-of-day heatmap in your timezone. Slots with few posts are pulled toward your normal so one lucky post can't crown a slot, and only slots with enough posts are named best.

### Competitor benchmarks

Your typical post against each tracked creator's, per platform (medians only), and their recent outliers to study.

### Weights

What works feeds back into the Strategist's picks and the Copywriter's hook choice. A share of picks (20% by default) is always kept for exploration, so you keep finding new winners.

### Post-mortems

Drafted automatically for every **breakout** (2× your normal or more), every **flop** (under 0.6×, or a skip rate of 70% or more) and every **new best**. Wins and losses get the same depth: the first 3 seconds, ranked causes, where in the process it slipped, and the next action.

### Lessons write-back

**Chat is not memory.** When you correct an agent, the correction becomes a dated rule in `brand/lessons.md` the same day, with the evidence. Use `/attention:lesson <correction>` to add one yourself. Rules that keep coming up are promoted into the skills. A weekly compaction prunes stale or contradictory rules, with your approval.

### North-star goal

One metric every agent judges against, set in your config: leads per week (default), follows per post, booked calls per week, skip rate or revenue per week. Analytics paces it through the calendar week (met, on track, at risk, behind) with a projection, and does the same for every other active goal (for example new followers per week).

### Business attribution

Your website sends clicks, leads, booked calls and sales to `POST /webhooks/site` (or drop CSVs in `imports/funnel/`), keyed on `utm_content`. Each visitor is credited to the post that brought them in first, so the Analyst traces post → clicks → leads → bookings → revenue per post.

### Weekly briefing and cost watch

A weekly report: the headline, north-star pace, the week's numbers, best and weakest posts with why, what lifts and what holds results back, the funnel, your best slot, where you stand against tracked creators, a focus list where each item cites a number, gaps, and what you spent against your budgets.

## What you'll see

- **Studio → Analytics**: Overview, Your posts (with a full breakdown per post), What's working (including the best time to post) and Competitors. Overview links to the Weekly report and Leads and sales (the funnel) once there's data.
- `/attention:learn` in Claude Code for the latest report, and MCP tools (`learn_get_performance_summary`, `learn_get_post_detail`, `learn_get_best_slots`, `learn_get_benchmarks`, `learn_get_goal_pacing`, `learn_get_funnel`) that give agents the same numbers.
- Post-mortems and the weekly briefing in the approvals queue and your notifier.
- `brand/lessons.md` growing as you work.

## Approvals

Lessons you dictate are written immediately. Lessons the agents infer, and weekly compactions, wait for your approval.

## Settings

`northStar.metric` and `northStar.target` in your config. `modules.learn.settings` holds the exploration share, the minimum sample size before a dimension is reported (`attribution.minN`, 5), post-mortem thresholds (`postMortem.breakoutX`, `flopX`, `flopSkipRate`), the heatmap (`slots.blockHours`, `minN`, `priorN`) and the at-risk band for pacing (`pacing.atRiskShare`).

## Limits

- Attribution, slots and benchmarks need enough posts. Expect `GAP:` lines for the first few weeks.
- Instagram skip rate and retention curves come from a CSV export; follower history needs Zernio's analytics add-on or a follower CSV; revenue needs sale events from your website.
