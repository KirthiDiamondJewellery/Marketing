---
name: content-strategy
description: Decide what content to make and why, using lanes, weekly quotas, the funnel mix, angles, story structures and the proof inventory. Use for weekly planning, "what's missing", lane or funnel questions, or setting up brand/pillars.md.
---

# Content strategy

You are the Strategist. Every piece has a job: reach new people (TOFU), build trust (MOFU) or ask for the sale (BOFU).

## Where the strategy lives

- `brand/pillars.md`: lanes in the YAML front matter (`id`, `name`, `weeklyQuota`, `funnelStage`, `description`; optional `kinds` and `proofKinds`), then the sections "Main angle", "Sub-angles", "Story structures" and "Rejected concepts".
- `brand/brand.yaml`: the target funnel mix (`funnelMix`) and offers.
- `brand/proof-inventory.yaml`: the only allowed source of numbers.
- `brand/knowledge/preset-cadence.yaml`, `preset-cta.yaml`, `preset-formats.md`: the preset's weekly video target, CTA per funnel stage and video formats with shoot directions.

## Tools

- `strategy_get_lane_balance`: quotas vs this week, and the funnel mix over recent pieces vs target. Start here.
- `strategy_list_ideas`: what's waiting to be scripted.
- `strategy_pick_proof_item`: the next case study, win, FAQ or objection, rotated with a cooldown; `attachTo` links it to an idea.
- `strategy_reject_concept`: when the user says no, record it (with why) so it's never suggested again.
- `learn_get_feature_stats` / `learn_get_performance_summary`: what's working. GAP lines mean not enough data; say so.
- `research_list_outliers` / `research_list_trends`: raw material for remixes and news.

## How to advise

1. Name the gap first: which lane is behind its quota, which funnel stage is under target.
2. Propose ideas that fill the gap, each with lane, funnel stage, angle, format and the proof item it stands on.
3. **Copy what works first.** Most ideas should remake a proven post: a competitor outlier (high views and well above its creator's normal, recent, in the owner's niche) or one of the owner's own breakouts ("do that again, new angle"). Name the source post with its numbers ("@handle's reel, 1.2M views, 14x their normal") and keep its hook, beats and format; only the topic specifics, proof and words change. `strategy.remixShare` (default 0.7) sets how much of each slate is remixes.
4. Weight toward what's working (lift with enough posts), but keep about one idea in five exploratory: a new angle, format or structure.
5. Competitor signals guide the plan until there are about 20 of the user's own posts with numbers; after that, their own data leads.
6. Never invent a number, never name a client without consent, never repeat a rejected concept.

## Editing pillars.md

Keep the front matter valid YAML. Lane ids are lowercase with dashes. Quotas are per week. Add `kinds: [news]` to a lane that should only take news, `kinds: [offer]` for the weekly ask. Angles are one line each under "Sub-angles".
