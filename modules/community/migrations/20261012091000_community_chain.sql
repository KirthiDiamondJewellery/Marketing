-- Community: lead magnet registry details, the comment reply bank, and lookups for triage and leads.

alter table lead_magnets add column if not exists slug text;
alter table lead_magnets add column if not exists email_gate boolean not null default true;
alter table lead_magnets add column if not exists status text not null default 'live' check (status in ('draft', 'live', 'retired'));
-- One guide per keyword.
create unique index if not exists lead_magnets_keyword_uidx on lead_magnets (workspace_id, keyword_id) where keyword_id is not null;

-- Rotating public comment replies (drafts only; a person approves before anything is sent).
create table if not exists reply_bank (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  kind          text not null default 'comment' check (kind in ('comment', 'dm')),
  text          text not null,
  uses          int not null default 0,
  last_used_at  timestamptz,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (workspace_id, kind, text)
);
alter table reply_bank enable row level security;
create policy member_all on reply_bank for all using (aos_is_member(workspace_id)) with check (aos_is_member(workspace_id));

create index if not exists triage_items_queue_idx on triage_items (workspace_id, status, temperature, received_at desc);
create index if not exists contacts_handle_idx on contacts (workspace_id, platform, lower(handle)) where handle is not null;
create index if not exists dm_automations_status_idx on dm_automations (workspace_id, status);
