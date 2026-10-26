-- AttentionOS schema v1.
-- Every table carries workspace_id. The engine connects as the database owner; RLS policies
-- (keyed on workspace_members) protect access from Studio users and the Supabase API.
-- Portable: runs on Supabase Postgres or plain Postgres 15+.

create extension if not exists citext;
create extension if not exists pgcrypto;

-- Current user id from a Supabase/PostgREST JWT; null for direct connections.
create or replace function aos_uid() returns uuid
language plpgsql stable as $$
declare
  sub text;
begin
  sub := nullif(current_setting('request.jwt.claim.sub', true), '');
  if sub is null then
    sub := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
  end if;
  return nullif(sub, '')::uuid;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  timezone    text not null default 'America/New_York',
  is_demo     boolean not null default false,
  created_at  timestamptz not null default now()
);

create table workspace_members (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null,
  role          text not null default 'owner' check (role in ('owner', 'editor', 'viewer')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table settings (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  key           text not null,
  value         jsonb not null,
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, key)
);

-- Per-workspace counters for short human refs (rf-12, ap-7) and post numbers.
create table counters (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  value         bigint not null default 0,
  primary key (workspace_id, name)
);

create or replace function aos_next_counter(p_ws uuid, p_name text) returns bigint
language sql as $$
  insert into counters (workspace_id, name, value) values (p_ws, p_name, 1)
  on conflict (workspace_id, name) do update set value = counters.value + 1
  returning value;
$$;

-- Spend tracking (cost watch). Amounts in micro-USD.
create table cost_ledger (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  ts            timestamptz not null default now(),
  category      text not null check (category in ('llm', 'scraping', 'publishing', 'images', 'asr', 'other')),
  provider      text not null,
  amount_micro  bigint not null,
  run_id        uuid,
  detail        jsonb
);
create index cost_ledger_ws_ts_idx on cost_ledger (workspace_id, category, ts desc);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table social_accounts (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  provider             text not null,
  provider_account_id  text not null,
  platform             text not null,
  handle               text not null,
  display_name         text,
  status               text not null default 'connected' check (status in ('connected', 'expired', 'error', 'disabled')),
  connected_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, provider, provider_account_id)
);

-- ---------------------------------------------------------------------------
-- Research
-- ---------------------------------------------------------------------------

create table tracked_creators (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  platform         text not null,
  handle           text not null,
  tier             text not null default 'core' check (tier in ('core', 'adjacent', 'aspirational', 'remake', 'own')),
  active           boolean not null default true,
  -- Baseline medians over mature posts, refreshed by the scorer: {views, comments, likes, n, computed_at}
  baseline         jsonb,
  last_scanned_at  timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),
  unique (workspace_id, platform, handle)
);

create table external_posts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  tracked_creator_id uuid references tracked_creators(id) on delete set null,
  platform           text not null,
  platform_post_id   text not null,
  author_handle      text not null,
  url                text not null,
  published_at       timestamptz,
  caption            text,
  duration_s         numeric,
  is_pinned          boolean not null default false,
  views              bigint,
  likes              bigint,
  comments           bigint,
  shares             bigint,
  -- Outlier score vs the author's own baseline.
  x_score            numeric,
  x_detail           jsonb,
  is_outlier         boolean not null default false,
  is_meme            boolean not null default false,
  transcript         text,
  spoken_hook        text,
  tags               jsonb,          -- vision tags: format, frame1_style, production_level, wps
  top_comments       jsonb,
  media_path         text,
  first_seen_at      timestamptz not null default now(),
  last_updated_at    timestamptz not null default now(),
  unique (workspace_id, platform, platform_post_id)
);
create index external_posts_outlier_idx on external_posts (workspace_id, is_outlier, published_at desc);
create index external_posts_creator_idx on external_posts (tracked_creator_id, published_at desc);

create table external_post_snapshots (
  id                bigint generated always as identity primary key,
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  external_post_id  uuid not null references external_posts(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  views             bigint,
  likes             bigint,
  comments          bigint,
  shares            bigint
);

create table trends (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  source_id      text not null,
  external_id    text not null,
  title          text not null,
  url            text not null,
  author         text,
  published_at   timestamptz,
  points         bigint,
  comments       bigint,
  velocity       numeric,
  heat           numeric,
  relevance      numeric,
  status         text not null default 'new' check (status in ('new', 'shortlisted', 'kit', 'used', 'dismissed', 'expired')),
  -- Filmable kit: {header, beats[{text, visual}], caption, keyword, sources}
  story          jsonb,
  followup_at    timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  unique (workspace_id, source_id, external_id)
);
create index trends_heat_idx on trends (workspace_id, status, heat desc);

create table trend_snapshots (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  trend_id      uuid not null references trends(id) on delete cascade,
  captured_at   timestamptz not null default now(),
  points        bigint,
  comments      bigint
);

create table teardowns (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  external_post_id  uuid references external_posts(id) on delete set null,
  platform          text,
  author_handle     text,
  url               text not null,
  analysis_md       text not null,
  fingerprint       jsonb,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Hooks and content
-- ---------------------------------------------------------------------------

create table hooks (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  text              text not null,
  pattern           text not null,
  origin            text not null check (origin in ('own', 'competitor', 'manual')),
  source_ref        jsonb,           -- {external_post_id?, post_id?, url?, author?}
  uses              int not null default 0,
  wins              int not null default 0,
  score             numeric,
  status            text not null default 'active' check (status in ('active', 'retired')),
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz
);
create index hooks_bank_idx on hooks (workspace_id, origin, status, score desc nulls last);

create table keywords (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  word          citext not null,
  status        text not null default 'reserved' check (status in ('reserved', 'active', 'retired')),
  content_id    uuid,
  created_at    timestamptz not null default now(),
  unique (workspace_id, word)
);

create table lead_magnets (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  keyword_id    uuid references keywords(id) on delete set null,
  title         text not null,
  kind          text not null default 'page' check (kind in ('page', 'doc', 'notion', 'pdf', 'other')),
  url           text,
  tracked_url   text,
  body_md       text,
  content_id    uuid,
  created_at    timestamptz not null default now()
);

create table content (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  title            text not null,
  status           text not null default 'idea' check (status in ('idea', 'scripted', 'filming', 'editing', 'review', 'scheduled', 'published', 'measured', 'archived')),
  kind             text not null default 'reel' check (kind in ('reel', 'carousel', 'text', 'longform', 'story')),
  lane             text,
  pillar           text,
  funnel_stage     text check (funnel_stage in ('tofu', 'mofu', 'bofu')),
  angle            text,
  story_structure  text,
  template         text,             -- format template id
  hook_id          uuid references hooks(id) on delete set null,
  hook_pattern     text,
  cta_type         text,
  keyword_id       uuid references keywords(id) on delete set null,
  lead_magnet_id   uuid references lead_magnets(id) on delete set null,
  post_number      int,              -- for utm_content <keyword>_<post#>
  source_refs      jsonb not null default '[]',   -- [{type: trend|external_post|proof|manual, id, url}]
  brief            jsonb,            -- daily-brief payload: header, why, shoot directions
  film_by          timestamptz,
  deadline_at      timestamptz,
  created_by       text not null default 'system',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  published_at     timestamptz
);
create index content_status_idx on content (workspace_id, status, updated_at desc);
alter table keywords add constraint keywords_content_fk foreign key (content_id) references content(id) on delete set null;
alter table lead_magnets add constraint lead_magnets_content_fk foreign key (content_id) references content(id) on delete set null;

create table scripts (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  content_id        uuid not null references content(id) on delete cascade,
  version           int not null,
  body              text not null,
  beats             jsonb,           -- [{role: hook|turn|proof|rehook|play|close, text}]
  hook_text         text,
  hook_source       jsonb,           -- provenance: {hook_id, pattern, origin, ref}
  claim_ledger      jsonb,           -- [{claim, verdict: PASS|FIX|CUT, source, note}]
  validator_report  jsonb,
  captions          jsonb,           -- {instagram: {...}, tiktok: {...}, ...}
  status            text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'superseded')),
  created_by        text not null default 'system',
  created_at        timestamptz not null default now(),
  unique (content_id, version)
);

-- ---------------------------------------------------------------------------
-- Media and editing
-- ---------------------------------------------------------------------------

create table media_assets (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  content_id    uuid references content(id) on delete set null,
  kind          text not null check (kind in ('raw', 'proxy', 'render', 'broll', 'sfx', 'music', 'image', 'logo', 'screenshot', 'thumbnail', 'transcript', 'other')),
  uri           text not null,
  duration_s    numeric,
  width         int,
  height        int,
  bytes         bigint,
  sha256        text,
  provenance    jsonb,              -- {source, url, author, retrieved_at}
  license       text,
  created_at    timestamptz not null default now()
);

create table edit_jobs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  content_id      uuid references content(id) on delete set null,
  ref             text not null,    -- human ref "rf-12" used in chat revision loops
  engine          text not null default 'cut' check (engine in ('cut', 'motion')),
  format          text,
  version         int not null default 1,
  status          text not null default 'queued' check (status in ('queued', 'prepping', 'planning', 'rendering', 'qc', 'review', 'approved', 'failed', 'cancelled')),
  source_asset_id uuid references media_assets(id) on delete set null,
  edit_map        jsonb,            -- edit.json (keep ranges) awaiting/after human approval
  plan            jsonb,            -- EditPlan
  preflight       jsonb,
  qc_report       jsonb,
  output_asset_id uuid references media_assets(id) on delete set null,
  session_id      text,             -- agent session to resume for revisions
  notes           jsonb not null default '[]',
  cost_micro      bigint not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, ref)
);

-- ---------------------------------------------------------------------------
-- Publishing
-- ---------------------------------------------------------------------------

create table posts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  content_id         uuid references content(id) on delete set null,
  social_account_id  uuid references social_accounts(id) on delete set null,
  platform           text not null,
  provider           text not null,
  provider_post_id   text,
  platform_post_id   text,
  status             text not null default 'draft' check (status in ('draft', 'queued', 'scheduled', 'publishing', 'published', 'failed', 'cancelled', 'assist')),
  scheduled_at       timestamptz,
  published_at       timestamptz,
  url                text,
  caption            text,
  utm_content        text,
  short_link         text,
  is_trial           boolean not null default false,
  variant_of         uuid references posts(id) on delete set null,
  idempotency_key    text not null,
  payload            jsonb,
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create index posts_status_idx on posts (workspace_id, status, scheduled_at);
create index posts_platform_post_idx on posts (workspace_id, platform, platform_post_id);

create table post_metrics (
  id                bigint generated always as identity primary key,
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  post_id           uuid not null references posts(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  snapshot          text not null default 'latest' check (snapshot in ('1h', '24h', '72h', '7d', '30d', 'latest', 'import')),
  views             bigint,
  reach             bigint,
  likes             bigint,
  comments          bigint,
  shares            bigint,
  saves             bigint,
  follows           bigint,
  profile_visits    bigint,
  avg_watch_time_s  numeric,
  skip_rate         numeric,
  completion_rate   numeric,
  leads             int,
  x_score           numeric,        -- vs the user's own rolling baseline
  raw               jsonb
);
create index post_metrics_post_idx on post_metrics (post_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Community
-- ---------------------------------------------------------------------------

create table dm_automations (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  provider                 text not null,
  provider_automation_id   text,
  post_id                  uuid references posts(id) on delete set null,
  keyword_id               uuid references keywords(id) on delete set null,
  lead_magnet_id           uuid references lead_magnets(id) on delete set null,
  status                   text not null default 'draft' check (status in ('draft', 'active', 'paused', 'failed', 'deleted')),
  config                   jsonb not null,
  error                    text,
  created_at               timestamptz not null default now()
);

create table contacts (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  email            citext,
  name             text,
  phone            text,
  handle           text,
  platform         text,
  source           text,
  keyword          text,
  utm_content      text,
  temperature      text check (temperature in ('hot', 'warm', 'cold')),
  crm_external_id  text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index contacts_email_uidx on contacts (workspace_id, email) where email is not null;

create table triage_items (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  kind              text not null check (kind in ('dm', 'comment')),
  provider_item_id  text not null,
  conversation_id   text,
  provider_post_id  text,
  platform          text not null,
  from_handle       text,
  text              text not null,   -- UNTRUSTED
  prefilter         text,            -- no-AI prefilter verdict: spam | auto | needs_review
  classification    jsonb,           -- cached LLM verdict
  temperature       text check (temperature in ('hot', 'warm', 'cold')),
  draft_reply       text,
  status            text not null default 'new' check (status in ('new', 'drafted', 'approved', 'sent', 'ignored')),
  received_at       timestamptz not null,
  created_at        timestamptz not null default now(),
  unique (workspace_id, kind, provider_item_id)
);

-- ---------------------------------------------------------------------------
-- Learn
-- ---------------------------------------------------------------------------

create table feature_stats (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  dimension     text not null,     -- hook_pattern, lane, format, angle, funnel_stage, cta_type, length_bucket, slot, story_structure
  value         text not null,
  time_window   text not null,     -- e.g. 30d, 90d, all
  n             int not null,
  median_x      numeric,
  lift          numeric,
  ci_low        numeric,
  ci_high       numeric,
  computed_at   timestamptz not null default now(),
  unique (workspace_id, dimension, value, time_window)
);

create table post_mortems (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  post_id       uuid references posts(id) on delete set null,
  kind          text not null check (kind in ('breakout', 'flop', 'new_best', 'manual')),
  x_score       numeric,
  body_md       text not null,
  lessons       jsonb not null default '[]',
  created_at    timestamptz not null default now()
);

create table goals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  metric        text not null,
  target        numeric,
  period        text not null default 'week',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Agents, runs, approvals, messages
-- ---------------------------------------------------------------------------

create table agents (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  key           text not null,
  name          text not null,
  monogram      text not null,
  autonomy      text not null default 'review_all' check (autonomy in ('review_all', 'review_key', 'autopilot')),
  model         text,
  max_turns     int,
  enabled       boolean not null default true,
  config        jsonb not null default '{}',
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, key)
);

-- Postgres job queue (Platform): claimed with FOR UPDATE SKIP LOCKED.
create table agent_runs (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  agent          text not null,
  job_id         text not null,
  trigger        text not null default 'manual' check (trigger in ('schedule', 'manual', 'event', 'chat', 'webhook', 'handoff')),
  status         text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'waiting_approval')),
  input          jsonb not null default '{}',
  output         jsonb,
  error          text,
  cost_micro     bigint not null default 0,
  turns          int not null default 0,
  session_id     text,
  parent_run_id  uuid references agent_runs(id) on delete set null,
  dedupe_key     text,
  attempts       int not null default 0,
  max_attempts   int not null default 3,
  run_after      timestamptz not null default now(),
  claimed_by     text,
  heartbeat_at   timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_by     text not null default 'system',
  created_at     timestamptz not null default now()
);
create index agent_runs_queue_idx on agent_runs (status, run_after) where status = 'queued';
create unique index agent_runs_dedupe_uidx on agent_runs (workspace_id, dedupe_key) where dedupe_key is not null and status in ('queued', 'running');

create table agent_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  run_id        uuid references agent_runs(id) on delete cascade,
  agent         text not null,
  ts            timestamptz not null default now(),
  kind          text not null check (kind in ('progress', 'tool', 'text', 'error', 'handoff', 'cost', 'approval')),
  message       text not null,
  data          jsonb
);
create index agent_events_run_idx on agent_events (run_id, id);
create index agent_events_ws_idx on agent_events (workspace_id, id desc);

create table approvals (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  ref            text not null,      -- "ap-7"
  kind           text not null check (kind in ('script', 'edit', 'post', 'dm_reply', 'comment_reply', 'campaign', 'spend', 'brand_change', 'other')),
  subject_type   text not null,
  subject_id     uuid,
  agent          text not null,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'revised', 'expired')),
  summary        text not null,
  preview        jsonb,
  run_id         uuid references agent_runs(id) on delete set null,
  requested_at   timestamptz not null default now(),
  decided_at     timestamptz,
  decided_by     text,
  decision_note  text,
  unique (workspace_id, ref)
);
create index approvals_pending_idx on approvals (workspace_id, status, requested_at) where status = 'pending';

-- Channel-agnostic outbox (Telegram/Discord/email).
create table messages (
  id                   bigint generated always as identity primary key,
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  channel              text not null,
  direction            text not null check (direction in ('out', 'in')),
  dedupe_key           text,
  ref                  text,
  body                 jsonb not null,
  status               text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'received', 'handled')),
  provider_message_id  text,
  error                text,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz
);
create unique index messages_dedupe_uidx on messages (workspace_id, channel, dedupe_key) where dedupe_key is not null;
create index messages_queue_idx on messages (status, created_at) where status = 'queued';

create table alert_log (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  key           text not null,
  last_sent_at  timestamptz not null default now(),
  count         int not null default 1,
  primary key (workspace_id, key)
);

-- Read-only index of Brand Kit files so the dashboard can show them; files stay the source of truth.
create table brand_docs (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  path          text not null,
  content       text not null,
  content_hash  text not null,
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, path)
);

-- ---------------------------------------------------------------------------
-- Queue functions
-- ---------------------------------------------------------------------------

-- Claims the next runnable job for a worker. Optional agent filter.
create or replace function aos_claim_run(p_worker text, p_agents text[] default null)
returns setof agent_runs
language plpgsql as $$
begin
  return query
  update agent_runs r
     set status = 'running', claimed_by = p_worker, heartbeat_at = now(),
         started_at = coalesce(r.started_at, now()), attempts = r.attempts + 1
   where r.id = (
     select id from agent_runs
      where status = 'queued' and run_after <= now()
        and (p_agents is null or agent = any(p_agents))
      order by run_after, created_at
      for update skip locked
      limit 1
   )
  returning r.*;
end;
$$;

-- Requeues runs whose worker stopped heart-beating; fails them after max_attempts.
create or replace function aos_recover_stale_runs(p_stale interval default interval '5 minutes')
returns int
language plpgsql as $$
declare
  n int;
begin
  with stale as (
    select id, attempts, max_attempts from agent_runs
     where status = 'running' and heartbeat_at < now() - p_stale
     for update skip locked
  )
  update agent_runs r
     set status = case when s.attempts >= s.max_attempts then 'failed' else 'queued' end,
         error = case when s.attempts >= s.max_attempts then 'worker stopped responding' else r.error end,
         claimed_by = null,
         run_after = now() + make_interval(secs => 30 * s.attempts),
         finished_at = case when s.attempts >= s.max_attempts then now() else null end
    from stale s
   where r.id = s.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

create or replace function aos_is_member(p_ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = p_ws and user_id = aos_uid())
$$;

alter table workspaces enable row level security;
create policy member_read on workspaces for select using (aos_is_member(id));

do $$
declare t text;
begin
  foreach t in array array[
    'workspace_members','settings','counters','cost_ledger','social_accounts','tracked_creators','external_posts',
    'external_post_snapshots','trends','trend_snapshots','teardowns','hooks','keywords','lead_magnets','content',
    'scripts','media_assets','edit_jobs','posts','post_metrics','dm_automations','contacts','triage_items',
    'feature_stats','post_mortems','goals','agents','agent_runs','agent_events','approvals','messages','alert_log','brand_docs'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy member_all on %I for all using (aos_is_member(workspace_id)) with check (aos_is_member(workspace_id))', t);
  end loop;
end $$;
