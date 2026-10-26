import type { TrendItem, WorkspaceContext } from "@attentionos/core";
import { jsonb } from "@attentionos/core";
import { count, iso, num } from "../lib/db.ts";

export const TREND_STATUSES = ["new", "shortlisted", "kit", "used", "dismissed", "expired"] as const;
export type TrendStatus = (typeof TREND_STATUSES)[number];

export type StoredTrend = {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  url: string;
  author: string | null;
  /** UNTRUSTED source text. */
  body: string | null;
  publishedAt: string | null;
  points: number | null;
  comments: number | null;
  velocity: number | null;
  heat: number | null;
  relevance: number | null;
  coverage: number;
  status: TrendStatus;
  story: Record<string, unknown> | null;
  alertedAt: string | null;
  alertedVelocity: number | null;
  followedUpAt: string | null;
  filmBy: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export const toTrend = (r: Record<string, unknown>): StoredTrend => ({
  id: r.id as string,
  sourceId: r.source_id as string,
  externalId: r.external_id as string,
  title: r.title as string,
  url: r.url as string,
  author: (r.author as string | null) ?? null,
  body: (r.body as string | null) ?? null,
  publishedAt: iso(r.published_at),
  points: num(r.points),
  comments: num(r.comments),
  velocity: num(r.velocity),
  heat: num(r.heat),
  relevance: num(r.relevance),
  coverage: num(r.coverage) ?? 1,
  status: r.status as TrendStatus,
  story: (r.story as Record<string, unknown> | null) ?? null,
  alertedAt: iso(r.alerted_at),
  alertedVelocity: num(r.alerted_velocity),
  followedUpAt: iso(r.followed_up_at),
  filmBy: iso(r.film_by),
  firstSeenAt: iso(r.first_seen_at),
  lastSeenAt: iso(r.last_seen_at),
});

export type PreviousSnapshot = { points: number | null; comments: number | null; capturedAt: Date };

/** Upserts a fetched item, returns the stored trend and the snapshot before this one (for velocity). */
export async function upsertTrendItem(ws: WorkspaceContext, item: TrendItem): Promise<{ trend: StoredTrend; previous: PreviousSnapshot | null; isNew: boolean }> {
  const now = ws.now();
  const [row] = await ws.sql`
    insert into trends (workspace_id, source_id, external_id, title, url, author, body, published_at, points, comments, first_seen_at, last_seen_at)
    values (${ws.id}, ${item.sourceId}, ${item.externalId}, ${item.title}, ${item.url}, ${item.author ?? null}, ${item.text?.slice(0, 4000) ?? null},
            ${item.publishedAt}, ${count(item.points)}, ${count(item.comments)}, ${now}, ${now})
    on conflict (workspace_id, source_id, external_id) do update set
      title = excluded.title, url = excluded.url, body = coalesce(excluded.body, trends.body), points = coalesce(excluded.points, trends.points),
      comments = coalesce(excluded.comments, trends.comments), last_seen_at = excluded.last_seen_at
    returning *, (xmax = 0) as inserted`;
  const trend = toTrend(row!);
  const [prev] = await ws.sql`
    select points, comments, captured_at from trend_snapshots
     where workspace_id = ${ws.id} and trend_id = ${trend.id} order by captured_at desc limit 1`;
  await ws.sql`
    insert into trend_snapshots (workspace_id, trend_id, captured_at, points, comments)
    values (${ws.id}, ${trend.id}, ${now}, ${count(item.points)}, ${count(item.comments)})`;
  return {
    trend,
    previous: prev ? { points: num(prev.points), comments: num(prev.comments), capturedAt: prev.captured_at as Date } : null,
    isNew: Boolean(row!.inserted),
  };
}

export async function saveHeat(ws: WorkspaceContext, id: string, h: { velocity: number; heat: number; relevance: number; coverage: number }): Promise<void> {
  await ws.sql`
    update trends set velocity = ${h.velocity}, heat = ${h.heat}, relevance = ${h.relevance}, coverage = ${h.coverage}
     where workspace_id = ${ws.id} and id = ${id}`;
}

export async function markAlerted(ws: WorkspaceContext, id: string, velocity: number, filmBy: Date): Promise<void> {
  await ws.sql`
    update trends set status = 'shortlisted', alerted_at = ${ws.now()}, alerted_velocity = ${velocity}, film_by = ${filmBy}
     where workspace_id = ${ws.id} and id = ${id}`;
}

export async function markFollowedUp(ws: WorkspaceContext, id: string): Promise<void> {
  await ws.sql`update trends set followed_up_at = ${ws.now()}, followup_at = ${ws.now()} where workspace_id = ${ws.id} and id = ${id}`;
}

export async function alertedSince(ws: WorkspaceContext, since: Date): Promise<number> {
  const [r] = await ws.sql`select count(*)::int as n from trends where workspace_id = ${ws.id} and alerted_at >= ${since}`;
  return num(r?.n) ?? 0;
}

export async function setTrendStatus(ws: WorkspaceContext, id: string, status: TrendStatus, patch: { story?: unknown } = {}): Promise<StoredTrend | null> {
  const [r] = await ws.sql`
    update trends set status = ${status} ${patch.story !== undefined ? ws.sql`, story = ${jsonb(ws.sql, patch.story)}` : ws.sql``}
     where workspace_id = ${ws.id} and id = ${id}
    returning *`;
  return r ? toTrend(r) : null;
}

export async function getTrend(ws: WorkspaceContext, id: string): Promise<StoredTrend | null> {
  const [r] = await ws.sql`select * from trends where workspace_id = ${ws.id} and id = ${id}`;
  return r ? toTrend(r) : null;
}

export async function listTrends(ws: WorkspaceContext, f: { status?: TrendStatus[]; minHeat?: number; sinceHours?: number; limit?: number } = {}): Promise<StoredTrend[]> {
  const since = new Date(ws.now().getTime() - (f.sinceHours ?? 72) * 3_600_000);
  const rows = await ws.sql`
    select * from trends
     where workspace_id = ${ws.id} and last_seen_at >= ${since}
       ${f.status?.length ? ws.sql`and status = any(${f.status}::text[])` : ws.sql`and status not in ('dismissed', 'expired')`}
       ${typeof f.minHeat === "number" ? ws.sql`and heat >= ${f.minHeat}` : ws.sql``}
     order by heat desc nulls last, last_seen_at desc
     limit ${f.limit ?? 20}`;
  return rows.map(toTrend);
}

/** Trends we already sent that may deserve a follow-up. */
export async function alertedOpenTrends(ws: WorkspaceContext, ids: string[]): Promise<StoredTrend[]> {
  if (ids.length === 0) return [];
  const rows = await ws.sql`
    select * from trends where workspace_id = ${ws.id} and id = any(${ids}::uuid[]) and alerted_at is not null and followed_up_at is null`;
  return rows.map(toTrend);
}

export async function expireStale(ws: WorkspaceContext, olderThanHours: number): Promise<number> {
  const rows = await ws.sql`
    update trends set status = 'expired'
     where workspace_id = ${ws.id} and status = 'new' and last_seen_at < ${new Date(ws.now().getTime() - olderThanHours * 3_600_000)}
    returning id`;
  return rows.length;
}

export async function trendCounts(ws: WorkspaceContext): Promise<Record<string, number>> {
  const rows = await ws.sql`
    select status, count(*)::int as n from trends
     where workspace_id = ${ws.id} and last_seen_at >= ${new Date(ws.now().getTime() - 7 * 86_400_000)} group by status`;
  return Object.fromEntries(rows.map((r) => [r.status as string, num(r.n) ?? 0]));
}
