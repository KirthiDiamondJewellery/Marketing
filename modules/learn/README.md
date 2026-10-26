# Learn (Analyst)

Closes the loop: every post is measured against your own normal, and what works feeds back into what gets made next. Core module; metrics capture works from setup level 1, the full loop (schedules, prose) at level 4.

## Jobs

| Job | Kind | Default schedule | What it does |
|---|---|---|---|
| `learn.capture-followers` | native | daily 06:15 | Records each connected account's follower count per day into `account_snapshots` (providers that expose `listAccountStats`: Zernio follower stats, the CSV import). |
| `learn.funnel-import` | native | hourly | Imports website clicks, leads, bookings and sales from CSVs in `imports/funnel/` (idempotent). |
| `learn.webhook-site` | native | webhook | `POST /webhooks/site` (shared secret): website funnel events keyed on `utm_content`, validated and stored in `funnel_events`. |
| `learn.capture-snapshots` | native | hourly | Finds posts with a 1h / 24h / 72h / 7d / 30d capture due (each label has a window; missed windows are skipped, never filled late), pulls fresh numbers once through `research`'s own sync, and writes labelled `post_metrics` rows. |
| `learn.attribution` | native | daily | Scores own posts against per-platform own baselines, then writes `feature_stats` per dimension value (median x, lift, n, rank-based 90% range) for windows `30d`, `90d`, `all`, plus competitor signals (`competitor:90d`). Below min n a value gets a GAP line. |
| `learn.post-mortem-scan` | native | daily | Finds settled breakouts (≥ 2x), flops (< 0.6x) and new bests without a post-mortem and queues `learn.post-mortem`. |
| `learn.post-mortem` | llm | queued | Drafts the post-mortem through `learn_get_post_context` and saves it with `learn_save_post_mortem`. |
| `learn.weekly-briefing` | native | Monday 08:00 | Sends the weekly numbers (north star, typical post vs normal, best/weakest, top lifts, GAP lines, spend). With `weeklyBriefing.prose` it also queues `learn.weekly-briefing-prose` (tool-less, sends its summary from `onOutput`). |
| `learn.cost-watch` | native | every 3 h | LLM spend today, scraping this month and images today against `budgets`; warns at 80% and alerts when over, once per period, through the `messages` outbox. |

## Weights API (consumed by strategy and scripting)

- `getWeights(ws)` → `{ ownShare, ownPosts, explore, weights, source }`. `weights[dimension][value]` is a multiplier around 1, blended from competitor signals (dominant until about 20 own posts) and own data, clamped to [0.5, 2].
- `getFeatureWeights(ws, dimension)` → `Record<value, weight>` for one dimension (e.g. `"hook_pattern"`).
- Neither includes exploration. Pick with `pickWeighted(options, rand, weights.explore)` from `@attentionos/scoring` (20% uniform exploration by default).

## MCP tools

`learn_get_performance_summary`, `learn_get_post_detail`, `learn_get_feature_stats` (`metric`: x, send_rate, follows_per_1k), `learn_get_best_slots`, `learn_get_benchmarks`, `learn_get_goal_pacing`, `learn_get_funnel`, `learn_record_funnel_event`, `learn_list_post_mortems`, `learn_get_weekly_briefing`, `learn_get_post_context`, `learn_save_post_mortem`.

## Analytics read API

`@attentionos/module-learn/analytics` (no jobs or provider wiring, safe for Studio): `postFacts`, `overview`, `postDetail`, `bestSlots`, `competitorBenchmarks`, `funnelReport`, `followerGrowth`, `goalPacingReport`, `weeklyReport`, `loadFeatureStats`. Studio's Insights and the MCP tools both call these. Formulas: [docs/analytics.md](../../docs/analytics.md).

## Tables (migrations/)

`account_snapshots` (followers per account per day), `funnel_events` (website clicks, leads, bookings, sales with `utm_content`), and a `metric` column on `feature_stats` (x, send_rate, follows_per_1k).

## North star

`config.northStar.metric`: `leads_per_week` (contacts and website leads, de-duplicated by email), `follows_per_post` and `skip_rate` (median of each post's latest capture), `booked_calls_per_week` and `revenue_per_week` (from website events; GAP until any arrive). Goals rows may also use `new_followers_per_week`, `views_per_week`, `posts_per_week`. Target from `config.northStar.target` or the active `goals` row. Pacing (`goalPacingReport`) runs over the local calendar week.

## Settings (`modules.learn.settings`)

`attribution.minN` (5), `attribution.confidence` (0.9), `slots.blockHours` (3), `slots.minN` (3), `slots.priorN` (3), `pacing.atRiskShare` (0.85), `postMortem.flopSkipRate` (0.7), `weights.explore` (0.2), `weights.fullTrustAt` (20), `weights.min`/`max` (0.5/2), `postMortem.breakoutX` (2), `flopX` (0.6), `afterSnapshot` (`72h`), `weeklyBriefing.prose` (false), `costWatch.warnAt` (0.8).
