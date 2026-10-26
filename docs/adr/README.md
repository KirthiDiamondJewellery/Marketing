# Architecture decision records

Each record explains one significant decision: the context, what we decided, what follows from it, and what else we considered. Records use a lightweight [MADR](https://adr.github.io/madr/) style.

| # | Decision | Status |
|---|---|---|
| [ADR-1](0001-zernio-default-publisher.md) | Zernio default publisher; Blotato adapter | Accepted |
| [ADR-2](0002-layered-product-one-data-layer.md) | Layered product: Claude Code plugin and CLI first, worker and Studio on top, one data layer | Accepted |
| [ADR-3](0003-copilot-and-autopilot.md) | Background AI work runs on the user's own Claude Code by default; API key optional; Copilot (on request) and Autopilot (scheduled) modes | Accepted (revised 2026-10-10) |
| [ADR-4](0004-typescript-core-python-sidecar.md) | TypeScript core plus a Python `media-py` sidecar (JSON in, JSON out) | Accepted |
| [ADR-5](0005-supabase-state-files-taste.md) | State in a local Postgres with pgvector (Supabase dropped); files for taste (Brand Kit) | Accepted (revised 2026-10-10) |
| [ADR-6](0006-engine-workspace-split.md) | Engine and workspace split | Accepted |
| [ADR-7](0007-cut-engine-default.md) | Cut engine by default, Remotion opt-in, one `EditPlan` schema | Accepted |
| [ADR-8](0008-mit-license-new-repository.md) | MIT license, new repository | Accepted |
| [ADR-9](0009-apify-default-scraper.md) | Apify default for competitor data, Instagram Graph API fallback, yt-dlp for TikTok and YouTube | Accepted |
| [ADR-10](0010-telegram-default-notifier.md) | Telegram default notifier, Discord adapter, email digest (planned) | Accepted |
| [ADR-11](0011-workspace-id-and-rls.md) | `workspace_id` and RLS from day one; single-workspace UI until later | Accepted |
| [ADR-12](0012-autopilot-local-first.md) | Autopilot runs locally by default; Docker for a VPS; webhooks through a tunnel | Accepted (Docker is now the standard way to run) |
| [ADR-13](0013-instagram-feed-assist.md) | Instagram main feed defaults to "assist", with an autopost toggle | Accepted |
| [ADR-14](0014-opt-in-risky-features.md) | Trial reels and scraping opt-in with notices; no browser automation | Accepted |
| [ADR-15](0015-local-rag-pgvector.md) | Local knowledge store (RAG) in Postgres with pgvector; local embeddings by default, API embeddings optional | Accepted |

## Writing a new record

1. Copy the shape of an existing record: title, status, date, deciders, then **Context**, **Decision**, **Consequences**, **Alternatives considered**.
2. Number it with the next free number, and add it to the table above.
3. Start it as **Proposed**. It becomes **Accepted** when maintainers agree, and **Superseded by ADR-N** if a later record replaces it. Never delete a record.
