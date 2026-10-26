import { goalPacing, localWeek, median, type GoalPace } from "@attentionos/scoring";
import { DAY_MS, num, type AnalyticsCtx } from "./analytics/ctx.ts";
import { funnelSources, loadFunnelEvents } from "./analytics/funnel.ts";
import { learnSettings } from "./settings.ts";

/**
 * North-star tracking: one configurable metric every agent judges against. Values are computed
 * from data the system actually has; when it can't measure the metric it says so with a GAP line.
 * Pacing compares this calendar week (local time) with the target and projects where the week will land.
 */

export type NorthStarReading = {
  metric: string;
  label: string;
  value: number | null;
  previous: number | null;
  target: number | null;
  /** Present when the metric can't be measured from the data available. */
  gap?: string;
};

export const NORTH_STAR_METRICS: Record<string, { label: string; kind: "sum" | "average"; direction: "up" | "down"; unit: "count" | "usd" | "rate" | "number" }> = {
  leads_per_week: { label: "Leads per week", kind: "sum", direction: "up", unit: "count" },
  booked_calls_per_week: { label: "Booked calls per week", kind: "sum", direction: "up", unit: "count" },
  revenue_per_week: { label: "Revenue per week", kind: "sum", direction: "up", unit: "usd" },
  follows_per_post: { label: "Follows per post", kind: "average", direction: "up", unit: "number" },
  skip_rate: { label: "Skip rate", kind: "average", direction: "down", unit: "rate" },
  new_followers_per_week: { label: "New followers per week", kind: "sum", direction: "up", unit: "count" },
  views_per_week: { label: "Views per week", kind: "sum", direction: "up", unit: "count" },
  posts_per_week: { label: "Posts per week", kind: "sum", direction: "up", unit: "count" },
};

const LABELS = Object.fromEntries(Object.entries(NORTH_STAR_METRICS).map(([k, v]) => [k, v.label]));

async function dedupedLeads(ctx: AnalyticsCtx, from: Date, to: Date): Promise<number> {
  const events = (await loadFunnelEvents(ctx, from, to)).filter((e) => e.kind === "lead");
  const seen = new Set<string>();
  let n = 0;
  for (const e of events) {
    const k = e.email?.toLowerCase();
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    n++;
  }
  return n;
}

/** Measures a metric over [from, to). Count metrics sum; per-post metrics take the median of each post's latest capture. */
export async function measure(ctx: AnalyticsCtx, metric: string, from: Date, to: Date): Promise<{ value: number | null; gap?: string }> {
  switch (metric) {
    case "leads_per_week":
      return { value: await dedupedLeads(ctx, from, to) };
    case "booked_calls_per_week":
    case "revenue_per_week": {
      const src = await funnelSources(ctx);
      const kind = metric === "booked_calls_per_week" ? "booking" : "sale";
      if ((kind === "booking" ? src.bookings : src.sales) === 0) {
        return {
          value: null,
          gap: kind === "booking"
            ? "GAP: no booking data is connected yet. Send booking events with utm_content to /webhooks/site to record calls per post."
            : "GAP: no revenue data is connected yet. Send sale events with utm_content to /webhooks/site to attribute revenue to posts.",
        };
      }
      const [r] = await ctx.sql`
        select count(*)::int as n, coalesce(sum(value_usd), 0)::float8 as usd from funnel_events
         where workspace_id = ${ctx.id} and kind = ${kind} and occurred_at >= ${from} and occurred_at < ${to}`;
      return { value: kind === "booking" ? Number(r?.n ?? 0) : Math.round(Number(r?.usd ?? 0) * 100) / 100 };
    }
    case "follows_per_post":
    case "skip_rate": {
      const col = metric === "skip_rate" ? ctx.sql`skip_rate` : ctx.sql`follows`;
      const rows = await ctx.sql`
        select distinct on (p.id) ${col} as v
          from posts p join post_metrics m on m.post_id = p.id and m.workspace_id = p.workspace_id
         where p.workspace_id = ${ctx.id} and p.status = 'published' and p.variant_of is null
           and p.published_at >= ${from} and p.published_at < ${to} and ${col} is not null
         order by p.id, m.captured_at desc`;
      const values = rows.map((r) => num(r.v)).filter((v): v is number => v !== null);
      if (values.length === 0) {
        return { value: null, gap: metric === "skip_rate" ? "GAP: no skip-rate numbers yet. Import them from a CSV export (Instagram doesn't expose skip rate by API)." : "GAP: the analytics provider hasn't reported follows per post yet." };
      }
      return { value: Math.round(median(values)! * 1000) / 1000 };
    }
    case "views_per_week":
    case "posts_per_week": {
      const [r] = await ctx.sql`
        select count(*)::int as posts, coalesce(sum(m.views), 0)::float8 as views
          from posts p left join lateral (
            select views from post_metrics pm where pm.post_id = p.id and pm.workspace_id = p.workspace_id order by pm.captured_at desc limit 1
          ) m on true
         where p.workspace_id = ${ctx.id} and p.status = 'published' and p.variant_of is null and p.published_at >= ${from} and p.published_at < ${to}`;
      return { value: metric === "posts_per_week" ? Number(r?.posts ?? 0) : Number(r?.views ?? 0) };
    }
    case "new_followers_per_week": {
      const rows = await ctx.sql`
        select social_account_id, min(followers) filter (where day = first_day) as first, max(followers) filter (where day = last_day) as last
          from (select *, min(day) over w as first_day, max(day) over w as last_day from account_snapshots
                 where workspace_id = ${ctx.id} and day >= ${from.toISOString().slice(0, 10)} and day < ${to.toISOString().slice(0, 10)} and followers is not null
                window w as (partition by social_account_id)) s
         group by social_account_id`;
      if (!rows.length) return { value: null, gap: "GAP: no follower history yet. It fills in daily from your analytics provider or a follower CSV." };
      return { value: rows.reduce((s, r) => s + (Number(r.last ?? 0) - Number(r.first ?? 0)), 0) };
    }
    default:
      return { value: null, gap: `GAP: "${metric}" isn't a metric AttentionOS can measure.` };
  }
}

/** Target for a metric: config wins for the north star, else the newest active goal row. */
export async function goalTarget(ctx: AnalyticsCtx, metric: string): Promise<number | null> {
  if (metric === ctx.config.northStar.metric && typeof ctx.config.northStar.target === "number") return ctx.config.northStar.target;
  const [goal] = await ctx.sql`select target from goals where workspace_id = ${ctx.id} and metric = ${metric} and active order by created_at desc limit 1`;
  return num(goal?.target);
}

/** Rolling 7 days vs the 7 before (what the weekly briefing reports). */
export async function northStar(ws: AnalyticsCtx, now = ws.now()): Promise<NorthStarReading> {
  const metric = ws.config.northStar.metric;
  const target = await goalTarget(ws, metric);
  const week = 7 * DAY_MS;
  const cur = await measure(ws, metric, new Date(now.getTime() - week), now);
  const prev = await measure(ws, metric, new Date(now.getTime() - 2 * week), new Date(now.getTime() - week));
  return { metric, label: LABELS[metric] ?? metric, value: cur.value, previous: prev.value, target, ...(cur.gap ? { gap: cur.gap } : {}) };
}

export type GoalPacing = {
  metric: string;
  label: string;
  unit: "count" | "usd" | "rate" | "number";
  direction: "up" | "down";
  isNorthStar: boolean;
  weekStart: string;
  weekEnd: string;
  pace: GoalPace;
  /** Cumulative value by local day this week (sum goals), for the pacing chart. */
  daily: { day: string; value: number | null }[];
  /** The same metric for each of the previous 8 calendar weeks, oldest first. */
  history: { weekStart: string; value: number | null }[];
  gap?: string;
};

/** Pacing for the north star and every other active goal, over the current local calendar week. */
export async function goalPacingReport(ctx: AnalyticsCtx, opts: { history?: number } = {}): Promise<GoalPacing[]> {
  const now = ctx.now();
  const tz = ctx.config.workspace.timezone;
  const { start, end } = localWeek(now, tz);
  const ns = ctx.config.northStar.metric;
  const goalRows = await ctx.sql`select distinct metric from goals where workspace_id = ${ctx.id} and active`;
  const metrics = [ns, ...goalRows.map((r) => r.metric as string).filter((m) => m !== ns && NORTH_STAR_METRICS[m])];
  const atRiskShare = learnSettings(ctx).pacing.atRiskShare;
  const out: GoalPacing[] = [];
  for (const metric of metrics) {
    const def = NORTH_STAR_METRICS[metric] ?? { label: metric, kind: "sum" as const, direction: "up" as const, unit: "count" as const };
    const target = await goalTarget(ctx, metric);
    const cur = await measure(ctx, metric, start, now);
    let trailing: number | null = null;
    if (def.kind === "sum") {
      const t = await measure(ctx, metric, new Date(start.getTime() - 28 * DAY_MS), start);
      trailing = t.value === null ? null : t.value / 28;
    }
    const pace = goalPacing({ target, kind: def.kind, direction: def.direction, periodStart: start, periodEnd: end, now, actual: cur.value, trailingDailyRate: trailing, atRiskShare });
    const daily: GoalPacing["daily"] = [];
    if (def.kind === "sum" && cur.value !== null) {
      for (let d = 1; d <= 7; d++) {
        const dayEnd = new Date(start.getTime() + d * DAY_MS);
        const capped = dayEnd > now ? now : dayEnd;
        const label = new Date(start.getTime() + (d - 1) * DAY_MS + 12 * 3_600_000).toISOString().slice(0, 10);
        daily.push({ day: label, value: dayEnd.getTime() - DAY_MS > now.getTime() ? null : (await measure(ctx, metric, start, capped)).value });
      }
    }
    const history: GoalPacing["history"] = [];
    for (let w = opts.history ?? 8; w >= 1; w--) {
      const ws = new Date(start.getTime() - w * 7 * DAY_MS);
      history.push({ weekStart: ws.toISOString(), value: (await measure(ctx, metric, ws, new Date(ws.getTime() + 7 * DAY_MS))).value });
    }
    out.push({
      metric, label: def.label, unit: def.unit, direction: def.direction, isNorthStar: metric === ns,
      weekStart: start.toISOString(), weekEnd: end.toISOString(), pace, daily, history, ...(cur.gap ? { gap: cur.gap } : {}),
    });
  }
  return out;
}
