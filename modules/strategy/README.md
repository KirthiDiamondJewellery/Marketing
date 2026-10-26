# Strategy (Strategist)

Decides what to make and when. Core module, setup level 1.

## Jobs

| Job | Kind | Default schedule | What it does |
|---|---|---|---|
| `strategy.daily-brief` | native | 06:00 weekdays | Plans the "Film today" slate (default 2 news reels, 2 outlier remixes, 2 talking heads, 1 offer) with the deterministic planner, writes `content` rows (status `idea`, lane, funnel stage, angle, story structure, template, CTA, `source_refs`, `film_by`, brief payload), opens one approval (`ap-N`), queues one notification and hands off to `strategy.draft-brief`. Idempotent per date; `{ replan: true }` archives the open ideas and plans again. |
| `strategy.batch-day` | native | Sunday 17:00 | Same planner for a week of videos filmed in one session. Size: `settings.batchSize`, else `weeklyTarget.shortVideos` from `brand/knowledge/preset-cadence.yaml`, else the sum of lane quotas. No news (news is filmed the day it breaks). |
| `strategy.draft-brief` | llm | after a brief | Drafts headers, a hook idea and shoot directions per item through `strategy_get_todays_brief` / `strategy_save_brief_item`. The save tool rejects banned phrases and any number not in the item's proof. |

### Brief → scripts

After a daily or batch brief, the Strategist queues one `scripting.write-script` run per filmable idea (news, remix, talking head, offer; never `text` or `carousel` content), soonest deadline first, so the Film page always has scripts on the way. `settings.autoScripts`:

- `enabled` (default `true`; nothing is queued when the scripting module is off),
- `maxPerDay` (default `5`, shared by the daily and batch editions of one brief date; the rest stay ideas you can script from the Film page),
- `delayMinutes` (default `10`, gives `strategy.draft-brief` a head start).

Each run uses the dedupe key `write-script:<content id>` in any run state, so a piece is never auto-scripted twice. Replanning cancels the queued scripts of the archived ideas. Every script still waits for the owner's OK per the Copywriter's autonomy. Setting `settings.scriptHandoffJobId` switches to the legacy hand-off: one run of that job with `{ contentIds }` ten minutes after the brief.

## Where lanes and defaults come from

- `brand/pillars.md` front matter: `lanes: [{ id, name, weeklyQuota, funnelStage, description }]` (the workspace template and presets write this). Optional per-lane `kinds` (`news`, `remix`, `talking_head`, `offer`) and `proofKinds`; otherwise inferred from the lane's name, description and funnel stage.
- `brand/pillars.md` sections: "Main angle", "Sub-angles" (list), "Story structures" (numbered `**Name**: description`), "Rejected concepts" (`- YYYY-MM-DD · idea · why`, appended by `strategy_reject_concept`).
- `brand/knowledge/preset-cta.yaml` (`byFunnelStage.<stage>.default`), `preset-formats.md` (format ids and shoot directions), `preset-cadence.yaml` (weekly target).
- With no lanes at all, generic reach / trust / offer lanes are used and the brief says so.

## Planner rules (`src/planner.ts`, pure and seeded)

Lane by weekly deficit × funnel need × learn weight; funnel need from the last 20 pieces vs `brand.yaml` `funnelMix`; topic cooldown (14 days) and rejected concepts by content-word overlap; angle cooldown (3 days); story structure on about one idea in three (least recently used); template rotation (least recently used per kind); proof rotation with a 21-day cooldown, the only source of numbers; 20% exploration from learn's weights. News only from trends with a validated kit; remixes only from outliers not used before. Open slots are backfilled with talking heads and reported.

## MCP tools

`strategy_get_todays_brief`, `strategy_save_brief_item`, `strategy_get_lane_balance`, `strategy_list_ideas`, `strategy_reject_concept`, `strategy_pick_proof_item`.

## Feedback weighting

`getWeights(ws)` from `@attentionos/module-learn`: competitor signals dominate until about 20 own posts, then own data; weights are clamped multipliers around 1 and the planner explores 20% of the time.
