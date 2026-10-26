import type { CreatorProfile, Platform, Scraper, WorkspaceContext } from "@attentionos/core";
import { recordCost, scrapingBudgetUsed } from "@attentionos/module-research";
import { localDay } from "@attentionos/scoring";
import { foldScanAccounts, SCAN_PROVIDER } from "./analytics/accounts.ts";

export { foldScanAccounts, SCAN_PROVIDER };

/**
 * Follower counts read off the owner's public accounts by the scraper (setup's own-post import, then a weekly
 * refresh from `learn.capture-followers`). They land in `account_snapshots` with source `scan`, so Insights and
 * Studio's Analytics show followers from day one, before (or without) an analytics provider.
 *
 * Snapshots need a `social_accounts` row. When the publishing service already lists the same platform and handle,
 * the scan writes onto that row. Otherwise it keeps a placeholder row (provider `scan`, status `disabled`, so nothing
 * tries to post through it or ask a provider about it). Once a real account for the same handle shows up, the
 * placeholder's history is folded into it, so the two are never counted twice.
 */

/** How often the daily follower job re-reads a handle that no provider reports on. */
export const SCAN_REFRESH_DAYS = 7;
/** Scrapers that read public pages need the platform-terms acknowledgement (same rule as research). */
const NEEDS_TERMS_ACK = new Set(["apify", "ytdlp"]);

type Ws = Pick<WorkspaceContext, "sql" | "id" | "now" | "config">;

const bare = (h: string) => h.trim().replace(/^@/, "");

async function snapshotsTableExists(ws: Pick<WorkspaceContext, "sql">): Promise<boolean> {
  const [r] = await ws.sql<{ t: string | null }[]>`select to_regclass('account_snapshots')::text as t`;
  return Boolean(r?.t);
}

/**
 * Writes today's follower reading for one of the owner's handles. A provider's reading for the same day wins:
 * the scan only fills a day the provider hasn't, or updates its own earlier reading.
 */
export async function recordScanFollowers(ws: Ws, profile: CreatorProfile, opts: { scraper: string }): Promise<{ socialAccountId: string; day: string } | null> {
  if (typeof profile.followers !== "number" || !Number.isFinite(profile.followers)) return null;
  if (!(await snapshotsTableExists(ws))) return null;
  const handle = bare(profile.handle);
  const [real] = await ws.sql<{ id: string }[]>`
    select id from social_accounts
     where workspace_id = ${ws.id} and provider <> ${SCAN_PROVIDER} and status <> 'disabled'
       and platform = ${profile.platform} and lower(ltrim(handle, '@')) = lower(${handle})
     order by connected_at limit 1`;
  let accountId = real?.id;
  if (!accountId) {
    const [row] = await ws.sql<{ id: string }[]>`
      insert into social_accounts (workspace_id, provider, provider_account_id, platform, handle, status, updated_at)
      values (${ws.id}, ${SCAN_PROVIDER}, ${`${profile.platform}:${handle.toLowerCase()}`}, ${profile.platform}, ${handle}, 'disabled', now())
      on conflict (workspace_id, provider, provider_account_id) do update set handle = excluded.handle, updated_at = now()
      returning id`;
    accountId = row!.id;
  }
  const capturedAt = new Date(profile.capturedAt);
  const at = Number.isFinite(capturedAt.getTime()) ? capturedAt : ws.now();
  const day = localDay(at, ws.config.workspace.timezone);
  const count = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  await ws.sql`
    insert into account_snapshots (workspace_id, social_account_id, day, captured_at, followers, following, posts_count, source, raw)
    values (${ws.id}, ${accountId}, ${day}, ${at}, ${count(profile.followers)}, ${count(profile.following)}, ${count(profile.posts)}, ${SCAN_PROVIDER},
            ${ws.sql.json({ scraper: opts.scraper, platform: profile.platform, handle })})
    on conflict (workspace_id, social_account_id, day) do update
      set followers = excluded.followers, following = coalesce(excluded.following, account_snapshots.following),
          posts_count = coalesce(excluded.posts_count, account_snapshots.posts_count), captured_at = excluded.captured_at, raw = excluded.raw
      where account_snapshots.source = ${SCAN_PROVIDER}`;
  if (real) await foldScanAccounts(ws);
  return { socialAccountId: accountId, day };
}

export type ScanRefreshResult = { checked: number; recorded: number; skipped?: "no_scraper" | "terms" | "no_handles" | "no_table"; notes: string[] };

/**
 * The weekly re-read: for each of the owner's handles (the `own` creators setup created) with no follower reading in
 * the last `everyDays` days from any source, reads the account numbers through the scraper inside the monthly
 * scraping budget and records the spend.
 */
export async function refreshScanFollowers(ws: WorkspaceContext, opts: { runId?: string | null; everyDays?: number } = {}): Promise<ScanRefreshResult> {
  const out: ScanRefreshResult = { checked: 0, recorded: 0, notes: [] };
  const scraper: Scraper | undefined = ws.providers.scraper;
  if (!scraper?.fetchProfile) return { ...out, skipped: "no_scraper" };
  if (NEEDS_TERMS_ACK.has(scraper.id) && !ws.config.acknowledgements.scrapingTerms) return { ...out, skipped: "terms" };
  if (!(await snapshotsTableExists(ws))) return { ...out, skipped: "no_table" };
  const handles = await ws.sql<{ platform: Platform; handle: string }[]>`
    select platform, handle from tracked_creators where workspace_id = ${ws.id} and tier = 'own' and active order by platform, handle`;
  if (!handles.length) return { ...out, skipped: "no_handles" };
  const since = localDay(new Date(ws.now().getTime() - (opts.everyDays ?? SCAN_REFRESH_DAYS) * 86_400_000), ws.config.workspace.timezone);
  const limitUsd = ws.config.budgets.scrapingMonthlyUsd;
  for (const { platform, handle } of handles) {
    const [fresh] = await ws.sql`
      select 1 from account_snapshots s join social_accounts a on a.id = s.social_account_id and a.workspace_id = s.workspace_id
       where s.workspace_id = ${ws.id} and a.platform = ${platform} and lower(ltrim(a.handle, '@')) = lower(${bare(handle)})
         and s.day > ${since} and s.followers is not null
       limit 1`;
    if (fresh) continue;
    out.checked++;
    const room = limitUsd - (await scrapingBudgetUsed(ws, scraper));
    if (room <= 0) {
      out.notes.push(`Skipped ${platform} ${handle}: the scraping budget ($${limitUsd}/month) is used up.`);
      continue;
    }
    try {
      const profile = await scraper.fetchProfile(bare(handle), platform, { maxUsd: room });
      if (profile && (await recordScanFollowers(ws, profile, { scraper: scraper.id }))) out.recorded++;
    } catch (err) {
      out.notes.push(`Couldn't read ${platform} ${handle} follower count (${err instanceof Error ? err.message.split("\n")[0]!.slice(0, 140) : String(err)}).`);
    } finally {
      for (const r of scraper.drainSpend?.() ?? []) {
        await recordCost(ws, { category: "scraping", provider: scraper.id, usd: r.usd, runId: opts.runId ?? null, detail: { ...r, creator: `${platform}:${bare(handle)}`, own: true, profile: true } });
      }
    }
  }
  return out;
}
