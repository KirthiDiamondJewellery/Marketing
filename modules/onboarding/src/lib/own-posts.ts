import type { ExternalPost, Platform, PostMetricsSnapshot, Sql, WorkspaceContext } from "@attentionos/core";
import { bareHandle } from "./handles.ts";

/**
 * The owner's own posts, as setup imports them: stored in `external_posts` under a `tracked_creators` row with tier
 * `own` (research never scans or scores that tier, and `syncTrackedCreators` leaves it alone). Transcripts arrive
 * through the research → editing hand-off and land on the same rows, which is where the voice profile reads them.
 */

/** How many recent posts to pull per handle, and how many of the best to transcribe. */
export const OWN_POST_LIMIT = 30;
export const OWN_TRANSCRIBE_LIMIT = 15;
/** Posts the voice profile reads (transcripts first, then captions). */
export const VOICE_POST_LIMIT = 25;

const VIDEO_PLATFORMS = new Set<Platform>(["instagram", "tiktok", "youtube"]);

export type OwnPostRow = {
  id: string;
  platform: Platform;
  url: string;
  views: number | null;
  publishedAt: string | null;
  videoUrl: string | null;
  durationS: number | null;
  transcript: string | null;
  transcriptStatus: string | null;
};

/**
 * Which own posts to transcribe: videos without a transcript (or a pending one), best first by views, then newest.
 * A post with a direct media link counts; so does a post on a video platform when the scraper can download it.
 */
export function pickForTranscription(posts: OwnPostRow[], n = OWN_TRANSCRIBE_LIMIT, opts: { canDownload?: boolean } = {}): OwnPostRow[] {
  const canDownload = opts.canDownload ?? true;
  return posts
    .filter((p) => !p.transcript && !p.transcriptStatus && (p.videoUrl || (canDownload && VIDEO_PLATFORMS.has(p.platform))) && (p.durationS === null || p.durationS > 3))
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, n);
}

/** An analytics snapshot of the owner's own post (publishing service) in the scraper's shape. */
export function externalFromSnapshot(s: PostMetricsSnapshot, handle: string): ExternalPost | null {
  if (!s.platformPostId || !s.url) return null;
  return {
    platform: s.platform,
    platformPostId: s.platformPostId,
    authorHandle: bareHandle(handle),
    url: s.url,
    publishedAt: s.publishedAt ?? s.capturedAt,
    ...(s.caption ? { caption: s.caption } : {}),
    ...(typeof s.durationS === "number" ? { durationS: s.durationS } : {}),
    ...(typeof s.views === "number" ? { views: s.views } : {}),
    ...(typeof s.likes === "number" ? { likes: s.likes } : {}),
    ...(typeof s.comments === "number" ? { comments: s.comments } : {}),
    ...(typeof s.shares === "number" ? { shares: s.shares } : {}),
  };
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const count = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** The `own` tracked_creators row for one of the owner's handles (created on first use). */
export async function ensureOwnCreator(ws: Pick<WorkspaceContext, "sql" | "id">, platform: Platform, handle: string): Promise<string> {
  const [row] = await ws.sql<{ id: string }[]>`
    insert into tracked_creators (workspace_id, platform, handle, tier, active, notes)
    values (${ws.id}, ${platform}, ${bareHandle(handle)}, 'own', true, 'Your own account (added by setup)')
    on conflict (workspace_id, platform, handle) do update set tier = 'own', active = true
    returning id`;
  return row!.id;
}

/** Upserts the owner's posts under their own creator row. Returns how many were new. */
export async function upsertOwnPosts(ws: Pick<WorkspaceContext, "sql" | "id" | "now">, creatorId: string, posts: readonly ExternalPost[]): Promise<{ stored: number; added: number }> {
  let added = 0;
  const now = ws.now();
  for (const p of posts) {
    const [row] = await ws.sql<{ inserted: boolean }[]>`
      insert into external_posts (
        workspace_id, tracked_creator_id, platform, platform_post_id, author_handle, url, published_at, caption, duration_s,
        is_pinned, views, likes, comments, shares, video_url, thumbnail_url, first_seen_at, last_updated_at)
      values (
        ${ws.id}, ${creatorId}, ${p.platform}, ${p.platformPostId}, ${p.authorHandle}, ${p.url}, ${p.publishedAt}, ${p.caption ?? null},
        ${p.durationS ?? null}, ${p.isPinned ?? false}, ${count(p.views)}, ${count(p.likes)}, ${count(p.comments)}, ${count(p.shares)},
        ${p.videoUrl ?? null}, ${p.thumbnailUrl ?? null}, ${now}, ${now})
      on conflict (workspace_id, platform, platform_post_id) do update set
        tracked_creator_id = excluded.tracked_creator_id,
        url = excluded.url,
        caption = coalesce(excluded.caption, external_posts.caption),
        duration_s = coalesce(excluded.duration_s, external_posts.duration_s),
        views = coalesce(excluded.views, external_posts.views),
        likes = coalesce(excluded.likes, external_posts.likes),
        comments = coalesce(excluded.comments, external_posts.comments),
        shares = coalesce(excluded.shares, external_posts.shares),
        video_url = coalesce(excluded.video_url, external_posts.video_url),
        thumbnail_url = coalesce(excluded.thumbnail_url, external_posts.thumbnail_url),
        last_updated_at = excluded.last_updated_at
      returning (xmax = 0) as inserted`;
    if (row?.inserted) added++;
  }
  return { stored: posts.length, added };
}

export async function listOwnPosts(sql: Sql, workspaceId: string): Promise<OwnPostRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select p.id, p.platform, p.url, p.views, p.published_at, p.video_url, p.duration_s, p.transcript, p.transcript_status
      from external_posts p join tracked_creators c on c.id = p.tracked_creator_id
     where p.workspace_id = ${workspaceId} and c.workspace_id = ${workspaceId} and c.tier = 'own'
     order by p.published_at desc nulls last
     limit 500`;
  return rows.map((r) => ({
    id: r.id as string,
    platform: r.platform as Platform,
    url: r.url as string,
    views: n(r.views),
    publishedAt: r.published_at instanceof Date ? r.published_at.toISOString() : ((r.published_at as string | null) ?? null),
    videoUrl: (r.video_url as string | null) ?? null,
    durationS: n(r.duration_s),
    transcript: (r.transcript as string | null) ?? null,
    transcriptStatus: (r.transcript_status as string | null) ?? null,
  }));
}

export async function markTranscriptQueued(sql: Sql, workspaceId: string, id: string): Promise<void> {
  await sql`update external_posts set transcript_status = 'queued' where workspace_id = ${workspaceId} and id = ${id}`;
}

/** Own posts still waiting for a transcript. */
export async function pendingOwnTranscripts(sql: Sql, workspaceId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from external_posts p join tracked_creators c on c.id = p.tracked_creator_id
     where p.workspace_id = ${workspaceId} and c.tier = 'own' and p.transcript_status = 'queued'`;
  return r?.n ?? 0;
}

export type VoiceSourcePost = { platform: Platform; text: string; kind: "transcript" | "caption" };

/**
 * What the voice profile learns from: each own post's transcript plus its caption (transcripts first, then the
 * best-performing captions). Text is the owner's own, but it came from a download, so it's still fenced as untrusted.
 */
export async function voiceSourcePosts(sql: Sql, workspaceId: string, limit = VOICE_POST_LIMIT): Promise<VoiceSourcePost[]> {
  const rows = await sql<{ platform: Platform; transcript: string | null; caption: string | null }[]>`
    select p.platform, p.transcript, p.caption
      from external_posts p join tracked_creators c on c.id = p.tracked_creator_id
     where p.workspace_id = ${workspaceId} and c.tier = 'own'
       and (length(coalesce(p.transcript, '')) >= 40 or length(coalesce(p.caption, '')) >= 40)
     order by (p.transcript is not null and length(p.transcript) >= 40) desc, p.views desc nulls last, p.published_at desc nulls last
     limit ${limit}`;
  return rows.map((r) => {
    const t = (r.transcript ?? "").trim();
    const c = (r.caption ?? "").trim();
    return t.length >= 40
      ? { platform: r.platform, kind: "transcript" as const, text: c.length >= 40 ? `${t}\n\nCaption: ${c}` : t }
      : { platform: r.platform, kind: "caption" as const, text: c };
  });
}
