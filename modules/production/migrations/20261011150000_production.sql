-- Production (film → upload → edit → approve → schedule). Two small tables owned by the production module.

-- One row per uploaded take: the transcript of its first minute, the scripts it may belong to, and what it was
-- linked to. A take linked as `edit` is the one being edited; extra takes of the same script are kept as `take`.
create table if not exists production_uploads (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  asset_id      uuid references media_assets(id) on delete set null,
  file_name     text not null,
  bytes         bigint,
  duration_s    numeric,
  status        text not null default 'matching' check (status in ('matching', 'suggested', 'linked', 'unmatched', 'failed', 'dismissed')),
  role          text check (role in ('edit', 'take')),
  transcript    text,
  candidates    jsonb not null default '[]',   -- [{contentId, title, score, hookScore, reason}]
  content_id    uuid references content(id) on delete set null,
  confidence    numeric,
  linked_by     text,                          -- 'auto' or the actor who linked it
  linked_at     timestamptz,
  edit_job_id   uuid references edit_jobs(id) on delete set null,
  error         text,
  created_by    text not null default 'system',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists production_uploads_ws_idx on production_uploads (workspace_id, created_at desc);
create index if not exists production_uploads_content_idx on production_uploads (workspace_id, content_id);
create unique index if not exists production_uploads_asset_idx on production_uploads (asset_id) where asset_id is not null;

-- One row per approved (or proposed) version of an edit: the planned post slots, caption overrides from the
-- approval card and what scheduling did per platform.
create table if not exists production_releases (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  edit_job_id   uuid not null references edit_jobs(id) on delete cascade,
  content_id    uuid references content(id) on delete set null,
  version       int not null,
  approval_ref  text,
  plan_id       uuid,                          -- week_plan approval subject approved together with the video
  status        text not null default 'proposed' check (status in ('proposed', 'approved', 'scheduling', 'scheduled', 'partial', 'failed')),
  slots         jsonb not null default '[]',   -- [{platform, scheduledAt, mode}]
  captions      jsonb not null default '{}',   -- {platform: caption} overrides
  outcomes      jsonb not null default '[]',   -- [{platform, outcome, postId, message, scheduledAt, mode}]
  approved_by   text,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (edit_job_id, version)
);
create index if not exists production_releases_ws_idx on production_releases (workspace_id, status, updated_at desc);
