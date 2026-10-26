import "server-only";
import { workspace } from "@/server/workspace";
import { getApprovalQueue, type ApprovalView } from "./approvals";

export type FilmItem = {
  id: string;
  title: string;
  header: string;
  why: string | null;
  directions: string[];
  deadline: string | null;
  filmBy: string | null;
  format: string;
  lane: string | null;
  keyword: string | null;
  hook: string | null;
  status: string;
};

export type ResultPost = {
  title: string;
  platform: string;
  views: number | null;
  follows: number | null;
  leads: number | null;
  xScore: number | null;
  publishedAt: string | null;
};

export type HomeAlert = { level: "danger" | "warning"; title: string; detail: string; href?: string; action?: string };

export type HomeData = {
  timezone: string;
  filmToday: FilmItem[];
  waiting: ApprovalView[];
  waitingTotal: number;
  results: {
    best: ResultPost | null;
    yesterday: { posts: number; views: number; follows: number; leads: number };
    week: { posts: number; views: number; follows: number; leads: number; spendUsd: number };
    spend: { todayUsd: number; dailyBudgetUsd: number };
  };
  alerts: HomeAlert[];
};

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.warn("[studio] home section unavailable:", e instanceof Error ? e.message : e);
    return fallback;
  }
}

const FORMAT_LABEL: Record<string, string> = { reel: "Reel", carousel: "Carousel", text: "Text post", longform: "Long video", story: "Story" };

export async function getHomeData(): Promise<HomeData> {
  const ws = workspace();
  const sql = ws.sql;
  const tz = ws.config.workspace.timezone;

  const filmToday = safe(async () => {
    const rows = await sql<{
      id: string; title: string; status: string; kind: string; template: string | null; lane: string | null;
      brief: Record<string, unknown> | null; film_by: Date | null; keyword: string | null; hook: string | null;
    }[]>`
      select c.id, c.title, c.status, c.kind, c.template, c.lane, c.brief, c.film_by, k.word::text as keyword,
             (select s.hook_text from scripts s where s.content_id = c.id order by s.version desc limit 1) as hook
        from content c
        left join keywords k on k.id = c.keyword_id and k.workspace_id = c.workspace_id
       where c.workspace_id = ${ws.id}
         and c.status in ('idea', 'scripted', 'filming')
         and c.brief is not null
         and (c.film_by < (date_trunc('day', now() at time zone ${tz}) + interval '2 days') at time zone ${tz}
              or c.created_at > now() - interval '1 day')
       order by c.film_by asc nulls last, c.created_at desc
       limit 6`;
    return rows.map<FilmItem>((r) => {
      const b = r.brief ?? {};
      const directions = Array.isArray(b.shoot_directions) ? b.shoot_directions.filter((x): x is string => typeof x === "string") : [];
      const keyword = r.keyword ?? (typeof b.keyword === "string" ? b.keyword : null);
      return {
        id: r.id,
        title: r.title,
        header: typeof b.header === "string" ? b.header : r.title,
        why: typeof b.why === "string" ? b.why : null,
        directions,
        deadline: typeof b.deadline_label === "string" ? b.deadline_label : null,
        filmBy: r.film_by?.toISOString() ?? null,
        format: [FORMAT_LABEL[r.kind] ?? r.kind, r.template?.replace(/[-_]+/g, " ")].filter(Boolean).join(" · "),
        lane: r.lane,
        keyword: keyword ? keyword.toUpperCase() : null,
        hook: r.hook,
        status: r.status,
      };
    });
  }, [] as FilmItem[]);

  const waiting = safe(() => getApprovalQueue({ status: "pending", limit: 3 }), { items: [] as ApprovalView[], total: 0 });

  const results = safe(async () => {
    type M = { title: string; platform: string; published_at: Date | null; views: string | null; follows: string | null; leads: number | null; x_score: string | null };
    const latest = (range: "yesterday" | "week") => sql<M[]>`
      select coalesce(c.title, left(p.caption, 60), 'Untitled post') as title, p.platform, p.published_at,
             m.views::text, m.follows::text, m.leads, m.x_score::text
        from posts p
        left join content c on c.id = p.content_id and c.workspace_id = p.workspace_id
        left join lateral (
          select views, follows, leads, x_score from post_metrics pm
           where pm.post_id = p.id and pm.workspace_id = p.workspace_id
           order by pm.captured_at desc,
                    case pm.snapshot when 'latest' then 0 when '30d' then 1 when '7d' then 2 when '72h' then 3 when '24h' then 4 else 5 end
           limit 1
        ) m on true
       where p.workspace_id = ${ws.id} and p.status = 'published'
         and ${range === "yesterday"
           ? sql`p.published_at >= ((date_trunc('day', now() at time zone ${tz}) - interval '1 day') at time zone ${tz})
                 and p.published_at < (date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`
           : sql`p.published_at > now() - interval '7 days'`}`;
    const [y, week, spendWeek, spendToday] = await Promise.all([
      latest("yesterday"),
      latest("week"),
      sql<{ micro: string }[]>`select coalesce(sum(amount_micro), 0)::text as micro from cost_ledger where workspace_id = ${ws.id} and ts > now() - interval '7 days'`,
      sql<{ micro: string }[]>`select coalesce(sum(amount_micro), 0)::text as micro from cost_ledger where workspace_id = ${ws.id} and category = 'llm' and ts >= (date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`,
    ]);
    const toPost = (r: M): ResultPost => ({
      title: r.title,
      platform: r.platform,
      views: r.views === null ? null : Number(r.views),
      follows: r.follows === null ? null : Number(r.follows),
      leads: r.leads,
      xScore: r.x_score === null ? null : Number(r.x_score),
      publishedAt: r.published_at?.toISOString() ?? null,
    });
    const sum = (rows: M[]) => ({
      posts: rows.length,
      views: rows.reduce((a, r) => a + Number(r.views ?? 0), 0),
      follows: rows.reduce((a, r) => a + Number(r.follows ?? 0), 0),
      leads: rows.reduce((a, r) => a + Number(r.leads ?? 0), 0),
    });
    const ranked = [...week].filter((r) => r.x_score !== null).sort((a, b) => Number(b.x_score) - Number(a.x_score));
    return {
      best: ranked[0] ? toPost(ranked[0]) : null,
      yesterday: sum(y),
      week: { ...sum(week), spendUsd: Number(spendWeek[0]?.micro ?? 0) / 1_000_000 },
      spend: { todayUsd: Number(spendToday[0]?.micro ?? 0) / 1_000_000, dailyBudgetUsd: ws.config.budgets.dailyUsd },
    };
  }, {
    best: null,
    yesterday: { posts: 0, views: 0, follows: 0, leads: 0 },
    week: { posts: 0, views: 0, follows: 0, leads: 0, spendUsd: 0 },
    spend: { todayUsd: 0, dailyBudgetUsd: ws.config.budgets.dailyUsd },
  });

  const alerts = safe(async () => {
    const out: HomeAlert[] = [];
    const [accounts, failedPosts, failedRuns] = await Promise.all([
      sql<{ platform: string; handle: string; status: string }[]>`
        select platform, handle, status from social_accounts where workspace_id = ${ws.id} and status in ('expired', 'error')`,
      sql<{ platform: string; title: string | null; error: string | null }[]>`
        select p.platform, c.title, p.error from posts p left join content c on c.id = p.content_id
         where p.workspace_id = ${ws.id} and p.status = 'failed' and p.updated_at > now() - interval '3 days'
         order by p.updated_at desc limit 3`,
      sql<{ agent: string; job_id: string; error: string | null; n: number }[]>`
        select agent, job_id, max(error) as error, count(*)::int as n from agent_runs
         where workspace_id = ${ws.id} and status = 'failed' and finished_at > now() - interval '24 hours'
         group by agent, job_id order by n desc limit 3`,
    ]);
    const platformName = (p: string) => ({ linkedin: "LinkedIn", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" })[p] ?? p;
    for (const a of accounts) {
      out.push({ level: "danger", title: `${platformName(a.platform)} disconnected`, detail: `${a.handle} needs to be reconnected before the Publisher can post there.`, href: "/settings", action: "Reconnect" });
    }
    for (const p of failedPosts) {
      out.push({ level: "danger", title: `A ${platformName(p.platform)} post didn't go out`, detail: `${p.title ?? "Untitled post"}${p.error ? `. ${p.error}` : ""}`, href: "/calendar", action: "Open calendar" });
    }
    const errorsShown = new Set(failedPosts.map((p) => p.error));
    for (const r of failedRuns) {
      if (r.error && errorsShown.has(r.error)) continue;
      out.push({ level: "warning", title: `${r.agent.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())} couldn't finish a task`, detail: r.error ?? "The last attempt failed.", href: "/activity?kind=error", action: "See what happened" });
    }
    const [spend] = await sql<{ micro: string }[]>`
      select coalesce(sum(amount_micro), 0)::text as micro from cost_ledger
       where workspace_id = ${ws.id} and category = 'llm' and ts >= (date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`;
    const today = Number(spend?.micro ?? 0) / 1_000_000;
    const budget = ws.config.budgets.dailyUsd;
    if (budget > 0 && today / budget >= 0.8) {
      out.push({ level: "warning", title: "Close to today's AI budget", detail: `$${today.toFixed(2)} of $${budget.toFixed(2)} spent. Agents pause AI work at the limit.`, href: "/settings", action: "Adjust budget" });
    }
    return out;
  }, [] as HomeAlert[]);

  const [f, w, r, a] = await Promise.all([filmToday, waiting, results, alerts]);
  return { timezone: tz, filmToday: f, waiting: w.items, waitingTotal: w.total, results: r, alerts: a };
}
