import { microToUsd, type WorkspaceContext } from "@attentionos/core";
import { opsSettings } from "../settings.ts";
import { agentName } from "./approvals.ts";
import type { Alert, BriefData, FilmItem } from "./brief.ts";
import { dayLabel, localDayBounds, timeLabel } from "./time.ts";

/**
 * Loads everything the morning brief needs. Each part is independent: if one query fails (a table a newer
 * module adds, a provider that isn't set up), that part is left empty and the rest still renders.
 */

async function safe<T>(ws: WorkspaceContext, part: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    ws.log.warn("brief: part unavailable", { part, error: e instanceof Error ? e.message : String(e) });
    return fallback;
  }
}

/** "research.competitor-scan" → "competitor scan". */
export function jobLabel(jobId: string): string {
  const name = jobId.includes(".") ? jobId.slice(jobId.indexOf(".") + 1) : jobId;
  return name.replace(/[-_]+/g, " ");
}

export async function loadBriefData(ws: WorkspaceContext): Promise<BriefData> {
  const tz = ws.config.workspace.timezone;
  const now = ws.now();
  const today = localDayBounds(now, tz, 0);
  const yesterday = localDayBounds(now, tz, -1);
  const settings = opsSettings(ws.config);
  const sql = ws.sql;
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);

  const filmToday = safe(ws, "film today", async () => {
    const rows = await sql<{
      title: string; lane: string | null; funnel_stage: string | null; status: string; brief: Record<string, unknown> | null;
      film_by: Date | null; keyword: string | null;
    }[]>`
      select c.title, c.lane, c.funnel_stage, c.status, c.brief, c.film_by, k.word::text as keyword
        from content c
        left join keywords k on k.id = c.keyword_id and k.workspace_id = c.workspace_id
       where c.workspace_id = ${ws.id}
         and c.status in ('idea', 'scripted', 'filming')
         and (c.film_by < ${today.end} or (c.brief is not null and c.created_at >= ${dayAgo}))
       order by c.film_by asc nulls last, c.created_at desc
       limit 8`;
    return rows.map<FilmItem>((r) => {
      const b = r.brief ?? {};
      const filmBy = r.film_by ? new Date(r.film_by) : null;
      return {
        title: r.title,
        lane: r.lane,
        funnelStage: r.funnel_stage,
        status: r.status,
        header: typeof b.header === "string" ? b.header : null,
        why: typeof b.why === "string" ? b.why : null,
        keyword: r.keyword ? r.keyword.toUpperCase() : null,
        filmBy: filmBy ? `${filmBy < today.start ? dayLabel(filmBy, tz) : filmBy >= today.end ? dayLabel(filmBy, tz) : "today"} ${timeLabel(filmBy, tz)}` : null,
        overdue: filmBy ? filmBy < now : false,
      };
    });
  }, [] as FilmItem[]);

  const approvals = safe(ws, "approvals", async () => {
    const [rows, count] = await Promise.all([
      sql<{ ref: string; kind: string; agent: string; summary: string }[]>`
        select ref, kind, agent, summary from approvals
         where workspace_id = ${ws.id} and status = 'pending' order by requested_at asc limit ${settings.briefApprovals}`,
      sql<{ n: number }[]>`select count(*)::int as n from approvals where workspace_id = ${ws.id} and status = 'pending'`,
    ]);
    return { total: count[0]?.n ?? 0, items: rows.map((r) => ({ ...r, agent: agentName(r.agent) })) };
  }, { total: 0, items: [] });

  const scheduledToday = safe(ws, "scheduled", async () => {
    const rows = await sql<{ title: string | null; platform: string; scheduled_at: Date; status: string }[]>`
      select coalesce(c.title, left(p.caption, 60), 'Untitled post') as title, p.platform, p.scheduled_at, p.status
        from posts p left join content c on c.id = p.content_id and c.workspace_id = p.workspace_id
       where p.workspace_id = ${ws.id} and p.status in ('scheduled', 'queued', 'assist')
         and p.scheduled_at >= ${today.start} and p.scheduled_at < ${today.end}
       order by p.scheduled_at limit 12`;
    return rows.map((r) => ({ title: r.title ?? "Untitled post", platform: r.platform, at: timeLabel(new Date(r.scheduled_at), tz), assist: r.status === "assist" }));
  }, []);

  const results = safe(ws, "results", async () => {
    const latest = (from: Date, to: Date, limit: number, order: "published" | "x") => sql<{
      title: string | null; platform: string; url: string | null; views: string | null; x_score: string | null;
    }[]>`
      select coalesce(c.title, left(p.caption, 60), 'Untitled post') as title, p.platform, p.url, m.views, m.x_score
        from posts p
        left join content c on c.id = p.content_id and c.workspace_id = p.workspace_id
        left join lateral (
          select views, x_score from post_metrics pm where pm.post_id = p.id and pm.workspace_id = p.workspace_id
           order by captured_at desc limit 1
        ) m on true
       where p.workspace_id = ${ws.id} and p.status = 'published' and p.published_at >= ${from} and p.published_at < ${to}
       order by ${order === "x" ? sql`m.x_score desc nulls last` : sql`p.published_at asc`}
       limit ${limit}`;
    const toItem = (r: { title: string | null; platform: string; url: string | null; views: string | null; x_score: string | null }) => ({
      title: r.title ?? "Untitled post",
      platform: r.platform,
      url: r.url,
      views: r.views === null ? null : Number(r.views),
      xScore: r.x_score === null ? null : Number(r.x_score),
    });
    const [y, week, leads, hot] = await Promise.all([
      latest(yesterday.start, yesterday.end, 6, "published"),
      latest(weekAgo, now, 1, "x"),
      sql<{ n: number }[]>`select count(*)::int as n from contacts where workspace_id = ${ws.id} and created_at >= ${yesterday.start} and created_at < ${yesterday.end}`,
      sql<{ n: number }[]>`select count(*)::int as n from triage_items where workspace_id = ${ws.id} and temperature = 'hot' and status in ('new', 'drafted')`,
    ]);
    const best = week[0] ? toItem(week[0]) : null;
    return {
      yesterday: { published: y.map(toItem), leads: leads[0]?.n ?? 0, hotConversations: hot[0]?.n ?? 0 },
      breakout: best && typeof best.xScore === "number" && best.xScore >= 2 ? best : null,
    };
  }, { yesterday: { published: [], leads: 0, hotConversations: 0 }, breakout: null });

  const alerts = safe(ws, "alerts", async () => {
    const out: Alert[] = [];
    const [accounts, failedRuns, failedPosts] = await Promise.all([
      sql<{ platform: string; handle: string; status: string }[]>`
        select platform, handle, status from social_accounts where workspace_id = ${ws.id} and status in ('expired', 'error')`,
      sql<{ job_id: string; agent: string; n: number }[]>`
        select job_id, agent, count(*)::int as n from agent_runs
         where workspace_id = ${ws.id} and status = 'failed' and finished_at >= ${dayAgo}
         group by job_id, agent order by n desc limit 5`,
      sql<{ n: number }[]>`select count(*)::int as n from posts where workspace_id = ${ws.id} and status = 'failed' and updated_at >= ${dayAgo}`,
    ]);
    for (const a of accounts) out.push({ level: "danger", text: `${a.platform} account ${a.handle} is disconnected. Reconnect it to keep publishing.` });
    if (failedPosts[0]?.n) out.push({ level: "danger", text: `${failedPosts[0].n} post${failedPosts[0].n === 1 ? "" : "s"} failed to publish. Run /attention:publish to retry.` });
    for (const r of failedRuns) out.push({ level: "warning", text: `${agentName(r.agent)} couldn't finish the ${jobLabel(r.job_id)}${r.n > 1 ? ` (${r.n} tries)` : ""}.` });
    return out;
  }, [] as Alert[]);

  const spend = safe(ws, "spend", async () => {
    const rows = await sql<{ micro: string | null }[]>`
      select sum(amount_micro)::text as micro from cost_ledger where workspace_id = ${ws.id} and category = 'llm' and ts >= ${today.start}`;
    return { todayUsd: microToUsd(Number(rows[0]?.micro ?? 0)), dailyBudgetUsd: ws.config.budgets.dailyUsd };
  }, null);

  const [f, a, s, r, al, sp] = await Promise.all([filmToday, approvals, scheduledToday, results, alerts, spend]);
  return {
    date: today.date,
    dayLabel: dayLabel(now, tz),
    filmToday: f,
    approvals: a,
    scheduledToday: s,
    yesterday: r.yesterday,
    breakout: r.breakout,
    alerts: al,
    spend: sp,
  };
}
