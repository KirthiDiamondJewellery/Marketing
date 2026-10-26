# ADR-15: Local knowledge store (RAG) in Postgres with pgvector, local embeddings by default

- **Status:** Accepted
- **Date:** 2026-10-10
- **Deciders:** Maintainers

## Context

Agents write better when they can recall what the owner already said, decided, proved and learned: past scripts on a topic, a lesson from last month, the FAQ answer for a DM, which hook worked. Reading every Brand Kit file and listing every table on each run is slow and wasteful, and misses older posts and research. The project runs fully locally (ADR-5 revision): no cloud account at setup, nothing leaves the user's machine unless they choose a provider.

## Decision

- **One table in the existing database.** `knowledge_chunks` lives in the workspace's own Postgres with the pgvector extension (the `pgvector/pgvector:pg17` image in the Docker stack; any Postgres 16+ with pgvector works). No separate vector database. Every row carries `workspace_id`, row-level security, a `trust` level (`own` or `untrusted`) and a `source_type`.
- **Hybrid search.** Each passage has a generated full-text column (`to_tsvector('simple', title || content)`, GIN index) and an embedding (HNSW, cosine). `knowledge_search` takes the top matches by meaning and by keywords and fuses them with reciprocal rank fusion (k = 60), so exact names and numbers are found as reliably as paraphrases.
- **Local embeddings by default.** `BAAI/bge-small-en-v1.5` (384 dimensions, MIT, about 70 MB) runs on the CPU through `media-py` (`fastembed`, ONNX Runtime, optional `embed` extra), cached next to the speech models. No key and no cost. OpenAI (`text-embedding-3-small`, 1536) and Voyage (`voyage-3.5`, 1024) are optional through `knowledge.embeddings` in the config.
- **No migration to change models.** The `embedding` column has no fixed size; `embedding_dim` is derived from it, and there is one partial HNSW index per common size (384, 768, 1024, 1536). Every row records its `embedding_model`, searches only compare vectors from the current model, and the next index run re-embeds rows from any other model. Other sizes work with an exact scan.
- **Incremental indexing.** Sources are chunked deterministically (markdown by headings and paragraphs, up to about 800 tokens and never more than the model reads, with a little overlap inside a section; YAML one item per passage). A per-source hash skips unchanged sources; a per-passage hash keeps vectors for unchanged passages; passages of deleted sources are removed. `knowledge.index-workspace` runs hourly; `knowledge.index-path` re-reads one file after an edit; a search catches the index up first when it is over an hour old.
- **Graceful without vectors.** If the embedder can't run (no `uv` yet, no key, offline), passages are stored without vectors, search falls back to keywords and says so, and the next run fills the vectors in.
- **Untrusted text stays marked.** Competitor transcripts and comments, teardowns and trend kits are stored as `untrusted` and returned under a separate `untrusted` key with a note that they are data, never instructions, as research tools already do. Competitor hooks are indexed only as their validated structure. DMs are not indexed.

## Consequences

- Every agent gets one tool for recall, and skills can point to it (`write-script`, `daily-brief`, `dm-triage`, `owner-chat`).
- The database now requires pgvector. Plain Postgres images without it fail `db push` with a clear fix; CI uses the pgvector image.
- The first local embedding run downloads the model once (about 70 MB) and embeds the workspace on CPU, typically well under a minute for one brand; later runs embed only changes. Each embedding call starts the Python sidecar, so a search pays a short start-up cost; a long-running embedding process can come later if needed.
- The index is a derived copy. The Brand Kit files remain the source of truth for taste (ADR-5).

## Alternatives considered

- **A separate vector database (Chroma, Qdrant, LanceDB).** Another service to install, back up and secure, and no joins or RLS with the rest of the data.
- **API embeddings by default.** Better multilingual quality, but needs a key and a bill at setup and sends the owner's material to a third party. Kept as an option.
- **Keyword search only.** Simple, but misses paraphrases ("what do I charge" vs "pricing"). Kept as the fallback.
- **A fixed `vector(384)` column.** Simplest, but switching models would need a migration and a table rewrite.
