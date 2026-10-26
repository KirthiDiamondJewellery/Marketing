# Costs

AttentionOS itself is free and open source (MIT). You pay only for the services you choose to connect, and every paid service sits behind a budget you control.

## Typical monthly cost

| Item | Cost |
|---|---|
| Claude plan (the default) **or** API use (optional API engine) | $20+ **or** about $15–40 |
| Database (local Postgres with pgvector, on your machine) | $0 |
| Zernio (publishing, DMs, analytics) | $0–24 |
| Apify (competitor research) | $0–29 |
| **Total** | **about $20–$120 a month** |

Everything else in the default setup is free: the local database and knowledge store (with local embeddings), Telegram or Discord, whisper.cpp speech-to-text on your own machine, ffmpeg, the cut engine and the Instagram Graph API.

## By setup level

| Level | What you add | Extra cost |
|---|---|---|
| [1 · Research and scripts](setup/level-1.md) | Local database (Docker), Apify or Instagram Graph API, Telegram | $0–29 |
| [2 · Edit](setup/level-2.md) | ffmpeg, whisper.cpp | $0 |
| [3 · Publish and engage](setup/level-3.md) | Zernio | $0 for 2 accounts, then $6 each for accounts 3–10 |
| [4 · Autopilot, your phone and 24/7](setup/level-4.md) | Claude Code signed in where the worker runs; optionally a VPS | $0 extra on your Claude plan (or about $15–40 in API use on the API engine); about $10–20 a month for a VPS |

## Publishing: Zernio vs Blotato

Zernio is the default; Blotato is a supported alternative. Prices were checked on 2026-10-10 and may change: see [Zernio pricing](https://docs.zernio.com/pricing) and [Blotato pricing](https://www.blotato.com/pricing.md).

| | Zernio | Blotato |
|---|---|---|
| Price model | Per connected account: first 2 free, accounts 3–10 at $6 each, 11–100 at $3, 101+ at $1. Everything included | Plans: $29 (20 accounts), $97 (40), $499 (100) |
| Typical owner (5 accounts) | **$18/month** | $29/month |
| Agency (25 accounts) | About $93/month | $97/month |
| Try the API for free | Yes, no card | No: the trial excludes the API; creating an API key starts billing |

More detail in [ADR-1](adr/README.md) and on the [Zernio](providers/zernio.md) and [Blotato](providers/blotato.md) pages.

## Model costs

By default, every agent, including the background worker on Autopilot, runs on **your own Claude Code** and your Claude plan, so there's no separate model bill. Runs aren't billed one by one: Studio shows how many steps each run used ("Used 12 steps on your Claude plan"), and the work counts toward your plan's usage limits. If a busy schedule keeps hitting those limits, pick a larger plan, trim schedules, or switch to the API engine.

With the optional **API engine** (`runner: { engine: "api" }` and an `ANTHROPIC_API_KEY`), the worker pays per use instead. Targets:

| Work | Target |
|---|---|
| Daily research plus the morning brief | About $0.50–$1 a day |
| One reel edit | Under $0.50 |
| The morning brief composer | $0: it uses no model |

The reel target is reachable because the model only writes an edit **plan**; cutting, rendering and quality checks are deterministic code. Agents that drive a video editor directly tend to use far more tokens per clip.

Ways the bill (or your plan's usage) stays small:

- **Model routing per agent.** A Sonnet-class model for bulk work (triage, tagging, captions), an Opus-class model for scripts and edit plans.
- **Native jobs.** Syncing, scoring, finishing and QC use no model at all.
- **Cached verdicts.** A DM classified once is never paid for again.

## Budgets

Dollar budgets for model runs apply to the API engine; on your Claude plan, every run is still capped by a turn limit and a timeout. The scraping and image budgets apply either way.

Set in `config/attentionos.config.ts`. Defaults:

```ts
budgets: {
  perRunUsd: 2,           // hard ceiling for one agent run
  dailyUsd: 5,            // no new model runs once today's spend reaches this
  scrapingMonthlyUsd: 29, // checked BEFORE every competitor scan
  imagesDailyUsd: 2,      // generated images for carousels
},
```

When a budget is reached, the work stops and you get an alert, in plain words, with what was skipped. The weekly **cost watch** shows spend on models, scraping and publishing against each budget.

## Optional costs

| Item | When | Cost |
|---|---|---|
| Remotion company license | Only if you enable the motion engine (planned) **and** your company has more than three people | See Remotion's pricing |
| OpenAI or Gemini images (planned) | Only if you enable carousels with generated images | Capped by `imagesDailyUsd` |
| API embeddings (OpenAI or Voyage) | Only if you switch `knowledge.embeddings` from `local` | Usually cents a month for one brand |
| S3-compatible storage (planned) | Only if you keep media off your machine | Pay per GB at your provider |
