-- Scripting module: additive changes for the hook banks.

-- The structure of a hook with its words replaced by [placeholders]. Competitor hooks are untrusted
-- text: tool-using agents only ever see this abstract, written by the tool-less classifier and validated.
alter table hooks add column if not exists abstract text;

-- One bank entry per source post, so harvesting is idempotent.
create unique index if not exists hooks_own_source_uidx
  on hooks (workspace_id, (source_ref ->> 'post_id'))
  where origin = 'own';
create unique index if not exists hooks_competitor_source_uidx
  on hooks (workspace_id, (source_ref ->> 'external_post_id'))
  where origin = 'competitor';

create index if not exists hooks_pattern_idx on hooks (workspace_id, pattern) where status = 'active';
create index if not exists scripts_content_version_idx on scripts (workspace_id, content_id, version desc);
create index if not exists keywords_content_idx on keywords (workspace_id, content_id);
