# Changelog

All notable changes to AttentionOS are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Package-level entries are generated with Changesets.

## [0.1.0] - Unreleased

First public release. AttentionOS runs from a clone of this repository as a Docker Compose stack, with Studio as the everyday interface, and covers setup Levels 1–4.

### Added

#### Running it

- The Docker stack: one `attentionos` image (Studio, the worker, the `media-py` tools and Claude Code) plus Postgres with pgvector (`pgvector/pgvector:pg17`; Postgres 16+ with pgvector is supported). Studio is published to `127.0.0.1` only.
- The `./aos` helper for everyday operations: `status`, `open`, `logs`, `start`, `stop`, `restart`, `update`, `backup`, `doctor`, `claude-login`, `access-key`, `claude`, `cli <args>`, `shell` and `uninstall`.
- Backups with `./aos backup` (database dump plus workspace archive, 14-day retention), scheduled by you with cron, launchd or Task Scheduler.
- Agents run on your own Claude Code login and Claude plan by default (`claude setup-token`, saved by `./aos claude-login`), or on the Anthropic API with `runner: { engine: "api" }`, per-run and daily dollar caps.
- Two modes: **On request** (Copilot) and **Autopilot** (scheduled overnight research, morning brief, metric syncs and DM triage).
- Guides for macOS, Linux, Windows (WSL 2) and a small server.

#### Studio

- The dashboard: Home, Scripts (with a teleprompter), Edit (upload takes, review videos with timestamped notes), Calendar, Agents (worker view and command view), Analytics, Brand Kit and Settings, plus the Chief of Staff chat on every page.
- Guided setup at `/setup`: your website and handles, provider keys with live checks, competitors, then a drafted Brand Kit for you to approve.
- Settings for the workspace and mode, modules, services and keys, budgets, a checkup (the same checks as `./aos doctor`) and access. How much each agent does on its own is set on the Agents page.

#### Modules

- `onboarding`: reads your website, imports your own posts, learns your voice from their transcripts and drafts your Brand Kit.
- `research`: own-account sync, competitor outliers against each creator's own baseline, the trend radar and teardowns.
- `strategy`: content lanes with weekly quotas, funnel mix, proof pickers and the daily "Film today" brief.
- `scripting`: hook banks with provenance, 6-beat scripts with a claim ledger, per-platform captions and a deterministic script validator.
- `production`: the daily loop from script to post, with bulk upload of takes matched to their scripts and an automatic edit queue.
- `editing`: the `media-py` cut engine with silence cuts, captions, format templates, loudness finishing, quality checks and revisions by reference.
- `publishing`: weekly plans from your cadence, payload validation, dry runs, idempotent scheduling, Instagram main-feed assist and tracked links.
- `community`: keyword ledger, comment-to-DM automations, lead magnets, DM triage with draft replies and CRM handoff.
- `ops`: morning brief with a no-AI fallback, approvals queue, Telegram and Discord chat with approve and revise buttons, quiet hours, alert dedupe and demo mode.
- `learn`: metric snapshots, results against your own normal, post-mortems, the weekly report and spend tracking.
- `knowledge`: a searchable memory of your Brand Kit, posts, scripts, research and lessons in your own Postgres (pgvector), with local embeddings by default.
- `trial-reels`: turns a clean reel into a day of Instagram trial-reel variations, scheduled as trial reels only after your OK.

#### Providers

- Publishing, inbox and own analytics: Zernio (default) and Blotato.
- Research: Apify (default), Instagram Graph API and yt-dlp.
- Own analytics from a CSV import.
- Trends: RSS, Google News, Hacker News, Reddit and GitHub.
- Speech to text: whisper.cpp, on your own machine.
- Notifications and chat: Telegram (default), Discord and console.
- CRM: built-in contacts, or a signed webhook, Google Sheets, GoHighLevel or HubSpot.
- Knowledge embeddings: local by default, OpenAI or Voyage optional.

#### Claude Code and the engine

- The Claude Code plugin: `/attention:*` commands, seven agents (Analyst, Strategist, Copywriter, Art Director, Publisher, Community, Chief of Staff), module skills, a copy guard hook and a session-start summary of pending approvals.
- The MCP data server with actor attribution and module tools.
- The `attentionos` CLI, run inside the stack (`./aos cli <args>`): `create`, `init`, `doctor`, `db push`, `run`, `status`, `approvals`, `studio`, `up`, `worker` and `mcp`.
- Brand Kit schemas and starter files, plus the `coach-consultant` and `agency-founder` presets.
- Postgres schema v1 with `workspace_id` on every table and row-level security.
- A queue that runs your own requests first: chat, uploads, "Ask the AI" and revisions jump ahead of scheduled work, a slot is kept for them (`runner.userSlots`), heavy jobs such as renders are capped (`runner.maxHeavy`), and new work starts at once (Postgres LISTEN/NOTIFY).
- Docs for setup Levels 1–4, Studio, every module and provider, costs, FAQ, architecture and decision records.
- CI on Node 22 and 24 with typecheck, tests, the brand-literal guard, media-py checks, gitleaks and a DCO check.
