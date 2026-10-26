import type { ExternalPost, Platform, WorkspaceContext } from "@attentionos/core";
import { jsonb } from "@attentionos/core";
import type { OutlierScore } from "@attentionos/scoring";
import { count, iso, num } from "../lib/db.ts";

export type StoredExternalPost = {
  id: string;
  trackedCreatorId: string | null;
  platform: Platform;
  platformPostId: string;
  authorHandle: string;
  url: string;
  publishedAt: string | null;
  caption: string | null;
  durationS: number | null;
  isPinned: boolean;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  xScore: number | null;
  xDetail: Record<string, unknown> | null;
  isOutlier: boolean;
  isMeme: boolean;
  transcript: string | null;
  spokenHook: string | null;
  transcriptStatus: string | null;
  tags: Record<string, unknown> | null;
  topComments: { text: string; likes?: number }[] | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  mediaPath: string | null;
  firstSeenAt: string | null;
};

export const toExternalPost = (r: Record<string, unknown>): StoredExternalPost => ({
  id: r.id as string,
  trackedCreatorId: (r.tracked_creator_id as string | null) ?? null,
  platform: r.platform as Platform,
  platformPostId: r.platform_post_id as string,
  authorHandle: r.author_handle as string,
  url: r.url as string,
  publishedAt: iso(r.published_at),
  caption: (r.caption as string | null) ?? null,
  durationS: num(r.duration_s),
  isPinned: Boolean(r.is_pinned),
  views: num(r.views),
  likes: num(r.likes),
  comments: num(r.comments),
  shares: num(r.shares),
  xScore: num(r.x_score),
  xDetail: (r.x_detail as Record<string, unknown> | null) ?? null,
  isOutlier: Boolean(r.is_outlier),
  isMeme: Boolean(r.is_meme),
  transcript: (r.transcript as string | null) ?? null,
  spokenHook: (r.spoken_hook as string | null) ?? null,
  transcriptStatus: (r.transcript_status as string | null) ?? null,
  tags: (r.tags as Record<string, unknown> | null) ?? null,
  topComments: (r.top_comments as { text: string; likes?: number }[] | null) ?? null,
  videoUrl: (r.video_url as string | null) ?? null,
  thumbnailUrl: (r.thumbnail_url as string | null) ?? null,
  mediaPath: (r.media_path as string | null) ?? null,
  firstSeenAt: iso(r.first_seen_at),
});

/** Upserts scraped posts and appends one metrics snapshot each. Returns stored ids with a "new" flag. */
export async function upsertExternalPosts(ws: WorkspaceContext, creatorId: string | null, posts: readonly ExternalPost[]): Promise<{ id: string; isNew: boolean }[]> {
  const out: { id: string; isNew: boolean }[] = [];
  const now = ws.now();
  for (const p of posts) {
    const [row] = await ws.sql`
      insert into external_posts (
        workspace_id, tracked_creator_id, platform, platform_post_id, author_handle, url, published_at, caption, duration_s,
        is_pinned, views, likes, comments, shares, top_comments, video_url, thumbnail_url, first_seen_at, last_updated_at)
      values (
        ${ws.id}, ${creatorId}, ${p.platform}, ${p.platformPostId}, ${p.authorHandle}, ${p.url}, ${p.publishedAt}, ${p.caption ?? null},
        ${p.durationS ?? null}, ${p.isPinned ?? false}, ${count(p.views)}, ${count(p.likes)}, ${count(p.comments)}, ${count(p.shares)},
        ${p.topComments?.length ? jsonb(ws.sql, p.topComments) : null}, ${p.videoUrl ?? null}, ${p.thumbnailUrl ?? null}, ${now}, ${now})
      on conflict (workspace_id, platform, platform_post_id) do update set
        tracked_creator_id = coalesce(excluded.tracked_creator_id, external_posts.tracked_creator_id),
        url = excluded.url,
        caption = coalesce(excluded.caption, external_posts.caption),
        duration_s = coalesce(excluded.duration_s, external_posts.duration_s),
        is_pinned = excluded.is_pinned,
        views = coalesce(excluded.views, external_posts.views),
        likes = coalesce(excluded.likes, external_posts.likes),
        comments = coalesce(excluded.comments, external_posts.comments),
        shares = coalesce(excluded.shares, external_posts.shares),
        top_comments = coalesce(excluded.top_comments, external_posts.top_comments),
        video_url = coalesce(excluded.video_url, external_posts.video_url),
        thumbnail_url = coalesce(excluded.thumbnail_url, external_posts.thumbnail_url),
        last_updated_at = excluded.last_updated_at
      returning id, (xmax = 0) as inserted`;
    const id = row!.id as string;
    await ws.sql`
      insert into external_post_snapshots (workspace_id, external_post_id, captured_at, views, likes, comments, shares)
      values (${ws.id}, ${id}, ${now}, ${count(p.views)}, ${count(p.likes)}, ${count(p.comments)}, ${count(p.shares)})`;
    out.push({ id, isNew: Boolean(row!.inserted) });
  }
  return out;
}

export async function listCreatorPosts(ws: WorkspaceContext, creatorId: string): Promise<StoredExternalPost[]> {
  const rows = await ws.sql`
    select * from external_posts where workspace_id = ${ws.id} and tracked_creator_id = ${creatorId}
     order by published_at desc nulls last`;
  return rows.map(toExternalPost);
}

export async function saveScore(ws: WorkspaceContext, id: string, score: OutlierScore, extra: Record<string, unknown> = {}): Promise<void> {
  const detail = { ratios: score.ratios, floorsMet: score.floorsMet, reason: score.reason, ...extra };
  await ws.sql`
    update external_posts
       set x_score = ${score.x}, x_detail = ${jsonb(ws.sql, detail)}, is_outlier = ${score.isOutlier}, is_meme = ${score.isMeme}
     where workspace_id = ${ws.id} and id = ${id}`;
}

export async function mergeXDetail(ws: WorkspaceContext, id: string, patch: Record<string, unknown>): Promise<void> {
  await ws.sql`
    update external_posts set x_detail = coalesce(x_detail, '{}'::jsonb) || ${jsonb(ws.sql, patch)}
     where workspace_id = ${ws.id} and id = ${id}`;
}

export type OutlierFilter = {
  platform?: Platform;
  creator?: string;
  sinceDays?: number;
  minX?: number;
  includeMemes?: boolean;
  onlyOutliers?: boolean;
  limit?: number;
};

export async function listOutliers(ws: WorkspaceContext, f: OutlierFilter = {}): Promise<StoredExternalPost[]> {
  const since = new Date(ws.now().getTime() - (f.sinceDays ?? 14) * 86_400_000);
  const rows = await ws.sql`
    select * from external_posts
     where workspace_id = ${ws.id}
       and published_at >= ${since}
       ${f.onlyOutliers === false ? ws.sql`` : ws.sql`and is_outlier`}
       ${f.includeMemes ? ws.sql`` : ws.sql`and not is_meme`}
       ${f.platform ? ws.sql`and platform = ${f.platform}` : ws.sql``}
       ${f.creator ? ws.sql`and lower(author_handle) = ${f.creator.replace(/^@/, "").toLowerCase()}` : ws.sql``}
       ${typeof f.minX === "number" ? ws.sql`and x_score >= ${f.minX}` : ws.sql``}
     order by x_score desc nulls last, published_at desc
     limit ${f.limit ?? 20}`;
  return rows.map(toExternalPost);
}

export async function getExternalPost(ws: WorkspaceContext, ref: { id?: string; url?: string }): Promise<StoredExternalPost | null> {
  if (ref.id) {
    const [r] = await ws.sql`select * from external_posts where workspace_id = ${ws.id} and id = ${ref.id}`;
    return r ? toExternalPost(r) : null;
  }
  if (ref.url) {
    const [r] = await ws.sql`select * from external_posts where workspace_id = ${ws.id} and url = ${ref.url} limit 1`;
    return r ? toExternalPost(r) : null;
  }
  return null;
}

export async function setTranscriptStatus(ws: WorkspaceContext, id: string, status: "queued" | "done" | "failed" | "unavailable"): Promise<void> {
  await ws.sql`update external_posts set transcript_status = ${status} where workspace_id = ${ws.id} and id = ${id}`;
}

export async function saveTranscript(ws: WorkspaceContext, id: string, t: { transcript: string; spokenHook: string; mediaPath?: string | null }): Promise<boolean> {
  const rows = await ws.sql`
    update external_posts
       set transcript = ${t.transcript}, spoken_hook = ${t.spokenHook}, transcript_status = 'done',
           media_path = coalesce(${t.mediaPath ?? null}, media_path), last_updated_at = ${ws.now()}
     where workspace_id = ${ws.id} and id = ${id}
    returning id`;
  return rows.length > 0;
}

export async function outlierCount(ws: WorkspaceContext, days: number): Promise<number> {
  const [r] = await ws.sql`
    select count(*)::int as n from external_posts
     where workspace_id = ${ws.id} and is_outlier and published_at >= ${new Date(ws.now().getTime() - days * 86_400_000)}`;
  return num(r?.n) ?? 0;
}
