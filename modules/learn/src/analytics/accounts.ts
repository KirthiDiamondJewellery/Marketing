import type { OwnAnalytics, Platform, WorkspaceContext } from "@attentionos/core";
import { change, localDay } from "@attentionos/scoring";
import { DAY_MS, iso, type AnalyticsCtx } from "./ctx.ts";

/**
 * Follower growth: one `account_snapshots` row per connected account per day. Providers that can read
 * follower history expose `listAccountStats` (Zernio's follower stats, the CSV import); it is optional, so it is
 * read by shape rather than through the core interface.
 */

export type AccountStat = { day: string; platform?: Platform; followers?: number; following?: number; posts?: number; capturedAt?: string };
export type AccountStatsCapable = { listAccountStats(accountId: string, opts?: { since?: string }): Promise<AccountStat[]> };

export function canListAccountStats(p: OwnAnalytics | undefined): p is OwnAnalytics & AccountStatsCapable {
  return !!p && typeof (p as Partial<AccountStatsCapable>).listAccountStats === "function";
}

/** `social_accounts.provider` of the placeholder rows that hold follower counts read off a public account. */
export const SCAN_PROVIDER = "scan";

/** Moves every placeholder's history onto the real account with the same platform and handle, then drops it. */
export async function foldScanAccounts(ws: Pick<WorkspaceContext, "sql" | "id">): Promise<number> {
  const pairs = await ws.sql<{ placeholder: string; real: string }[]>`
    select p.id as placeholder, r.id as real
      from social_accounts p
      join lateral (
        select id from social_accounts r
         where r.workspace_id = p.workspace_id and r.provider <> ${SCAN_PROVIDER} and r.status <> 'disabled'
           and r.platform = p.platform and lower(ltrim(r.handle, '@')) = lower(ltrim(p.handle, '@'))
         order by r.connected_at limit 1) r on true
     where p.workspace_id = ${ws.id} and p.provider = ${SCAN_PROVIDER}`;
  for (const { placeholder, real } of pairs) {
    await ws.sql`
      update account_snapshots s set social_account_id = ${real}
       where s.workspace_id = ${ws.id} and s.social_account_id = ${placeholder}
         and not exists (select 1 from account_snapshots x where x.workspace_id = ${ws.id} and x.social_account_id = ${real} and x.day = s.day)`;
    // Same-day readings the real account already has go with the placeholder (cascade).
    await ws.sql`delete from social_accounts where workspace_id = ${ws.id} and id = ${placeholder}`;
  }
  return pairs.length;
}

export type CaptureFollowersResult = { accounts: number; days: number; skipped?: "no_provider" | "unsupported" | "no_accounts" };

export async function captureFollowers(ws: WorkspaceContext, opts: { backfillDays?: number } = {}): Promise<CaptureFollowersResult> {
  const provider = ws.providers.ownAnalytics;
  if (!provider) return { accounts: 0, days: 0, skipped: "no_provider" };
  if (!canListAccountStats(provider)) return { accounts: 0, days: 0, skipped: "unsupported" };
  const accounts = await ws.sql`
    select id, provider_account_id, platform from social_accounts where workspace_id = ${ws.id} and status = 'connected' order by platform`;
  if (!accounts.length) return { accounts: 0, days: 0, skipped: "no_accounts" };
  const since = new Date(ws.now().getTime() - (opts.backfillDays ?? 35) * DAY_MS).toISOString();
  let days = 0;
  for (const a of accounts) {
    const id = provider.id === "csv" ? "*" : (a.provider_account_id as string);
    const stats = (await provider.listAccountStats(id, { since })).filter((s) => !s.platform || s.platform === a.platform);
    for (const s of stats) {
      if (typeof s.followers !== "number" || !/^\d{4}-\d{2}-\d{2}$/.test(s.day)) continue;
      await ws.sql`
        insert into account_snapshots (workspace_id, social_account_id, day, captured_at, followers, following, posts_count, source)
        values (${ws.id}, ${a.id as string}, ${s.day}, ${s.capturedAt ? new Date(s.capturedAt) : ws.now()}, ${s.followers}, ${s.following ?? null}, ${s.posts ?? null}, ${provider.id})
        on conflict (workspace_id, social_account_id, day) do update
          set followers = excluded.followers, following = coalesce(excluded.following, account_snapshots.following),
              posts_count = coalesce(excluded.posts_count, account_snapshots.posts_count), captured_at = excluded.captured_at, source = excluded.source`;
      days++;
    }
  }
  // Follower counts setup read off the public account, kept under a placeholder until this account showed up.
  if (days) await foldScanAccounts(ws);
  return { accounts: accounts.length, days };
}

export type FollowerPoint = { day: string; followers: number };

export type FollowerGrowth = {
  /** Summed across accounts per day, carrying each account's last known count forward. Oldest first. */
  series: FollowerPoint[];
  accounts: { id: string; platform: string; handle: string; followers: number | null; delta7: number | null; delta30: number | null; series: FollowerPoint[] }[];
  current: number | null;
  /** Net new followers over the last 7 / 30 days (null without a reading that old). */
  delta7: number | null;
  delta30: number | null;
  /** Previous 7 days' net growth, for a week-over-week change. */
  previous7: number | null;
  growthChange: number | null;
  lastDay: string | null;
  gap?: string;
};

function deltaOver(series: FollowerPoint[], days: number, today: string): number | null {
  if (!series.length) return null;
  const last = series[series.length - 1]!;
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
  // The last reading on or before the cutoff; with none that old, the first reading (a shorter span, still honest).
  const base = [...series].reverse().find((p) => p.day <= cutoff) ?? series[0]!;
  if (base.day === last.day) return null;
  return last.followers - base.followers;
}

export async function followerGrowth(ctx: AnalyticsCtx, days = 90): Promise<FollowerGrowth> {
  const tz = ctx.config.workspace.timezone;
  const today = localDay(ctx.now(), tz);
  const from = new Date(ctx.now().getTime() - (days + 31) * DAY_MS).toISOString().slice(0, 10);
  const rows = await ctx.sql`
    select s.social_account_id, s.day, s.followers, a.platform, a.handle
      from account_snapshots s join social_accounts a on a.id = s.social_account_id and a.workspace_id = s.workspace_id
     where s.workspace_id = ${ctx.id} and s.day >= ${from} and s.followers is not null
     order by s.day`;
  const dayStr = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const byAccount = new Map<string, { platform: string; handle: string; series: FollowerPoint[] }>();
  for (const r of rows) {
    const k = r.social_account_id as string;
    const acc = byAccount.get(k) ?? { platform: r.platform as string, handle: r.handle as string, series: [] };
    acc.series.push({ day: dayStr(r.day), followers: Number(r.followers) });
    byAccount.set(k, acc);
  }
  if (!byAccount.size) {
    return { series: [], accounts: [], current: null, delta7: null, delta30: null, previous7: null, growthChange: null, lastDay: null, gap: "GAP: no follower history yet. It fills in daily once your analytics provider reports follower counts (or drop a follower CSV in imports/analytics/)." };
  }
  // Combined series: every day any account reported, each account carrying its last count forward.
  const daysAll = [...new Set(rows.map((r) => dayStr(r.day)))].sort();
  const last = new Map<string, number>();
  const series: FollowerPoint[] = [];
  for (const d of daysAll) {
    for (const [k, acc] of byAccount) {
      const p = acc.series.find((x) => x.day === d);
      if (p) last.set(k, p.followers);
    }
    series.push({ day: d, followers: [...last.values()].reduce((s, v) => s + v, 0) });
  }
  const shown = series.filter((p) => p.day >= new Date(ctx.now().getTime() - days * DAY_MS).toISOString().slice(0, 10));
  const delta7 = deltaOver(series, 7, today);
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10);
  const previous7 = deltaOver(series.filter((p) => p.day <= weekAgo), 7, weekAgo);
  return {
    series: shown,
    accounts: [...byAccount.entries()].map(([id, a]) => ({
      id, platform: a.platform, handle: a.handle, followers: a.series.at(-1)?.followers ?? null,
      delta7: deltaOver(a.series, 7, today), delta30: deltaOver(a.series, 30, today), series: a.series.filter((p) => p.day >= (shown[0]?.day ?? "")),
    })),
    current: series.at(-1)?.followers ?? null,
    delta7,
    delta30: deltaOver(series, 30, today),
    previous7,
    growthChange: change(delta7, previous7),
    lastDay: series.at(-1)?.day ?? null,
  };
}

export async function lastFollowerCapture(ctx: AnalyticsCtx): Promise<string | null> {
  const [r] = await ctx.sql`select max(captured_at) as at from account_snapshots where workspace_id = ${ctx.id}`;
  return iso(r?.at);
}

