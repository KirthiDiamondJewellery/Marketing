-- learn: analytics additions (additive to schema v1).

-- Feature attribution per outcome metric: "x" (vs your normal, the default every reader already uses),
-- "send_rate" ((shares + saves) / views) and "follows_per_1k". One row per metric, window, dimension and value.
alter table feature_stats add column if not exists metric text not null default 'x';
alter table feature_stats drop constraint if exists feature_stats_workspace_id_dimension_value_time_window_key;
create unique index if not exists feature_stats_metric_uidx on feature_stats (workspace_id, metric, time_window, dimension, value);

-- Follower history: one row per connected account per local day (from the analytics provider or a CSV export).
create table if not exists account_snapshots (
  id                 bigint generated always as identity primary key,
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  social_account_id  uuid not null references social_accounts(id) on delete cascade,
  day                date not null,
  captured_at        timestamptz not null default now(),
  followers          bigint,
  following          bigint,
  posts_count        int,
  source             text not null default 'provider',
  raw                jsonb,
  unique (workspace_id, social_account_id, day)
);
create index if not exists account_snapshots_day_idx on account_snapshots (workspace_id, day desc);
alter table account_snapshots enable row level security;
create policy member_all on account_snapshots for all using (aos_is_member(workspace_id)) with check (aos_is_member(workspace_id));

-- Business funnel events from the user's website (webhook or CSV), keyed on utm_content:
-- post → clicks → leads → bookings → revenue. post_id is resolved from utm_content when the event arrives.
create table if not exists funnel_events (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  occurred_at    timestamptz not null,
  kind           text not null check (kind in ('click', 'lead', 'booking', 'sale')),
  utm_content    text,
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  post_id        uuid references posts(id) on delete set null,
  visitor_id     text,
  email          citext,
  value_usd      numeric,
  external_id    text,
  source         text not null default 'webhook' check (source in ('webhook', 'csv', 'manual', 'agent')),
  raw            jsonb,
  created_at     timestamptz not null default now()
);
create unique index if not exists funnel_events_external_uidx on funnel_events (workspace_id, source, external_id) where external_id is not null;
create index if not exists funnel_events_time_idx on funnel_events (workspace_id, occurred_at desc);
create index if not exists funnel_events_utm_idx on funnel_events (workspace_id, lower(utm_content)) where utm_content is not null;
alter table funnel_events enable row level security;
create policy member_all on funnel_events for all using (aos_is_member(workspace_id)) with check (aos_is_member(workspace_id));

create index if not exists contacts_utm_idx on contacts (workspace_id, lower(utm_content)) where utm_content is not null;
