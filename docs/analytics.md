# Analytics

How AttentionOS measures your content, what each number means, and where it comes from. Everything here is computed in code by the Learn module (`@attentionos/module-learn/analytics`, math in `@attentionos/scoring`). Studio's Analytics pages and the Analyst's MCP tools call the same functions, so the dashboard and your agents never disagree.

Two rules hold everywhere:

- **Your own normal is the yardstick.** A post is judged against your own recent posts on the same platform, never against someone with ten times your audience.
- **Missing is missing.** An unknown number is shown as a dash and stated as a `GAP:` line, never filled with zero or an estimate. Below a minimum sample, a pattern is a gap, not a finding.

## Data

| Data | Source | Stored in |
|---|---|---|
| Views, reach, likes, comments, shares, saves, follows, profile visits, average watch time, skip rate, completion | Zernio analytics (per platform; field names mapped for Instagram, TikTok and YouTube), IG Graph backfill, or CSV export | `post_metrics` (one row per capture) |
| Link clicks, impressions, reposts, retention curve | Zernio analytics where available; CSV columns `clicks`, `retention` or `retention_<N>s` | `post_metrics.raw.aos` |
| Skip rate and retention for Instagram Reels | CSV export (Instagram doesn't expose them by API) | `post_metrics` (`import` capture) |
| Captures at 1 hour, 1 day, 3 days, 7 days, 30 days | `learn.capture-snapshots` (hourly; late captures are skipped, never filled) | `post_metrics.snapshot` |
| Followers per account per day | Zernio follower stats, or a follower CSV | `account_snapshots` |
| Clicks, leads, booked calls, sales | Your website: `POST /webhooks/site` (shared secret) or CSV in `imports/funnel/`; leads also from `contacts` | `funnel_events` |
| Goals | `northStar` in config plus `goals` rows | `goals` |

A post's **settled** numbers come from its 7-day capture, else 3-day, else the latest. Numbers that only arrive in another capture (a CSV skip rate, a retention curve) are filled in from the most recent capture that has them.

### Website events

Send events to the worker's webhook endpoint with `ATTENTIONOS_WEBHOOK_SECRET`:

```http
POST /webhooks/site?secret=…
{ "events": [
  { "type": "click",   "utm_content": "wallcheck_38", "utm_source": "instagram", "visitor_id": "v-123" },
  { "type": "lead",    "visitor_id": "v-123", "email": "someone@example.com" },
  { "type": "booking", "visitor_id": "v-123" },
  { "type": "sale",    "visitor_id": "v-123", "amount_cents": 240000, "id": "order-881" }
] }
```

Common names are accepted (`event`/`type`/`kind`; `booking_created`, `purchase`, `signup` …; `utm` objects; ISO or Unix times). An `id` makes re-sends safe. Payloads are untrusted: they are validated field by field, stored, and never sent to a model.

## Metrics

| Metric | Formula | Notes |
|---|---|---|
| `x` (result vs your usual) | Per-platform weighted ratio to your median of mature posts (≥ 48 h, ≤ 120 days) | Needs 5 mature posts on the platform; 1× = a typical post |
| Velocity (first-day pace) | 24 h views ÷ median 24 h views of your other posts on the platform | Needs 3 other posts with a 24 h capture |
| Engagement rate (per view) | (likes + comments + shares + saves) ÷ views | Unknown parts are left out; null when all are unknown |
| Engagement rate (per reach) | Same interactions ÷ reach | The platform-native rate |
| Send rate | (shares + saves) ÷ views | The north-star-friendly signal: people keeping or sending the post |
| Follows per 1k views | follows ÷ views × 1000 | |
| 3-second hold | Retention at 3 s from the curve (interpolated), else 1 − skip rate | |
| Watch % | average watch ÷ length | Can exceed 100% with rewatches |
| Click rate | link clicks ÷ views | |
| Pooled rates (KPIs, weekly trend) | Σ numerator ÷ Σ views | One small post can't swing a pooled rate |
| Normal band | p25–p75 of per-post views over the 90 days before each week | Needs 5 posts |

## Methods

- **Attribution** (`learn.attribution`, daily): for hook pattern, lane, format, angle, funnel stage, CTA, length, posting slot and story structure, the median outcome, lift vs your typical post, `n`, and a distribution-free 90% range (sign-test order statistics). Outcomes: `x`, send rate and follows per 1k. Each value gets a verdict: clearly better / leaning better / about usual / leaning worse / clearly worse / gap (n < 5). "Clearly" means the range excludes your typical post.
- **Trial variants**: versions of the same video (matched by transcript) count as one post. The best variant's numbers represent the group, with the variant count shown.
- **Comparisons**: change against the prior period says "no basis" when the prior period was zero. Correlations show r, r², a plain-word strength and a small-sample flag, and leave out metrics derived from each other. Competitor and format comparisons use medians, never means.
- **Weights** for the Strategist and Copywriter still come from `x` only, blended with competitor signals until about 20 own posts, with 20% exploration.
- **Best posting slots**: day × 3-hour blocks in your timezone. Each slot's median is shrunk toward your overall median as if it had 3 extra typical posts (`(n·median + 3·overall) / (n + 3)`), so one lucky post can't crown a slot. Evidence: low (< 3 posts), some (< 6), strong. Only slots with 3+ posts can be a best slot.
- **Goal pacing**: the current local calendar week. Count goals project today's total plus the expected rest of the week, blending this week's run rate with the trailing 28-day rate (trusting this week more as it goes on). Average goals (follows per post, skip rate) compare the current value. Status: met, on track, at risk (projected ≥ 85% of target), behind.
- **Competitor benchmarks** (per platform): your median views, engagement and breakout rate against each tracked creator's (creators with fewer than 5 scanned posts are left out of the medians), plus their recent outliers.
- **Funnel**: tags resolve to a post by exact `utm_content` (`utm_source` picks the platform), else by the trailing post number. Visitors are credited to their first tagged touch; leads are de-duplicated by email.
- **Post-mortems**: queued once numbers settle for breakouts (≥ 2×), flops (< 0.6× or skip rate ≥ 70%) and new bests, written by the Analyst with the same depth for wins and losses.
- **Weekly report**: headline, north star and pace, the week's numbers, best and weakest with code-computed "why" lines, what lifts and what holds results back, funnel, best slot, competitor position, a focus list where every item cites a number, GAP lines and spend. Sent on Mondays; always viewable in Studio from the **Weekly report** link on Analytics → Overview.

## Where to see it

**Studio → Analytics**: Overview (north star and pacing, key numbers against the prior period, followers, best post with why, views per post against your normal range), Your posts (sortable; click a post for its curve against your usual curve, retention, funnel and post-mortem), What's working (what lifts results, what holds them back, and the best time to post), Competitors (how you compare, their outliers, and **Remix this** to turn one into a script on Scripts). Once there's data, Overview also links to the **Weekly report** and **Leads and sales** (the funnel). Right after setup, the scan of your own account and your competitors shows here straight away, followers included.

**MCP tools** (for the Analyst, Strategist and you in Claude Code): `learn_get_performance_summary`, `learn_get_post_detail`, `learn_get_feature_stats` (with `metric`), `learn_get_best_slots`, `learn_get_benchmarks`, `learn_get_goal_pacing`, `learn_get_funnel`, `learn_get_weekly_briefing`, `learn_record_funnel_event`, plus the post-mortem tools.

## Limits

- Instagram skip rate and retention curves need a CSV export; Zernio exposes them only for some accounts and platforms.
- Follower history needs Zernio's analytics add-on (follower stats) or a follower CSV.
- Revenue is only as good as the sale events your website sends.
- The heatmap uses coarse 3-hour blocks on purpose: finer slots never reach a usable sample.
