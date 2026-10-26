import "server-only";
import type { AgentKey } from "@attentionos/core";
import { workspace } from "@/server/workspace";

export type RunSummary = {
  id: string;
  agent: string;
  jobId: string;
  trigger: string;
  status: string;
  summary: string | null;
  error: string | null;
  costUsd: number;
  turns: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string;
};

export type AgentProfile = {
  key: AgentKey;
  model: string | null;
  defaultModel: string | null;
  enabled: boolean;
  autonomy: "review_all" | "review_key" | "autopilot";
  runs: RunSummary[];
  stats: { runs7d: number; succeeded7d: number; failed7d: number; costUsd7d: number; lastRunAt: string | null };
  events: { id: number; ts: string; kind: string; message: string; runId: string | null }[];
};

export type RosterExtra = { key: string; model: string | null; lastRunAt: string | null; lastSummary: string | null; runs7d: number; costUsd7d: number };

type RunRow = {
  id: string; agent: string; job_id: string; trigger: string; status: string; output: Record<string, unknown> | null; error: string | null;
  cost_micro: string; turns: number; created_at: Date; started_at: Date | null; finished_at: Date | null; created_by: string;
};

export function toRunSummary(r: RunRow): RunSummary {
  const out = r.output && typeof r.output === "object" ? r.output : null;
  return {
    id: r.id,
    agent: r.agent,
    jobId: r.job_id,
    trigger: r.trigger,
    status: r.status,
    summary: out && typeof out.summary === "string" ? out.summary : null,
    error: r.error,
    costUsd: Number(r.cost_micro) / 1_000_000,
    turns: r.turns,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    createdBy: r.created_by,
  };
}

/** Per-agent extras the live snapshot doesn't carry: model, last result, 7-day totals. */
export async function getRosterExtras(): Promise<RosterExtra[]> {
  const ws = workspace();
  const sql = ws.sql;
  const rows = await sql<{ key: string; model: string | null }[]>`select key, model from agents where workspace_id = ${ws.id}`;
  const last = await sql<{ agent: string; ts: Date; output: Record<string, unknown> | null }[]>`
    select distinct on (agent) agent, coalesce(finished_at, created_at) as ts, output from agent_runs
     where workspace_id = ${ws.id} and status in ('succeeded', 'waiting_approval')
     order by agent, coalesce(finished_at, created_at) desc`;
  const week = await sql<{ agent: string; n: number; micro: string }[]>`
    select agent, count(*)::int as n, coalesce(sum(cost_micro), 0)::text as micro from agent_runs
     where workspace_id = ${ws.id} and created_at > now() - interval '7 days' group by agent`;
  const keys = new Set([...rows.map((r) => r.key), ...last.map((l) => l.agent), ...week.map((w) => w.agent)]);
  return [...keys].map((key) => {
    const l = last.find((x) => x.agent === key);
    const w = week.find((x) => x.agent === key);
    return {
      key,
      model: rows.find((r) => r.key === key)?.model ?? ws.config.agents?.[key as AgentKey]?.model ?? null,
      lastRunAt: l?.ts.toISOString() ?? null,
      lastSummary: l?.output && typeof l.output.summary === "string" ? l.output.summary : null,
      runs7d: w?.n ?? 0,
      costUsd7d: Number(w?.micro ?? 0) / 1_000_000,
    };
  });
}

export async function getAgentProfile(key: AgentKey): Promise<AgentProfile> {
  const ws = workspace();
  const sql = ws.sql;
  const [row] = await sql<{ model: string | null; enabled: boolean; autonomy: AgentProfile["autonomy"] }[]>`
    select model, enabled, autonomy from agents where workspace_id = ${ws.id} and key = ${key}`;
  const runs = await sql<RunRow[]>`
    select id, agent, job_id, trigger, status, output, error, cost_micro::text, turns, created_at, started_at, finished_at, created_by
      from agent_runs where workspace_id = ${ws.id} and agent = ${key}
     order by created_at desc limit 25`;
  const [stats] = await sql<{ n: number; ok: number; failed: number; micro: string; last: Date | null }[]>`
    select count(*)::int as n,
           count(*) filter (where status = 'succeeded')::int as ok,
           count(*) filter (where status = 'failed')::int as failed,
           coalesce(sum(cost_micro), 0)::text as micro,
           max(coalesce(finished_at, started_at, created_at)) as last
      from agent_runs where workspace_id = ${ws.id} and agent = ${key} and created_at > now() - interval '7 days'`;
  const events = await sql<{ id: string; ts: Date; kind: string; message: string; run_id: string | null }[]>`
    select id, ts, kind, message, run_id from agent_events where workspace_id = ${ws.id} and agent = ${key} order by id desc limit 30`;
  const cfg = ws.config.agents?.[key];
  return {
    key,
    model: row?.model ?? null,
    defaultModel: cfg?.model ?? null,
    enabled: row?.enabled ?? true,
    autonomy: row?.autonomy ?? cfg?.autonomy ?? "review_all",
    runs: runs.map(toRunSummary),
    stats: {
      runs7d: stats?.n ?? 0,
      succeeded7d: stats?.ok ?? 0,
      failed7d: stats?.failed ?? 0,
      costUsd7d: Number(stats?.micro ?? 0) / 1_000_000,
      lastRunAt: stats?.last?.toISOString() ?? null,
    },
    events: events.map((e) => ({ id: Number(e.id), ts: e.ts.toISOString(), kind: e.kind, message: e.message, runId: e.run_id })),
  };
}

/**
 * The worker room's feed walls. `cards`: the workspace's own best posts with their real view counts. Published posts
 * first (latest metrics, one card per piece of content, cover from its thumbnail asset), then the owner's own imported
 * posts from setup (scraped thumbnails). `rivals`: the tracked competitors' scraped posts, outliers first. Nothing here
 * is invented: no posts means blank phones.
 */
export type WallCard = { id: string; cover: string | null; views: number | null; title: string; platform: string; handle: string | null };
export type WallFeed = { cards: WallCard[]; handle: string | null; totalViews: number; totalPosts: number; rivals: WallCard[]; rivalCreators: number };

export async function getWallFeed(limit = 14): Promise<WallFeed> {
  const ws = workspace();
  const sql = ws.sql;
  const published = await sql<{ id: string; content_id: string | null; platform: string; title: string | null; caption: string | null; views: string | null; cover: string | null }[]>`
    select p.id, p.content_id, p.platform, c.title, p.caption, m.views::text as views,
           (select a.id::text from media_assets a
             where a.workspace_id = p.workspace_id and a.content_id = p.content_id and a.kind in ('thumbnail', 'image')
             order by a.created_at desc limit 1) as cover
      from posts p
      left join content c on c.id = p.content_id and c.workspace_id = p.workspace_id
      left join lateral (
        select pm.views from post_metrics pm where pm.workspace_id = p.workspace_id and pm.post_id = p.id
         order by pm.captured_at desc limit 1
      ) m on true
     where p.workspace_id = ${ws.id} and p.status = 'published'
     order by m.views desc nulls last, p.published_at desc nulls last
     limit 200`;
  const own = await sql<{ id: string; platform: string; caption: string | null; views: string | null; thumbnail_url: string | null; handle: string }[]>`
    select e.id, e.platform, e.caption, e.views::text as views, e.thumbnail_url, c.handle
      from external_posts e join tracked_creators c on c.id = e.tracked_creator_id
     where e.workspace_id = ${ws.id} and c.workspace_id = ${ws.id} and c.tier = 'own'
     order by e.views desc nulls last, e.published_at desc nulls last
     limit 60`;
  const rivals = await sql<{ id: string; platform: string; caption: string | null; views: string | null; thumbnail_url: string; handle: string }[]>`
    select e.id, e.platform, e.caption, e.views::text as views, e.thumbnail_url, c.handle
      from external_posts e join tracked_creators c on c.id = e.tracked_creator_id
     where e.workspace_id = ${ws.id} and c.workspace_id = ${ws.id} and c.tier <> 'own' and c.active
       and e.thumbnail_url ~* '^https://'
     order by e.is_outlier desc, e.x_score desc nulls last, e.views desc nulls last
     limit ${limit * 2}`;
  const [rivalCount] = await sql<{ creators: number }[]>`
    select count(distinct c.id)::int as creators
      from tracked_creators c
     where c.workspace_id = ${ws.id} and c.tier <> 'own' and c.active
       and exists (select 1 from external_posts e where e.workspace_id = ${ws.id} and e.tracked_creator_id = c.id)`;
  const [account] = await sql<{ handle: string }[]>`
    select handle from social_accounts where workspace_id = ${ws.id} and status = 'connected'
     order by (platform = 'instagram') desc, connected_at asc limit 1`;

  const cards: WallCard[] = [];
  const seenContent = new Set<string>();
  for (const p of published) {
    if (p.content_id) {
      if (seenContent.has(p.content_id)) continue;
      seenContent.add(p.content_id);
    }
    cards.push({
      id: p.id,
      cover: p.cover ? `/api/media/${p.cover}` : null,
      views: p.views === null ? null : Number(p.views),
      title: p.title ?? firstLine(p.caption) ?? "Your post",
      platform: p.platform,
      handle: null,
    });
  }
  for (const e of own) {
    cards.push({ id: e.id, cover: e.thumbnail_url && /^https:\/\//i.test(e.thumbnail_url) ? e.thumbnail_url : null, views: e.views === null ? null : Number(e.views), title: firstLine(e.caption) ?? "Your post", platform: e.platform, handle: null });
  }
  // Best first; prefer posts with a cover so the wall reads as real videos.
  cards.sort((a, b) => Number(!!b.cover) - Number(!!a.cover) || (b.views ?? -1) - (a.views ?? -1));
  const [totals] = await sql<{ posts: number; views: string }[]>`
    select count(*)::int as posts, coalesce(sum(m.views), 0)::text as views
      from posts p
      left join lateral (
        select pm.views from post_metrics pm where pm.workspace_id = p.workspace_id and pm.post_id = p.id
         order by pm.captured_at desc limit 1
      ) m on true
     where p.workspace_id = ${ws.id} and p.status = 'published'`;
  const ownViews = own.reduce((sum, e) => sum + Number(e.views ?? 0), 0);
  return {
    cards: cards.slice(0, limit),
    handle: account?.handle?.replace(/^@/, "") ?? own[0]?.handle?.replace(/^@/, "") ?? null,
    totalViews: Number(totals?.views ?? 0) + ownViews,
    totalPosts: (totals?.posts ?? 0) + own.length,
    rivals: rivals.map((r) => ({ id: r.id, cover: r.thumbnail_url, views: r.views === null ? null : Number(r.views), title: firstLine(r.caption) ?? `@${r.handle}`, platform: r.platform, handle: r.handle.replace(/^@/, "") })),
    rivalCreators: rivalCount?.creators ?? 0,
  };
}

function firstLine(text: string | null): string | null {
  const line = text?.split("\n").map((s) => s.trim()).find(Boolean);
  return line ? line.slice(0, 60) : null;
}
