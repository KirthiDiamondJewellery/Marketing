-- Publishing: lookups used by webhooks, the publish-due sweep and cross-posting.
create index if not exists posts_provider_post_idx on posts (workspace_id, provider, provider_post_id) where provider_post_id is not null;
create index if not exists posts_content_platform_idx on posts (workspace_id, content_id, platform) where content_id is not null;
create index if not exists posts_assist_due_idx on posts (workspace_id, scheduled_at) where status = 'assist';
