import "server-only";
import { workspace } from "@/server/workspace";

/** Read models for /research: outliers, the trend radar, tracked creators and teardowns. */

export type OutlierWindow = "7d" | "30d" | "90d";
export const OUTLIER_WINDOWS: OutlierWindow[] = ["7d", "30d", "90d"];
const WINDOW_DAYS: Record<OutlierWindow, number> = { "7d": 7, "30d": 30, "90d": 90 };

export type Outlier = {
  id: string;
  platform: string;
  author: string;
  tier: string | null;
  url: string;
  publishedAt: string | null;
  caption: string | null;
  spokenHook: string | null;
  thumbnailUrl: string | null;
  durationS: number | null;
  views: number | null;
  comments: number | null;
  xScore: number;
  xMethod: string | null;
  baselineViews: number | null;
  baselineComments: number | null;
  format: string | null;
  topComment: { text: string; likes: number } | null;
  /** Content rows already remixed from this post (from content.source_refs). */
  remixedAs: { id: string; title: string } | null;
};

type TopComment = { text?: unknown; likes?: unknown };

export async function getOutliers(opts: { platform?: string | null; window: OutlierWindow }): Promise<{ items: Outlier[]; platforms: { platform: string; n: number }[] }> {
  const ws = workspace();
  const days = WINDOW_DAYS[opts.window];
  const rows = await ws.sql<
    {
      id: string;
      platform: string;
      author_handle: string;
      tier: string | null;
      url: string;
      published_at: Date | null;
      caption: string | null;
      spoken_hook: string | null;
      thumbnail_url: string | null;
      duration_s: string | null;
      views: string | null;
      comments: string | null;
      x_score: string;
      x_detail: { method?: string; baseline?: { views?: number; comments?: number } } | null;
      tags: { format?: string } | null;
      top_comments: TopComment[] | null;
      remix_id: string | null;
      remix_title: string | null;
    }[]
  >`
    select e.id, e.platform, e.author_handle, tc.tier, e.url, e.published_at, e.caption, e.spoken_hook, e.thumbnail_url,
           e.duration_s::text, e.views::text, e.comments::text, e.x_score::text, e.x_detail, e.tags, e.top_comments,
           r.id as remix_id, r.title as remix_title
      from external_posts e
      left join tracked_creators tc on tc.id = e.tracked_creator_id
      left join lateral (
        select c.id, c.title from content c
         where c.workspace_id = e.workspace_id and c.status <> 'archived'
           and exists (select 1 from jsonb_array_elements(c.source_refs) s where s ->> 'type' = 'external_post' and s ->> 'id' = e.id::text)
         order by c.created_at desc limit 1
      ) r on true
     where e.workspace_id = ${ws.id} and e.is_outlier and not e.is_meme
       and coalesce(e.published_at, e.first_seen_at) > now() - make_interval(days => ${days})
       ${opts.platform ? ws.sql`and e.platform = ${opts.platform}` : ws.sql``}
     order by e.x_score desc nulls last
     limit 60`;
  const platforms = await ws.sql<{ platform: string; n: number }[]>`
    select platform, count(*)::int as n from external_posts
     where workspace_id = ${ws.id} and is_outlier and not is_meme
       and coalesce(published_at, first_seen_at) > now() - make_interval(days => ${days})
     group by platform order by n desc`;
  return {
    platforms,
    items: rows.map((r) => {
      const top = (Array.isArray(r.top_comments) ? r.top_comments : [])
        .map((c) => ({ text: String(c.text ?? ""), likes: Number(c.likes ?? 0) }))
        .filter((c) => c.text)
        .sort((a, b) => b.likes - a.likes)[0];
      return {
        id: r.id,
        platform: r.platform,
        author: r.author_handle,
        tier: r.tier,
        url: r.url,
        publishedAt: r.published_at?.toISOString() ?? null,
        caption: r.caption,
        spokenHook: r.spoken_hook,
        thumbnailUrl: r.thumbnail_url,
        durationS: r.duration_s ? Number(r.duration_s) : null,
        views: r.views ? Number(r.views) : null,
        comments: r.comments ? Number(r.comments) : null,
        xScore: Number(r.x_score),
        xMethod: r.x_detail?.method ?? null,
        baselineViews: r.x_detail?.baseline?.views ?? null,
        baselineComments: r.x_detail?.baseline?.comments ?? null,
        format: r.tags?.format ?? null,
        topComment: top ?? null,
        remixedAs: r.remix_id ? { id: r.remix_id, title: r.remix_title ?? "" } : null,
      };
    }),
  };
}

export type TrendKit = {
  header?: string;
  beats?: { text: string; visual?: string }[];
  caption?: string;
  keyword?: string;
  sources?: string[];
};

export type Trend = {
  id: string;
  title: string;
  url: string;
  source: string;
  author: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  heat: number | null;
  velocity: number | null;
  relevance: number | null;
  points: number | null;
  comments: number | null;
  coverage: number;
  status: string;
  kit: TrendKit | null;
  filmBy: string | null;
  /** Engagement (points + comments) over time, oldest first. */
  history: number[];
  /** Content made from this trend, if any. */
  content: { id: string; title: string; status: string } | null;
};

export async function getTrends(): Promise<Trend[]> {
  const ws = workspace();
  const rows = await ws.sql<
    {
      id: string;
      title: string;
      url: string;
      source_id: string;
      author: string | null;
      published_at: Date | null;
      first_seen_at: Date;
      heat: string | null;
      velocity: string | null;
      relevance: string | null;
      points: string | null;
      comments: string | null;
      coverage: number | null;
      status: string;
      story: TrendKit | null;
      film_by: Date | null;
      history: (string | number)[] | null;
      content_id: string | null;
      content_title: string | null;
      content_status: string | null;
    }[]
  >`
    select t.id, t.title, t.url, t.source_id, t.author, t.published_at, t.first_seen_at, t.heat::text, t.velocity::text,
           t.relevance::text, t.points::text, t.comments::text, t.coverage, t.status, t.story, t.film_by,
           (select array_agg(coalesce(s.points, 0) + coalesce(s.comments, 0) order by s.captured_at)
              from trend_snapshots s where s.trend_id = t.id and s.workspace_id = t.workspace_id) as history,
           c.id as content_id, c.title as content_title, c.status as content_status
      from trends t
      left join lateral (
        select c.id, c.title, c.status from content c
         where c.workspace_id = t.workspace_id
           and exists (select 1 from jsonb_array_elements(c.source_refs) s where s ->> 'type' = 'trend' and s ->> 'id' = t.id::text)
         order by c.created_at desc limit 1
      ) c on true
     where t.workspace_id = ${ws.id}
     order by case when t.status in ('kit', 'shortlisted', 'new') then 0 when t.status = 'used' then 1 when t.status = 'dismissed' then 2 else 3 end,
              t.heat desc nulls last
     limit 60`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    source: r.source_id,
    author: r.author,
    publishedAt: r.published_at?.toISOString() ?? null,
    firstSeenAt: r.first_seen_at.toISOString(),
    heat: r.heat != null ? Number(r.heat) : null,
    velocity: r.velocity != null ? Number(r.velocity) : null,
    relevance: r.relevance != null ? Number(r.relevance) : null,
    points: r.points != null ? Number(r.points) : null,
    comments: r.comments != null ? Number(r.comments) : null,
    coverage: r.coverage ?? 1,
    status: r.status,
    kit: r.story && (r.story.header || r.story.beats?.length) ? r.story : null,
    filmBy: r.film_by?.toISOString() ?? null,
    history: (r.history ?? []).map(Number),
    content: r.content_id ? { id: r.content_id, title: r.content_title ?? "", status: r.content_status ?? "idea" } : null,
  }));
}

export type Creator = {
  id: string;
  platform: string;
  handle: string;
  tier: string;
  active: boolean;
  notes: string | null;
  baselineViews: number | null;
  baselineComments: number | null;
  baselineN: number | null;
  lastScannedAt: string | null;
  posts30d: number;
  outliers30d: number;
  bestX: number | null;
};

export async function getCreators(): Promise<Creator[]> {
  const ws = workspace();
  const rows = await ws.sql<
    {
      id: string;
      platform: string;
      handle: string;
      tier: string;
      active: boolean;
      notes: string | null;
      baseline: { views?: number; comments?: number; n?: number } | null;
      last_scanned_at: Date | null;
      posts: number;
      outliers: number;
      best: string | null;
    }[]
  >`
    select tc.id, tc.platform, tc.handle, tc.tier, tc.active, tc.notes, tc.baseline, tc.last_scanned_at,
           count(e.id) filter (where coalesce(e.published_at, e.first_seen_at) > now() - interval '30 days')::int as posts,
           count(e.id) filter (where e.is_outlier and coalesce(e.published_at, e.first_seen_at) > now() - interval '30 days')::int as outliers,
           max(e.x_score)::text as best
      from tracked_creators tc
      left join external_posts e on e.tracked_creator_id = tc.id and e.workspace_id = tc.workspace_id
     where tc.workspace_id = ${ws.id} and tc.tier <> 'own'
     group by tc.id
     order by tc.active desc, case tc.tier when 'core' then 0 when 'adjacent' then 1 when 'aspirational' then 2 else 3 end, tc.handle`;
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    handle: r.handle,
    tier: r.tier,
    active: r.active,
    notes: r.notes,
    baselineViews: r.baseline?.views ?? null,
    baselineComments: r.baseline?.comments ?? null,
    baselineN: r.baseline?.n ?? null,
    lastScannedAt: r.last_scanned_at?.toISOString() ?? null,
    posts30d: r.posts,
    outliers30d: r.outliers,
    bestX: r.best != null ? Number(r.best) : null,
  }));
}

export type Teardown = {
  id: string;
  platform: string | null;
  author: string | null;
  url: string;
  analysisMd: string;
  fingerprint: Record<string, unknown> | null;
  createdAt: string;
  xScore: number | null;
  caption: string | null;
};

/** Not used yet: no Studio page calls this. Kept for a later release. */
export async function getTeardowns(): Promise<Teardown[]> {
  const ws = workspace();
  const rows = await ws.sql<
    { id: string; platform: string | null; author_handle: string | null; url: string; analysis_md: string; fingerprint: Record<string, unknown> | null; created_at: Date; x_score: string | null; caption: string | null }[]
  >`
    select t.id, t.platform, t.author_handle, t.url, t.analysis_md, t.fingerprint, t.created_at, e.x_score::text, e.caption
      from teardowns t left join external_posts e on e.id = t.external_post_id
     where t.workspace_id = ${ws.id}
     order by t.created_at desc limit 20`;
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    author: r.author_handle,
    url: r.url,
    analysisMd: r.analysis_md,
    fingerprint: r.fingerprint,
    createdAt: r.created_at.toISOString(),
    xScore: r.x_score != null ? Number(r.x_score) : null,
    caption: r.caption,
  }));
}

/** Not used yet: no Studio page calls this. Kept for a later release. */
export async function getResearchSummary(): Promise<{ outliers30d: number; hotTrends: number; creators: number; lastScanAt: string | null }> {
  const ws = workspace();
  const [r] = await ws.sql<{ outliers: number; trends: number; creators: number; last: Date | null }[]>`
    select
      (select count(*)::int from external_posts where workspace_id = ${ws.id} and is_outlier and coalesce(published_at, first_seen_at) > now() - interval '30 days') as outliers,
      (select count(*)::int from trends where workspace_id = ${ws.id} and status in ('new', 'shortlisted', 'kit') and heat >= 0.6) as trends,
      (select count(*)::int from tracked_creators where workspace_id = ${ws.id} and active and tier <> 'own') as creators,
      (select max(last_scanned_at) from tracked_creators where workspace_id = ${ws.id}) as last`;
  return { outliers30d: r?.outliers ?? 0, hotTrends: r?.trends ?? 0, creators: r?.creators ?? 0, lastScanAt: r?.last?.toISOString() ?? null };
}
