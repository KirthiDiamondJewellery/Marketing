# Architecture

This page explains how AttentionOS fits together: what runs where, where your files and data live, and how the agents, skills and providers connect.

## The big picture

```
┌─────────────────────────── Your machine (or a VPS / Docker) ─────────────────────────────┐
│                                                                                          │
│  Claude Code ──plugin──► skills + subagents + /attention:* commands + hooks  (you)       │
│        │                                                                                 │
│        ├──MCP──► AttentionOS data server ◄──MCP── Worker (`claude -p`, or API engine)    │
│        │              │                          │  scheduler + Postgres queue           │
│        │              │                          │  native jobs (no model): sync, score  │
│        │              │                          ├─► media-py: speech, cut, render, QC   │
│        │              │                          └─► motion renderer (planned)           │
│        │              ▼                                                                  │
│        │       Postgres + pgvector  ◄──── Studio dashboard (in the Docker stack)         │
│  workspace/ (git):  brand/  config/  media/ (gitignored)                                 │
└──────────────────────────────┬───────────────────────────────────────────────────────────┘
                               │ provider adapters
   Zernio | Blotato (publish, DMs, analytics) · Apify | IG Graph | yt-dlp (research)
   whisper.cpp (speech) · Telegram | Discord | console (notify) · CRM webhook | Sheets | GoHighLevel | HubSpot
   Planned: Parakeet and cloud speech, email notify, OpenAI | Gemini images, S3 | R2 storage
   Webhooks in: post, message and analytics events → worker endpoint (tunnel or VPS)
```

## The loop and the team

```
            ┌──────────────────────────── Learn ◄─────────────────────────────┐
            ▼                                                                 │
Research ─► Strategy ─► Script ─► (Film: you) ─► Edit ─► Publish ─► Engage ─► Measure
Analyst     Strategist  Copywriter               Art Dir. Publisher Community  Analyst
            └─ approvals at every public step, per autonomy level ─┘
```

Six agents share the work; the Chief of Staff is your interface. Every stage is a [module](README.md#modules) you can turn on or off.

## Engine and workspace

AttentionOS is split in two:

| | Engine (this repository) | Workspace (yours) |
|---|---|---|
| What | npm packages, the Claude Code plugin, the `media-py` video tools | Your Brand Kit, config, lessons and media |
| Created by | Maintainers | The Docker stack on first start (`attentionos create`) |
| Updated by | Releases | You and your agents |
| Upgrades | `./aos update` | Never overwritten |

You never edit engine code to personalize AttentionOS. Personalization comes from three layers:

1. **Brand Kit**: markdown and YAML files in `brand/` that hold your voice, audience, offers, lanes, proof, house style and lessons.
2. **Preset**: a starting point for your kind of business (`coach-consultant`, `agency-founder`).
3. **Module config**: a small typed config per module in `config/attentionos.config.ts`, checked by `attentionos doctor`.

### Workspace layout

```
my-brand/
  brand/
    brand.yaml             name, handles, offers, timezone, call-to-action model, funnel mix
    icp.md                 who you talk to, in their words
    voice.md               your voice profile and banned words
    offers.md              what you sell and which results you may claim
    pillars.md             lanes (YAML front matter), angles, story structures, rejected concepts
    proof-inventory.yaml   case studies, wins, FAQs, objections: the only source of numbers
    house-style.md         editing taste every edit inherits
    competitors.yaml       creators you track, per platform and tier
    sources.yaml           trend and news sources for your niche
    lessons.md             dated rules from your corrections
    knowledge/             optional deeper documents
  config/
    attentionos.config.ts  modules, providers, schedules, budgets, autonomy
  media/                   raw/, renders/, assets/ (gitignored)
  .attentionos/            local caches and models (gitignored)
  .mcp.json                starts the AttentionOS data server for Claude Code
  .claude/settings.json    recommends the plugin and pre-approves the data server
  .env                     your keys (gitignored)
  CLAUDE.md                how Claude should work in this workspace
  package.json             depends on the `attentionos` package
```

The config file imports its helper from the CLI package:

```ts
import { defineConfig } from "attentionos/config";
export default defineConfig({ /* ... */ });
```

**Taste lives in files; facts live in the database.** The Brand Kit is plain text you can read, edit and keep in git. Posts, metrics, queues and approvals live in Postgres.

## One data layer

Every agent, skill, job and screen reads and writes through the same repositories in `@attentionos/core`. Agents reach them as tools on the **AttentionOS data server** (MCP).

- **Attribution.** Every write records who made it: `agent:<name>`, `user:<id>` or `system`.
- **Rules live inside tools**, not prompts: keyword collisions, idempotency, approval checks.
- **Compact output.** Empty fields are dropped so tool results stay small and cheap.
- **One name everywhere.** The server is called `attentionos`, so tools are `mcp__attentionos__<module>_<verb>_<noun>` in both Copilot (from the workspace `.mcp.json`) and Autopilot.

## Jobs

The unit of work is a **job** (`<module>.<job>`, for example `ops.morning-brief`).

- **Native jobs** are plain code: syncing, scoring, finishing, QC, the brief composer.
- **Model jobs** follow a skill, may only use the tools they list, and run with a budget, a turn limit and a timeout. Jobs that read untrusted text run with **no tools** and their output is validated.

Jobs run from a Postgres queue (`FOR UPDATE SKIP LOCKED`), with heartbeats and automatic recovery of stalled runs. Each run streams plain-language progress events to the activity feed.

## Database

Your own local Postgres with the pgvector extension (Postgres 16+ with pgvector; 17 in the Docker stack, the `pgvector/pgvector:pg17` service). Every table carries `workspace_id`, with row-level security keyed on workspace membership, so several brands can share one database safely. Main areas:

| Area | Tables |
|---|---|
| Tenancy | workspaces, members, settings, budgets, counters |
| Research | tracked creators, external posts and snapshots, trends, teardowns |
| Content | hooks, content, scripts, keywords, lead magnets |
| Media | media assets, edit jobs |
| Publishing | social accounts, posts, post metrics |
| Community | DM automations, contacts, triage items |
| Learn | feature stats, post-mortems, goals |
| Agents | agents, runs, events, approvals, messages (outbox), alert log |
| Knowledge | knowledge chunks (passages with full-text and vector indexes) |

Short human references (`ap-7` for approvals, `rf-12` for edits) come from per-workspace counters. Migrations live in `packages/db/migrations/` and in each module's `migrations/` folder, and are applied with `attentionos db push`.

## Knowledge store (local RAG)

The `knowledge` module keeps a searchable memory in the same Postgres ([ADR-15](adr/0015-local-rag-pgvector.md)): Brand Kit files, lessons, the owner's captions, transcripts and scripts, hooks, post-mortems and research, split into passages of up to about 800 tokens (smaller when the embedding model reads less). Each passage has a full-text index and an embedding.

- **Embeddings are local by default**: `BAAI/bge-small-en-v1.5` (384 dimensions) runs on the CPU through `media-py` (fastembed, ONNX). No key, no cost. OpenAI or Voyage embeddings are optional (`knowledge.embeddings` in the config).
- **Search is hybrid**: the top matches by meaning (cosine distance, HNSW index) and by keywords (`ts_rank`) are fused with reciprocal rank fusion. Agents use it through the `knowledge_search` tool.
- **Indexing is incremental**: an hourly job (and every search, when the index is over an hour old) re-reads sources, skips anything whose hash hasn't changed, and embeds only new or edited passages.
- **Trust is recorded per passage**: other people's words (competitor transcripts, comments, teardowns, trend kits) are marked untrusted and returned apart, as data, never instructions.
- **Taste still lives in files.** The index is a derived copy; the Brand Kit files stay the source of truth.

## Providers

Each outside service sits behind a typed interface in `packages/core/src/providers.ts` and is implemented by a package in `packages/providers/<kind>-<vendor>`. Modules never import a vendor SDK. See [providers](providers/README.md).

## Modules

```
modules/<id>/
  module.json      id, agent, tier, setup level, dependencies, providers, default schedules
  src/index.ts     the module definition: jobs, tools, settings schema
  src/jobs/        native and model jobs
  src/tools/       data-server tools this module contributes
  skills/          method skills (SKILL.md), shared by Copilot and Autopilot
  migrations/      SQL the module owns
  README.md
```

## The plugin

The Claude Code plugin is generated by `pnpm plugin:build` from `plugin-src/` (commands, subagents, hooks) plus every module's `skills/`. The repository root holds `.claude-plugin/marketplace.json`, so `/plugin marketplace add evanbaker315/AttentionOS` works directly.

## media-py

A Python 3.12 sidecar (managed by `uv`) for speech-to-text, cutting, rendering, graphics, sound synthesis, face-aware framing, loudness and QC. The TypeScript engine calls it with JSON in and JSON out, so each step is testable on its own.

## Safety principles

- **Code holds the gates, the model does the judgment.** Validators are deterministic and never edited by a model at runtime.
- **Untrusted text** only reaches tool-less model calls with validated output.
- **The human has the final word.** Autonomy is per agent, and every surface reads one approvals queue.
- **No brand literals in the engine.** Skills reference Brand Kit files by path; CI fails if engine code contains brand-specific text.

## Further reading

- [How your agents run](copilot-vs-autopilot.md)
- [Architecture decision records](adr/README.md)
- [Design system](../design/DESIGN.md)
