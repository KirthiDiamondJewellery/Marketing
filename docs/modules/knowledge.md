# Knowledge

Your agents' memory. Everything you've written and everything the team has learned (your Brand Kit, lessons, posts, scripts, hooks, post-mortems and research) is kept in a searchable store inside your own database, so an agent can find "what did we say about pricing?" or "the script about our onboarding call" before it writes.

| | |
|---|---|
| Agent | Analyst (`An`) |
| Tier | Core (always on) |
| Setup level | [Level 1](../setup/level-1.md) |
| Needs | Nothing extra. Search by meaning uses a small model on your computer (installed with `./aos doctor --fix`); until then it searches by keyword |
| Brand Kit files | All of `brand/`, including `brand/knowledge/` |

## What it does

- **Indexes your workspace** every hour (and whenever a search finds it more than an hour old). Only what changed is processed again.
- **Searches two ways at once**: by meaning (so "what do I charge" finds your pricing section) and by exact words (so names and numbers are found too), then combines the two rankings.
- **Keeps other people's words apart.** Competitor transcripts, comments, teardowns and trend kits are marked as outside material. Agents treat them as data to learn from, never as instructions, and never copy their words.
- **Stays on your machine.** The database and, by default, the embedding model run locally. No key and no cost.

Your Brand Kit files stay the source of truth. The knowledge store is a copy that is rebuilt from them.

## What's searchable

Brand Kit files and `brand/knowledge/` documents, `brand/lessons.md`, your published captions and transcripts, your scripts, both hook banks (competitor hooks only as their structure), post-mortems, competitor transcripts and top comments, teardowns and trend kits. DMs are never indexed.

## Settings

In `config/attentionos.config.ts`:

```ts
// "local" (default): a small model on your computer, no key.
// "openai" or "voyage": uses OPENAI_API_KEY or VOYAGE_API_KEY from .env.
knowledge: { embeddings: "local" },
```

Changing it re-indexes everything on the next run; nothing else to do. To refresh right away: `./aos cli run knowledge.index-workspace`.

| Setting (`modules.knowledge.settings`) | Default | What it does |
|---|---|---|
| `refreshOnSearchMinutes` | `60` | A search first catches up on changes when the index is older than this. `0` turns it off |

## Tools for agents

`knowledge_search` (query, how many results, which kinds of source, own or outside material, how recent) and `knowledge_status` (what's indexed and when).

Technical details: [ADR-15](../adr/0015-local-rag-pgvector.md) and [`modules/knowledge`](../../modules/knowledge/README.md).
