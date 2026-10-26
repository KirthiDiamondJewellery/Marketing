import { z } from "zod";
import {
  attributeFunnel, biggestDrop, emptyCounts, funnelSteps, utmResolver,
  type FunnelCounts, type FunnelEvent, type FunnelPostKey, type FunnelStep,
} from "@attentionos/scoring";
import { DAY_MS, iso, num, type AnalyticsCtx } from "./ctx.ts";

/**
 * Business attribution: post → clicks → leads → bookings → revenue, keyed on `utm_content`.
 *
 * Sources, all de-duplicated:
 * - `contacts` (leads the community module captures from DMs and lead magnets) with their `utm_content`, or the
 *   keyword they commented, mapped to the piece that owns that keyword;
 * - `funnel_events` from the user's website: webhook (`POST /webhooks/site`), CSV import or an agent tool.
 */

export const funnelEventInput = z.object({
  kind: z.enum(["click", "lead", "booking", "sale"]),
  at: z.string().datetime({ offset: true }).optional(),
  utmContent: z.string().trim().max(200).optional(),
  utmSource: z.string().trim().max(60).optional(),
  utmMedium: z.string().trim().max(60).optional(),
  utmCampaign: z.string().trim().max(120).optional(),
  visitorId: z.string().trim().max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  valueUsd: z.number().min(0).max(10_000_000).optional(),
  /** The website's own id for the event, so a re-sent webhook or re-imported CSV is stored once. */
  id: z.string().trim().max(200).optional(),
});
export type FunnelEventInput = z.output<typeof funnelEventInput>;

export async function funnelPostKeys(ctx: AnalyticsCtx): Promise<FunnelPostKey[]> {
  const rows = await ctx.sql`
    select id, platform, utm_content, published_at from posts
     where workspace_id = ${ctx.id} and status = 'published' and utm_content is not null`;
  return rows.map((r) => ({ postId: r.id as string, platform: r.platform as string, utmContent: r.utm_content as string, publishedAt: (r.published_at as Date | null) ?? null }));
}

/** Stores website events, resolving each tag to a post. Returns how many were new. */
export async function recordFunnelEvents(ctx: AnalyticsCtx, events: readonly FunnelEventInput[], source: "webhook" | "csv" | "manual" | "agent"): Promise<{ stored: number; duplicates: number; matched: number }> {
  const resolve = utmResolver(await funnelPostKeys(ctx));
  let stored = 0;
  let duplicates = 0;
  let matched = 0;
  for (const e of events) {
    const postId = resolve(e.utmContent, e.utmSource);
    const rows = await ctx.sql`
      insert into funnel_events (workspace_id, occurred_at, kind, utm_content, utm_source, utm_medium, utm_campaign, post_id, visitor_id, email, value_usd, external_id, source)
      values (${ctx.id}, ${e.at ? new Date(e.at) : ctx.now()}, ${e.kind}, ${e.utmContent ?? null}, ${e.utmSource ?? null}, ${e.utmMedium ?? null},
              ${e.utmCampaign ?? null}, ${postId}, ${e.visitorId ?? null}, ${e.email ?? null}, ${e.valueUsd ?? null}, ${e.id ?? null}, ${source})
      on conflict (workspace_id, source, external_id) where external_id is not null do nothing
      returning id`;
    if (rows.length) {
      stored++;
      if (postId) matched++;
    } else duplicates++;
  }
  return { stored, duplicates, matched };
}

/** Website events plus captured contacts as one event list for attribution. */
export async function loadFunnelEvents(ctx: AnalyticsCtx, from: Date, to: Date = ctx.now()): Promise<FunnelEvent[]> {
  const events = await ctx.sql`
    select kind, occurred_at, utm_content, utm_source, visitor_id, email, value_usd from funnel_events
     where workspace_id = ${ctx.id} and occurred_at >= ${from} and occurred_at < ${to}`;
  // Contacts are leads; a keyword without a tag maps to the first tagged post of the piece that owns the keyword.
  const contacts = await ctx.sql`
    select ct.created_at, ct.email, ct.platform,
           coalesce(ct.utm_content, (
             select p.utm_content from keywords k join posts p on p.content_id = k.content_id and p.workspace_id = k.workspace_id
              where k.workspace_id = ct.workspace_id and lower(k.word) = lower(ct.keyword) and p.utm_content is not null
              order by p.published_at nulls last limit 1)) as utm
      from contacts ct
     where ct.workspace_id = ${ctx.id} and ct.created_at >= ${from} and ct.created_at < ${to}`;
  return [
    ...contacts.map((c): FunnelEvent => ({ kind: "lead", at: c.created_at as Date, utmContent: (c.utm as string | null) ?? null, utmSource: (c.platform as string | null) ?? null, email: (c.email as string | null) ?? null })),
    ...events.map((e): FunnelEvent => ({
      kind: e.kind as FunnelEvent["kind"], at: e.occurred_at as Date, utmContent: (e.utm_content as string | null) ?? null, utmSource: (e.utm_source as string | null) ?? null,
      visitorId: (e.visitor_id as string | null) ?? null, email: (e.email as string | null) ?? null, valueUsd: num(e.value_usd),
    })),
  ];
}

/** Per-post funnel counts over a window (posts keyed by id; untagged and unmatched kept apart). */
export async function funnelByPost(ctx: AnalyticsCtx, from: Date, to: Date = ctx.now()) {
  return attributeFunnel(await loadFunnelEvents(ctx, from, to), await funnelPostKeys(ctx));
}

/** Whether any website events were ever received (to tell "zero bookings" from "bookings not connected"). */
export async function funnelSources(ctx: AnalyticsCtx): Promise<{ events: number; clicks: number; bookings: number; sales: number; lastEventAt: string | null }> {
  const [r] = await ctx.sql`
    select count(*)::int as n,
           count(*) filter (where kind = 'click')::int as clicks,
           count(*) filter (where kind = 'booking')::int as bookings,
           count(*) filter (where kind = 'sale')::int as sales,
           max(occurred_at) as last
      from funnel_events where workspace_id = ${ctx.id}`;
  return { events: Number(r?.n ?? 0), clicks: Number(r?.clicks ?? 0), bookings: Number(r?.bookings ?? 0), sales: Number(r?.sales ?? 0), lastEventAt: iso(r?.last) };
}

export type FunnelPostRow = { postId: string; views: number | null; counts: FunnelCounts; providerClicks: number | null };

export type FunnelReport = {
  days: number;
  steps: FunnelStep[];
  biggestDrop: FunnelStep | null;
  totals: FunnelCounts & { views: number };
  /** Clicks come from website events when there are any, else from the clicks the platform reports. */
  clicksSource: "website" | "platform" | "none";
  byPost: FunnelPostRow[];
  untagged: FunnelCounts;
  unmatched: { tag: string; counts: FunnelCounts }[];
  weekly: { start: string; leads: number; bookings: number; revenue: number }[];
  /** Per 1,000 views, pooled over posts with views. */
  per1k: { leads: number | null; bookings: number | null };
  gaps: string[];
};

/**
 * The funnel for posts published in the last `days` days, with outcomes credited to those posts (first touch).
 * `posts` are the window's scored posts (views + provider clicks), passed in so callers reuse one load.
 */
export async function funnelReport(ctx: AnalyticsCtx, posts: readonly { postId: string; publishedAt: string; views: number | null; clicks: number | null }[], days: number): Promise<FunnelReport> {
  const now = ctx.now();
  const from = new Date(now.getTime() - days * DAY_MS);
  const inWindow = posts.filter((p) => Date.parse(p.publishedAt) >= from.getTime());
  const att = await funnelByPost(ctx, from, now);
  const sources = await funnelSources(ctx);
  const byPost: FunnelPostRow[] = inWindow.map((p) => ({ postId: p.postId, views: p.views, counts: att.byPost.get(p.postId) ?? emptyCounts(), providerClicks: p.clicks }));
  const sum = (k: keyof FunnelCounts) => byPost.reduce((s, r) => s + r.counts[k], 0);
  const views = inWindow.reduce((s, p) => s + (p.views ?? 0), 0);
  const websiteClicks = sum("clicks");
  const platformClicks = inWindow.reduce((s, p) => s + (p.clicks ?? 0), 0);
  const clicksSource = websiteClicks > 0 ? "website" : platformClicks > 0 ? "platform" : "none";
  const clicks = clicksSource === "website" ? websiteClicks : clicksSource === "platform" ? platformClicks : null;
  const totals = { views, clicks: clicks ?? 0, leads: sum("leads"), bookings: sum("bookings"), sales: sum("sales"), revenue: Math.round(sum("revenue") * 100) / 100 };
  const steps = funnelSteps([
    { key: "views", label: "Views", value: views || null },
    { key: "clicks", label: "Link clicks", value: clicks },
    { key: "leads", label: "Leads", value: totals.leads },
    { key: "bookings", label: "Booked calls", value: sources.bookings > 0 || totals.bookings > 0 ? totals.bookings : null },
    { key: "sales", label: "Sales", value: sources.sales > 0 || totals.sales > 0 ? totals.sales : null },
  ]);

  const weeks = Math.min(12, Math.max(4, Math.ceil(days / 7)));
  const weekly: FunnelReport["weekly"] = [];
  const allEvents = await loadFunnelEvents(ctx, new Date(now.getTime() - weeks * 7 * DAY_MS), now);
  for (let i = weeks - 1; i >= 0; i--) {
    const end = now.getTime() - i * 7 * DAY_MS;
    const start = end - 7 * DAY_MS;
    const inWeek = allEvents.filter((e) => {
      const t = new Date(e.at).getTime();
      return t >= start && t < end;
    });
    const emails = new Set<string>();
    let leads = 0;
    for (const e of inWeek.filter((x) => x.kind === "lead")) {
      const k = e.email?.toLowerCase();
      if (k && emails.has(k)) continue;
      if (k) emails.add(k);
      leads++;
    }
    weekly.push({
      start: new Date(start).toISOString(),
      leads,
      bookings: inWeek.filter((e) => e.kind === "booking").length,
      revenue: Math.round(inWeek.filter((e) => e.kind === "sale").reduce((s, e) => s + (e.valueUsd ?? 0), 0) * 100) / 100,
    });
  }

  const gaps: string[] = [];
  if (sources.events === 0) gaps.push("GAP: no website events yet. Send clicks, leads, bookings and sales with utm_content to /webhooks/site (or drop a CSV in imports/funnel/) to see the full funnel.");
  else {
    if (sources.bookings === 0) gaps.push("GAP: no booking events have arrived from your website, so booked calls aren't counted yet.");
    if (sources.sales === 0) gaps.push("GAP: no sale events have arrived, so revenue isn't attributed yet.");
  }
  if (clicksSource === "none") gaps.push("GAP: no link clicks reported by the platform or your website for these posts.");
  const unmatched = [...att.unmatched.entries()].map(([tag, counts]) => ({ tag, counts })).sort((a, b) => b.counts.leads + b.counts.clicks - (a.counts.leads + a.counts.clicks));
  if (unmatched.length) gaps.push(`GAP: ${unmatched.length} tag${unmatched.length === 1 ? "" : "s"} (${unmatched.slice(0, 3).map((u) => u.tag).join(", ")}) match no post. Check the links in bios or old captions.`);
  const per = (n: number) => (views > 0 ? Math.round((n / views) * 1000 * 1000) / 1000 : null);
  return { days, steps, biggestDrop: biggestDrop(steps), totals, clicksSource, byPost, untagged: att.untagged, unmatched, weekly, per1k: { leads: per(totals.leads), bookings: sources.bookings > 0 ? per(totals.bookings) : null }, gaps };
}
