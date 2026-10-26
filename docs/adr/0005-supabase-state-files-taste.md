# ADR-5: Supabase for state; files for taste

- **Status:** Accepted (revised 2026-10-10: local Postgres with pgvector replaces Supabase; see the revision below)
- **Date:** Recorded 2026-10-11 (the original decision and its 2026-10-10 revision were written up together)
- **Deciders:** Maintainers

## Context

Two kinds of information drive AttentionOS. **Taste** (voice, audience, offers, lanes, house style, lessons) should be readable, editable by hand and by Claude, and versioned. **Facts** (posts, metrics, queues, approvals, costs) need transactions, queries, concurrency and a queue.

## Decision

- **Taste lives in files**: the Brand Kit (markdown and YAML in `brand/`), versioned in the user's git.
- **Facts live in Postgres**, Supabase by default (free tier, Storage, RLS). Plain Postgres 15+ also works.
- A read-only `brand_docs` index lets the dashboard show Brand Kit files; dashboard edits are written back to the files, which stay the source of truth.

## Consequences

- Users can read and change their brand in any editor, and see its history in git.
- The job queue uses Postgres (`FOR UPDATE SKIP LOCKED`), so no separate queue service is needed.
- Two stores must be kept consistent; the files are always authoritative for taste.

## Alternatives considered

- **Everything in the database.** Harder to read, edit and version by hand.
- **Everything in files (JSON stores).** No safe concurrency, queries or queue; fragile once several processes write at once.
- **SQLite locally.** Simpler install, but no shared access for the worker, dashboard and multiple machines, and no RLS.

## Revision 2026-10-10: local Postgres with pgvector, no Supabase

**Decision.** The open-source project runs fully locally. State lives in **the user's own Postgres with the pgvector extension**, run in the Docker stack as the `pgvector/pgvector:pg17` image (or any Postgres 16+ with pgvector the user already runs). Supabase is no longer the default or a setup step, and setup needs no cloud account. Taste still lives in files.

- The same database also holds the **knowledge store** (`knowledge_chunks`, [ADR-15](0015-local-rag-pgvector.md)): a derived, searchable copy of the Brand Kit, posts, scripts and research. The Brand Kit files remain the source of truth; the index is rebuilt from them.
- The schema stays portable. Row-level security and the `aos_uid()` helper still work on plain Postgres: with no JWT claims, `aos_uid()` returns null, so policies deny API-style access and the engine (the database owner) is unaffected. Nothing in the migrations needs Supabase roles, schemas or extensions other than `citext`, `pgcrypto` and `vector`.
- `attentionos db push` refuses a server without pgvector with a plain message and the fix.
- A user who already has a Supabase project can still point `DATABASE_URL` at it (Supabase ships pgvector); it is simply not the recommended path.

**Why.** One install with no accounts is the biggest win for a non-technical owner's first hour. Running locally keeps every fact, and every embedding, on the user's machine, costs nothing, and removes a vendor from the setup path. Docker already runs the worker and Studio, so the database adds no new setup step.

**Consequences.** Backups are the user's: `./aos backup` dumps the database and workspace, and the user schedules it ([docs/install.md#backups](../install.md#backups)). Remote access from several machines needs the VPS setup (ADR-12) rather than a hosted database. The SQLite alternative above stays rejected: the job queue, row-level security and pgvector all need Postgres.

