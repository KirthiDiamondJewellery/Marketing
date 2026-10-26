-- research: trend radar alert bookkeeping (additive to schema v1).
-- alerted_*: when a trend was picked for a kit and how fast it was moving then, so a follow-up fires
-- once when velocity doubles. coverage: distinct sources carrying the same story in the last run.
alter table trends add column if not exists alerted_at timestamptz;
alter table trends add column if not exists alerted_velocity numeric;
alter table trends add column if not exists followed_up_at timestamptz;
alter table trends add column if not exists coverage int not null default 1;
alter table trends add column if not exists film_by timestamptz;
create index if not exists trends_alerted_idx on trends (workspace_id, alerted_at desc) where alerted_at is not null;

-- research: where a competitor post's transcription stands, so winners aren't queued twice.
alter table external_posts add column if not exists transcript_status text
  check (transcript_status in ('queued', 'done', 'failed', 'unavailable'));

-- research: media links from the scraper, needed to download winners for transcription and teardowns.
alter table external_posts add column if not exists video_url text;
alter table external_posts add column if not exists thumbnail_url text;

-- research: the source's own summary text for the trend writer. UNTRUSTED: tool-less LLM calls only.
alter table trends add column if not exists body text;
