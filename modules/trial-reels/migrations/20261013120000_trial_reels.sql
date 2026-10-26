-- Trial reels: one row per day's batch of variations, and a ledger of what was sent for each variation.

-- A batch: the clean reels it was made from, the rendered and verified variations, and the owner's OK.
create table if not exists trial_reel_batches (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  ref             text not null,                 -- "tr-3"
  post_date       date not null,                 -- the local day the variations post
  status          text not null default 'queued' check (status in ('queued', 'rendering', 'ready', 'failed', 'scheduling', 'proving', 'scheduled', 'partial', 'cancelled')),
  total           int not null check (total between 1 and 50),
  sources         jsonb not null default '[]',   -- [{slug, kind: edit|upload, editRef, assetId, contentId, title, titles, captionLine, hashtags, layout, cta}]
  manifest        jsonb,                         -- rendered variations (+ media asset ids), timings
  verify          jsonb,                         -- {ok, count, failures, files}
  preview_asset_id uuid references media_assets(id) on delete set null,
  work_dir        text,
  progress        text,
  error           text,
  approval_ref    text,
  confirmed_by    text,
  confirmed_at    timestamptz,
  outcome         jsonb,                         -- what the last scheduling run did
  created_by      text not null default 'system',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, ref)
);
create index if not exists trial_reel_batches_ws_idx on trial_reel_batches (workspace_id, created_at desc);
create index if not exists trial_reel_batches_date_idx on trial_reel_batches (workspace_id, post_date);

-- The ledger: written BEFORE a variation is handed to the publisher ("sending") and again after. A re-run skips every
-- variation already in it, so nothing is ever posted twice; a "sending" row that never came back is shown, not resent.
create table if not exists trial_reel_posts (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  batch_id      uuid not null references trial_reel_batches(id) on delete cascade,
  variant_id    text not null,                   -- "tiles-03"
  post_id       uuid references posts(id) on delete set null,
  status        text not null default 'sending' check (status in ('sending', 'scheduled', 'published', 'failed', 'cancelled')),
  scheduled_at  timestamptz,                     -- null = posted right away (the one-time proof post)
  caption       text,
  message       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (batch_id, variant_id)
);
create index if not exists trial_reel_posts_ws_idx on trial_reel_posts (workspace_id, scheduled_at);
