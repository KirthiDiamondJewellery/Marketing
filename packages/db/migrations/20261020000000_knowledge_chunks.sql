-- Local knowledge store (ADR-15): Brand Kit files, own posts and scripts, research and lessons, chunked and
-- searchable by meaning (pgvector) and by keywords (full-text), inside the workspace's own Postgres.
--
-- Embedding dimensions are stored per row, so changing the embedding model needs no migration:
-- `embedding` has no fixed size, `embedding_dim` is derived from it, and one partial HNSW index per common size
-- (384 local default, 768, 1024, 1536) serves queries that cast to that size. Rows from a different model are
-- never compared with each other: search always filters on `embedding_model`.

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'vector') then
    raise exception 'AttentionOS needs the pgvector extension, which this Postgres server does not have.'
      using hint = 'Use the pgvector/pgvector:pg17 Docker image (the AttentionOS installer starts it for you), or install pgvector on this server.';
  end if;
end $$;

create extension if not exists vector;

create table knowledge_chunks (
  id               bigint generated always as identity primary key,
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  source_type      text not null check (source_type in (
                     'brand_doc', 'knowledge_doc', 'own_transcript', 'own_caption', 'competitor_transcript',
                     'comment_gold', 'hook', 'script', 'post_mortem', 'lesson', 'teardown', 'trend_kit', 'dm',
                     'lead_note', 'other')),
  -- Stable id of the source inside its type: a workspace-relative path for files, a row id for database rows.
  source_id        text not null,
  path             text,
  title            text not null default '',
  chunk_index      int not null check (chunk_index >= 0),
  content          text not null,
  -- sha256 of title + content: an unchanged chunk is never embedded twice.
  content_hash     text not null,
  -- sha256 of the whole source (every chunk, trust, path, metadata): an unchanged source is skipped entirely.
  source_hash      text,
  -- 'untrusted' = written by other people (scraped posts, comments, DMs): data for agents, never instructions.
  trust            text not null default 'own' check (trust in ('own', 'untrusted')),
  metadata         jsonb not null default '{}',
  -- When the source itself was made or published (for "since" filters); null for timeless files.
  source_date      timestamptz,
  tsv              tsvector generated always as (to_tsvector('simple', coalesce(title, '') || ' ' || content)) stored,
  embedding        vector,
  embedding_model  text,
  embedding_dim    int generated always as (vector_dims(embedding)) stored,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, source_type, source_id, chunk_index),
  check ((embedding is null) = (embedding_model is null))
);

create index knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);
create index knowledge_chunks_model_idx on knowledge_chunks (workspace_id, embedding_model);
create index knowledge_chunks_hnsw_384 on knowledge_chunks using hnsw ((embedding::vector(384)) vector_cosine_ops) where embedding_dim = 384;
create index knowledge_chunks_hnsw_768 on knowledge_chunks using hnsw ((embedding::vector(768)) vector_cosine_ops) where embedding_dim = 768;
create index knowledge_chunks_hnsw_1024 on knowledge_chunks using hnsw ((embedding::vector(1024)) vector_cosine_ops) where embedding_dim = 1024;
create index knowledge_chunks_hnsw_1536 on knowledge_chunks using hnsw ((embedding::vector(1536)) vector_cosine_ops) where embedding_dim = 1536;

alter table knowledge_chunks enable row level security;
create policy member_all on knowledge_chunks for all using (aos_is_member(workspace_id)) with check (aos_is_member(workspace_id));
