import "server-only";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { workspace } from "@/server/workspace";

/** True when a media asset's file is on disk, so pages never point at a missing image or video. */
export function mediaOnDisk(uri: string | null | undefined): boolean {
  if (!uri || /^[a-z]+:\/\//i.test(uri)) return false;
  try {
    return existsSync(isAbsolute(uri) ? uri : resolve(workspace().root, uri));
  } catch {
    return false;
  }
}

export type PostMetricsLite = {
  snapshot: string;
  capturedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  follows: number | null;
  leads: number | null;
  completion: number | null;
  x: number | null;
};

export type CalendarPost = {
  id: string;
  contentId: string | null;
  title: string | null;
  contentStatus: string | null;
  kind: string | null;
  platform: string;
  status: string;
  at: string;
  caption: string | null;
  url: string | null;
  error: string | null;
  utm: string | null;
  thumbId: string | null;
  metrics: PostMetricsLite | null;
  /** An Instagram trial reel (shown to non-followers first, never on the grid). */
  trial: boolean;
  /** A live trial reel on an account whose first trial reel still needs the owner's "it stayed off my grid" check. */
  trialProofNeeded: boolean;
};

type Row = {
  id: string;
  content_id: string | null;
  title: string | null;
  content_status: string | null;
  kind: string | null;
  platform: string;
  status: string;
  at: Date;
  caption: string | null;
  url: string | null;
  error: string | null;
  utm_content: string | null;
  thumb_id: string | null;
  thumb_uri: string | null;
  is_trial: boolean;
  proof_needed: boolean;
  m_snapshot: string | null;
  m_captured: Date | null;
  views: string | null;
  likes: string | null;
  comments: string | null;
  shares: string | null;
  saves: string | null;
  follows: string | null;
  leads: number | null;
  completion_rate: string | null;
  x_score: string | null;
};

const n = (v: string | number | null) => (v === null ? null : Number(v));

export function toMetrics(r: Pick<Row, "m_snapshot" | "m_captured" | "views" | "likes" | "comments" | "shares" | "saves" | "follows" | "leads" | "completion_rate" | "x_score">): PostMetricsLite | null {
  if (!r.m_snapshot || !r.m_captured) return null;
  return {
    snapshot: r.m_snapshot,
    capturedAt: r.m_captured.toISOString(),
    views: n(r.views),
    likes: n(r.likes),
    comments: n(r.comments),
    shares: n(r.shares),
    saves: n(r.saves),
    follows: n(r.follows),
    leads: n(r.leads),
    completion: n(r.completion_rate),
    x: n(r.x_score),
  };
}

/** Every post with a date in [from, to), with its content, cover frame and latest metrics snapshot. */
export async function calendarPosts(from: Date, to: Date): Promise<CalendarPost[]> {
  const ws = workspace();
  const rows = await ws.sql<Row[]>`
    select p.id, p.content_id, c.title, c.status as content_status, c.kind, p.platform, p.status,
           coalesce(p.published_at, p.scheduled_at) as at, p.caption, p.url, p.error, p.utm_content,
           th.id as thumb_id, th.uri as thumb_uri, p.is_trial,
           (p.is_trial and not exists (
              select 1 from social_accounts sa join settings st on st.workspace_id = sa.workspace_id and st.key = 'publishing.trial_reels.proof:' || sa.provider_account_id
               where sa.id = p.social_account_id)) as proof_needed,
           m.snapshot as m_snapshot, m.captured_at as m_captured, m.views::text, m.likes::text, m.comments::text, m.shares::text,
           m.saves::text, m.follows::text, m.leads, m.completion_rate::text, m.x_score::text
      from posts p
      left join content c on c.id = p.content_id and c.workspace_id = p.workspace_id
      left join lateral (
        select a.id, a.uri from media_assets a
         where a.workspace_id = p.workspace_id and a.content_id = p.content_id and a.kind in ('thumbnail', 'image')
         order by a.created_at desc limit 1
      ) th on true
      left join lateral (
        select * from post_metrics pm where pm.workspace_id = p.workspace_id and pm.post_id = p.id order by pm.captured_at desc limit 1
      ) m on true
     where p.workspace_id = ${ws.id}
       and p.status <> 'cancelled'
       and coalesce(p.published_at, p.scheduled_at) >= ${from}
       and coalesce(p.published_at, p.scheduled_at) < ${to}
     order by at asc, p.platform asc`;
  return rows.map((r) => ({
    id: r.id,
    contentId: r.content_id,
    title: r.title,
    contentStatus: r.content_status,
    kind: r.kind,
    platform: r.platform,
    status: r.status,
    at: r.at.toISOString(),
    caption: r.caption,
    url: r.url,
    error: r.error,
    utm: r.utm_content,
    thumbId: mediaOnDisk(r.thumb_uri) ? r.thumb_id : null,
    metrics: toMetrics(r),
    trial: r.is_trial,
    trialProofNeeded: r.is_trial && r.proof_needed && r.status === "published",
  }));
}

/** Posts with no date yet (drafts waiting for a slot). */
export async function unscheduledCount(): Promise<number> {
  const ws = workspace();
  const [row] = await ws.sql<{ n: number }[]>`
    select count(*)::int as n from posts where workspace_id = ${ws.id} and status in ('draft', 'queued') and scheduled_at is null`;
  return row?.n ?? 0;
}

/** Platforms that have at least one post (the calendar's filter chips). */
export async function postPlatforms(): Promise<string[]> {
  const ws = workspace();
  const rows = await ws.sql<{ platform: string }[]>`
    select distinct platform from posts where workspace_id = ${ws.id} and status <> 'cancelled' order by platform`;
  return rows.map((r) => r.platform);
}

/** Posts still going out in [from, to): scheduled, waiting to be sent, waiting for an OK or for you to post by hand. */
export async function scheduledCount(from: Date, to: Date): Promise<number> {
  const ws = workspace();
  const [row] = await ws.sql<{ n: number }[]>`
    select count(*)::int as n from posts
     where workspace_id = ${ws.id} and status in ('draft', 'queued', 'scheduled', 'publishing', 'assist')
       and scheduled_at >= ${from} and scheduled_at < ${to}`;
  return row?.n ?? 0;
}

export type ReadyVideo = {
  id: string;
  editRef: string;
  contentId: string | null;
  title: string;
  status: "ready" | "failed";
  platforms: string[];
  /** Plain-language reasons the last try didn't schedule ("Couldn't schedule on TikTok: ..."). */
  problems: string[];
  videoId: string | null;
  coverId: string | null;
  durationS: number | null;
  since: string;
};

type ReadyRow = {
  id: string;
  status: "ready" | "failed";
  slots: { platform: string }[] | null;
  outcomes: { platform: string; outcome: string; message: string }[] | null;
  since: Date;
  ref: string;
  content_id: string | null;
  title: string | null;
  video_id: string | null;
  video_uri: string | null;
  duration_s: string | null;
  cover_id: string | null;
  cover_uri: string | null;
};

const PLATFORM_NAMES: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", x: "X", threads: "Threads" };
const BAD = new Set(["invalid", "failed", "rejected"]);

/**
 * Approved videos waiting under "Ready to post": releases parked as ready, plus ones whose scheduling failed so they
 * can be retried. Only the current version of each edit counts.
 */
export async function readyVideos(): Promise<ReadyVideo[]> {
  const ws = workspace();
  const rows = await ws.sql<ReadyRow[]>`
    select r.id, r.status, r.slots, r.outcomes, coalesce(r.approved_at, r.updated_at) as since, e.ref, r.content_id,
           c.title, v.id as video_id, v.uri as video_uri, v.duration_s::text, th.id as cover_id, th.uri as cover_uri
      from production_releases r
      join edit_jobs e on e.id = r.edit_job_id and e.workspace_id = r.workspace_id
      left join content c on c.id = r.content_id and c.workspace_id = r.workspace_id
      left join media_assets v on v.id = e.output_asset_id and v.workspace_id = r.workspace_id
      left join lateral (
        select a.id, a.uri from media_assets a
         where a.workspace_id = r.workspace_id and a.content_id = r.content_id and a.kind in ('thumbnail', 'image')
         order by a.created_at desc limit 1
      ) th on true
     where r.workspace_id = ${ws.id} and r.status in ('ready', 'failed') and r.version = e.version and e.status <> 'cancelled'
     order by (r.status = 'failed') desc, since desc`;
  return rows.map((r) => {
    const bad = (r.outcomes ?? []).filter((o) => BAD.has(o.outcome));
    const problems =
      r.status === "failed"
        ? bad.length
          ? bad.map((o) => `Couldn't schedule on ${PLATFORM_NAMES[o.platform] ?? o.platform}: ${(o.message ?? "").split("\n")[0]}`)
          : ["Couldn't schedule it last time. Try again."]
        : [];
    return {
      id: r.id,
      editRef: r.ref,
      contentId: r.content_id,
      title: r.title ?? "Untitled video",
      status: r.status,
      platforms: [...new Set((r.slots ?? []).map((s) => s.platform))],
      problems,
      videoId: mediaOnDisk(r.video_uri) ? r.video_id : null,
      coverId: mediaOnDisk(r.cover_uri) ? r.cover_id : null,
      durationS: r.duration_s === null ? null : Number(r.duration_s),
      since: r.since.toISOString(),
    };
  });
}
