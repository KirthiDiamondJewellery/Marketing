# Research (Analyst)

Finds what to make next and keeps your own numbers flowing. Core module, setup level 1.

## Jobs

| Job | Kind | Default schedule | What it does |
|---|---|---|---|
| `research.own-sync` | native | every 6 h | Pulls your posts + metrics from the `ownAnalytics` provider into `posts` / `post_metrics` (matched by platform post id, provider id or URL; older posts get an imported row). Collapses trial-reel variants by transcript fingerprint. `{ backfill: true }` re-reads full history. |
| `research.competitor-scan` | native | 06:30 daily | Syncs `brand/competitors.yaml` → `tracked_creators`, checks the scraping budget **before** scraping (alerts instead of failing), scrapes today's rotation, recomputes each creator's baseline, scores `x`, marks outliers, detects cross-creator trends, queues transcription of winners. |
| `research.trend-radar` | native | hourly 07–21 | Reads `brand/sources.yaml`, snapshots each story, computes velocity/heat/relevance/coverage, sends one follow-up when a sent story's velocity doubles, picks within the daily (6) and per-run (1) caps and queues the writer. |
| `research.trend-writer` | llm, **tool-less** | on pick | Writes the filmable kit from untrusted trend text. Output: `trendWriterOutputSchema`; `onOutput` runs the deterministic checks (only the story's own links, banned phrases, keyword rules, spoken length, no unverified claims) and saves `trends.story`. |
| `research.teardown-prep` | native | on demand | Resolves/creates the post, downloads media, queues transcription, then the teardown. |
| `research.teardown` | llm, **tool-less** | after transcript | Writes `analysis.md` + facets. Output: `teardownOutputSchema`; `onOutput` checks the template sections and links, computes words/second from the transcript, saves, and builds a style fingerprint from 3+ teardowns. |
| `research.ingest-transcript` | native | hand-off | Stores a transcript + spoken hook from the editing module and continues the waiting job. |

## Hand-offs

- **Transcription** (`src/handoff.ts`): research queues `settings.competitorScan.transcribeJobId` (default `editing.transcribe`, agent `art_director`) with a `TranscriptionRequest` (`externalPostId`, `url`, optional `mediaUrl`/`mediaPath`, `destDir`, `replyTo`, optional `then`). The editing job transcribes with word timestamps and queues `research.ingest-transcript` with an `IngestTranscriptInput`, passing `then` through.

## MCP tools

`research_list_outliers`, `research_get_external_post`, `research_list_trends`, `research_shortlist_trend`, `research_dismiss_trend`, `research_list_tracked_creators`, `research_add_tracked_creator`, `research_remove_tracked_creator`, `research_status`, `research_request_teardown`, `research_list_teardowns`.

Untrusted third-party text is returned under an `untrusted` key with a note; list tools never include it.

## Settings (`modules.research.settings`)

See `src/settings.ts`. Highlights: `competitorScan.creatorsPerDay` (15), `postsPerCreator` (12), `matureHours` (48), `maxAgeDays` (120), `minBaselinePosts` (5), `transcribeTopN` (5), per-platform `rules` overrides; `trendRadar.dayCap` (6), `perRun` (1), `followUpFactor` (2), `filmWithinHours` (24), `minRelevance` (0), per-source `heat` overrides; `ownSync.lookbackDays` (35). The Apify adapter reads `apify.actors` from the same settings object.

## Scoring

All math lives in `@attentionos/scoring` (baseline, outlier `x`, heat, rotation, cross-creator trends). Defaults: Instagram `0.7·comment_ratio + 0.3·view_ratio`, outlier at `x ≥ 2` and ≥ 50 comments; TikTok view-weighted, `x ≥ 5` and ≥ 20k views; clips under 12 s are memes.

## Notices

Scraping public pages (Apify, yt-dlp) requires `acknowledgements.scrapingTerms`; without it the scan pauses and sends one plain-language alert. The Instagram Graph API (`business_discovery`) needs no acknowledgement.

## Tables

Schema v1 research tables plus `migrations/20261012000100_research_trend_alerts.sql` (alert bookkeeping, coverage, film-by and untrusted body on `trends`; transcript status and media links on `external_posts`).
