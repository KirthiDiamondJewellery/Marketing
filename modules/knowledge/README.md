# Knowledge (Analyst)

A searchable memory of the workspace, kept in your own Postgres with pgvector ([ADR-15](../../docs/adr/0015-local-rag-pgvector.md)). Every agent can look up what the owner already said, decided, proved or learned, by meaning and by keyword at once. Core module, setup level 1. The engine code lives in [`@attentionos/knowledge`](../../packages/knowledge).

## What gets indexed

| Source type | From | Trust |
|---|---|---|
| `brand_doc` | `brand/*.md` and `brand/*.yaml` (YAML one item per passage) | own |
| `knowledge_doc` | `brand/knowledge/**` (`.md`, `.txt`, `.yaml`) | own |
| `lesson` | `brand/lessons.md` | own |
| `own_caption`, `own_transcript` | published posts (caption, transcript in the post payload) | own |
| `script` | the newest script per content item (approved first) | own |
| `hook` | the hook banks; competitor hooks only as their validated structure | own |
| `post_mortem` | post-mortems and their lessons | own |
| `competitor_transcript`, `comment_gold` | competitor transcripts, captions and top comments | untrusted |
| `teardown`, `trend_kit` | teardowns and trend kits (they quote other people) | untrusted |

`dm` and `lead_note` are reserved source types; DMs are not indexed.

## Jobs

| Job | Kind | Default schedule | What it does |
|---|---|---|---|
| `knowledge.index-workspace` | native | hourly (:25) | Incremental: unchanged sources are skipped by hash, only new or edited passages are embedded, passages of deleted sources are removed. Input `{ sources?, paths? }`. |
| `knowledge.index-path` | native | on demand | Re-reads one Brand Kit file after an edit (`{ path: "brand/voice.md" }`); a deleted file is removed. |

## MCP tools

- `knowledge_search` `{ query, k?, sourceTypes?, trust?, sinceDays? }`: hybrid search (vector cosine top-N and full-text `ts_rank` top-N, fused with reciprocal rank fusion). Other people's text comes back under `untrusted` with a note. If vectors can't be made (no `uv` yet, no key), it searches by keyword and says so.
- `knowledge_status`: passages per source type, vectors per model, last run.

## Settings

- Top-level `knowledge: { embeddings: "local" | "openai" | "voyage", model? }` in `config/attentionos.config.ts`. `local` (default) runs `BAAI/bge-small-en-v1.5` (384 dimensions) on your CPU through `media-py` (`uv sync --extra embed`); no key. `openai` uses `OPENAI_API_KEY` (`text-embedding-3-small`), `voyage` uses `VOYAGE_API_KEY` (`voyage-3.5`). Changing either re-embeds everything on the next run; no migration is needed.
- `modules.knowledge.settings.refreshOnSearchMinutes` (default 60): a search catches the index up first when it is older than this, so "On request" workspaces stay fresh without the schedule. 0 turns it off.
