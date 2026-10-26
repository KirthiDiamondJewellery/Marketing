import { z } from "zod";
import { defineNativeJob, ProviderError, type Scraper, type WorkspaceContext } from "@attentionos/core";
import {
  computeBaseline, dailyRotation, daysLeftInMonth, detectCrossCreatorTrends, resolveRule, scorePost,
  type CrossCreatorTrend, type RuleOverrides,
} from "@attentionos/scoring";
import { transcriptionRequest } from "../handoff.ts";
import { alertOnce, enqueueRun, fmtUsd, periodStart, recordCost, spendSince } from "../lib/ops.ts";
import { listTrackedCreators, markScanned, setCreatorBaseline, syncTrackedCreators, type TrackedCreator } from "../repo/creators.ts";
import { listCreatorPosts, listOutliers, mergeXDetail, saveScore, setTranscriptStatus, upsertExternalPosts } from "../repo/externalPosts.ts";
import { researchSettings, type ResearchSettings } from "../settings.ts";

/** Optional capabilities some scrapers have beyond the core contract (see provider-scrape-apify). */
type SpendRecord = { usd: number; estimated?: boolean; [k: string]: unknown };
type SpendAware = { drainSpend(): SpendRecord[]; accountUsageUsd?(): Promise<{ usedUsd: number }> };
const isSpendAware = (s: Scraper): s is Scraper & SpendAware => typeof (s as Partial<SpendAware>).drainSpend === "function";

/** Scrapers that scrape public pages (rather than an official API) need the platform-terms acknowledgement. */
const NEEDS_TERMS_ACK = new Set(["apify", "ytdlp"]);

export type ScanResult = {
  skipped?: "no_scraper" | "needs_acknowledgement" | "budget" | "no_creators";
  scanned: number;
  failed: { handle: string; platform: string; reason: string }[];
  postsSeen: number;
  newOutliers: number;
  trends: CrossCreatorTrend[];
  transcriptionsQueued: number;
  /** Teardowns queued for the owner's own best posts. */
  ownTeardownsQueued?: number;
  spentUsd: number;
  budget: { usedUsd: number; limitUsd: number };
};

export async function scrapingBudgetUsed(ws: WorkspaceContext, scraper?: Scraper): Promise<number> {
  const ledger = await spendSince(ws, "scraping", periodStart(ws.now(), ws.config.workspace.timezone, "month"));
  if (scraper && isSpendAware(scraper) && scraper.accountUsageUsd) {
    try {
      const account = await scraper.accountUsageUsd();
      return Math.max(ledger, account.usedUsd);
    } catch {
      // Ledger alone is still a safe floor.
    }
  }
  return ledger;
}

/** Recomputes a creator's baseline from stored history, rescores every post, returns ids that just became outliers. */
export async function rescoreCreator(ws: WorkspaceContext, creator: TrackedCreator, settings: ResearchSettings): Promise<string[]> {
  const posts = await listCreatorPosts(ws, creator.id);
  const now = ws.now();
  const baseline = computeBaseline(posts, now, {
    matureHours: settings.competitorScan.matureHours,
    maxAgeDays: settings.competitorScan.maxAgeDays,
    minPosts: settings.competitorScan.minBaselinePosts,
  });
  await setCreatorBaseline(ws, creator.id, baseline);
  const rule = resolveRule(creator.platform, settings.competitorScan.rules as RuleOverrides);
  const fresh: string[] = [];
  for (const p of posts) {
    if (p.isPinned) continue;
    const score = scorePost(p, baseline, rule);
    if (score.isOutlier && !p.isOutlier) fresh.push(p.id);
    await saveScore(ws, p.id, score, { baselineN: baseline.n });
  }
  return fresh;
}

export async function runCompetitorScan(
  ws: WorkspaceContext,
  opts: { runId?: string | null; handles?: string[]; progress?: (m: string) => Promise<void> } = {},
): Promise<ScanResult> {
  const progress = opts.progress ?? (async () => {});
  const settings = researchSettings(ws);
  const limitUsd = ws.config.budgets.scrapingMonthlyUsd;
  const result: ScanResult = { scanned: 0, failed: [], postsSeen: 0, newOutliers: 0, trends: [], transcriptionsQueued: 0, spentUsd: 0, budget: { usedUsd: 0, limitUsd } };

  await syncTrackedCreators(ws);
  const scraper = ws.providers.scraper;
  if (!scraper) return { ...result, skipped: "no_scraper" };

  if (NEEDS_TERMS_ACK.has(scraper.id) && !ws.config.acknowledgements.scrapingTerms) {
    await alertOnce(ws, "competitor-scan:terms",
      "Competitor scan is paused until you accept the platform-terms notice for scraping. Run `attentionos doctor` to read it and turn it on, or switch the scraper to the Instagram Graph API.", { everyHours: 72 });
    return { ...result, skipped: "needs_acknowledgement" };
  }

  let creators = await listTrackedCreators(ws);
  if (opts.handles?.length) {
    const wanted = new Set(opts.handles.map((h) => h.replace(/^@/, "").toLowerCase()));
    creators = creators.filter((c) => wanted.has(c.handle));
  }
  if (creators.length === 0) return { ...result, skipped: "no_creators" };

  // Budget guard BEFORE any scraping: alert instead of failing.
  const used = await scrapingBudgetUsed(ws, scraper);
  result.budget.usedUsd = used;
  const limit = settings.competitorScan.postsPerCreator;
  const perCreatorUsd = await scraper.estimateCostUsd([{ handle: creators[0]!.handle, platform: creators[0]!.platform }], { limit });
  const tz = ws.config.workspace.timezone;
  const rotation = opts.handles?.length
    ? { picked: creators, count: creators.length, start: 0 }
    : dailyRotation(creators, {
        date: ws.now(),
        perDay: settings.competitorScan.creatorsPerDay,
        timeZone: tz,
        budget: { remainingUsd: limitUsd - used, costPerItemUsd: perCreatorUsd, daysLeft: daysLeftInMonth(ws.now(), tz) },
      });
  if (rotation.count === 0 || used >= limitUsd) {
    await alertOnce(ws, "competitor-scan:budget",
      `Competitor scan skipped today. Scraping spend is at ${fmtUsd(used)} of your ${fmtUsd(limitUsd)} monthly budget, so nothing was scraped. Raise budgets.scrapingMonthlyUsd to scan again this month.`);
    return { ...result, skipped: "budget" };
  }
  await progress(`Checking ${rotation.count} of ${creators.length} tracked creators today${"limitedBy" in rotation && rotation.limitedBy ? " (fewer than usual to stay inside the scraping budget)" : ""}`);

  let spent = 0;
  const freshOutliers: string[] = [];
  for (const creator of rotation.picked) {
    const estimate = await scraper.estimateCostUsd([{ handle: creator.handle, platform: creator.platform }], { limit });
    if (used + spent + estimate > limitUsd) {
      await progress("Stopped early: the next creator would go over the scraping budget");
      break;
    }
    try {
      const posts = await scraper.listCreatorPosts(creator.handle, creator.platform, { limit });
      await upsertExternalPosts(ws, creator.id, posts);
      await markScanned(ws, creator.id);
      result.scanned++;
      result.postsSeen += posts.length;
      freshOutliers.push(...(await rescoreCreator(ws, creator, settings)));
    } catch (err) {
      const reason = err instanceof ProviderError ? err.message : (err as Error).message;
      result.failed.push({ handle: creator.handle, platform: creator.platform, reason });
      if (err instanceof ProviderError && (err.code === "auth" || err.code === "budget_exceeded")) {
        await alertOnce(ws, `competitor-scan:${err.code}`, `Competitor scan stopped: ${reason}`);
        break;
      }
    } finally {
      const records = isSpendAware(scraper) ? scraper.drainSpend() : estimate > 0 ? [{ usd: estimate, estimated: true }] : [];
      for (const r of records) {
        spent += r.usd;
        await recordCost(ws, { category: "scraping", provider: scraper.id, usd: r.usd, runId: opts.runId ?? null, detail: { ...r, creator: `${creator.platform}:${creator.handle}` } });
      }
    }
  }
  result.spentUsd = Math.round(spent * 10_000) / 10_000;
  result.newOutliers = freshOutliers.length;

  // Cross-creator trends: a topic or hook pattern that broke out for 2+ creators.
  const recent = await listOutliers(ws, { sinceDays: settings.competitorScan.crossCreatorDays, limit: 500 });
  result.trends = detectCrossCreatorTrends(recent.map((p) => ({
    postId: p.id,
    creator: `${p.platform}:${p.authorHandle.toLowerCase()}`,
    text: [p.caption, p.spokenHook].filter(Boolean).join(" "),
    keys: [
      ...(typeof p.tags?.hook_pattern === "string" ? [`pattern:${p.tags.hook_pattern}`] : []),
      ...(typeof p.tags?.format === "string" ? [`format:${p.tags.format}`] : []),
    ],
  })));
  const trendKeysByPost = new Map<string, string[]>();
  for (const t of result.trends) for (const id of t.postIds) trendKeysByPost.set(id, [...(trendKeysByPost.get(id) ?? []), t.key]);
  for (const p of recent) await mergeXDetail(ws, p.id, { crossCreator: trendKeysByPost.get(p.id) ?? [] });

  // Transcribe winners to get the spoken hook (hand-off to the editing module's ASR), then tear them down so each
  // one has a remix blueprint ready before the Strategist plans it.
  const toTranscribe = recent.filter((p) => !p.transcript && !p.transcriptStatus && (p.videoUrl || p.url)).slice(0, settings.competitorScan.transcribeTopN);
  for (const p of toTranscribe) {
    const id = await enqueueRun(ws, {
      jobId: settings.competitorScan.transcribeJobId,
      agent: "art_director",
      input: transcriptionRequest(p, settings.competitorScan.autoTeardown ? { jobId: "research.teardown", agent: "analyst", input: { externalPostId: p.id } } : undefined),
      dedupeKey: `transcribe:external_post:${p.id}`,
      parentRunId: opts.runId ?? null,
      createdBy: "agent:analyst",
    });
    if (id) {
      await setTranscriptStatus(ws, p.id, "queued");
      result.transcriptionsQueued++;
    }
  }
  if (settings.competitorScan.autoTeardown) result.ownTeardownsQueued = await queueOwnTeardowns(ws, settings.competitorScan.ownTeardownsPerScan, opts.runId ?? null);

  await progress(
    `Checked ${result.scanned} creator${result.scanned === 1 ? "" : "s"} and ${result.postsSeen} posts: ${result.newOutliers} new outlier${result.newOutliers === 1 ? "" : "s"}` +
      (result.trends.length ? `, ${result.trends.length} topic${result.trends.length === 1 ? "" : "s"} breaking out for more than one creator` : "") +
      `. Scraping cost ${fmtUsd(result.spentUsd)} (${fmtUsd(used + result.spentUsd)} of ${fmtUsd(limitUsd)} this month).`,
  );
  return result;
}

/**
 * The owner's own breakouts (imported posts with a transcript, best against their median first) get a teardown too,
 * so the Copywriter can redo what worked for them ("do that again, new angle") and write in their words.
 */
export async function queueOwnTeardowns(ws: WorkspaceContext, limit: number, runId: string | null): Promise<number> {
  if (limit <= 0) return 0;
  const rows = await ws.sql`
    select p.id from external_posts p join tracked_creators c on c.id = p.tracked_creator_id and c.workspace_id = p.workspace_id
     where p.workspace_id = ${ws.id} and c.tier = 'own' and p.transcript is not null and p.views is not null
       and not exists (select 1 from teardowns t where t.workspace_id = p.workspace_id and t.external_post_id = p.id)
     order by p.views desc limit ${limit}`;
  let n = 0;
  for (const r of rows) {
    const id = await enqueueRun(ws, { jobId: "research.teardown", agent: "analyst", input: { externalPostId: r.id }, dedupeKey: `teardown:${r.id}`, parentRunId: runId, createdBy: "agent:analyst" });
    if (id) n++;
  }
  return n;
}

export const competitorScanInput = z.object({
  /** Scan only these handles (manual run); default is today's rotation. */
  handles: z.array(z.string()).optional(),
});

export const competitorScanJob = defineNativeJob({
  kind: "native",
  id: "research.competitor-scan",
  agent: "analyst",
  description: "Checks today's rotation of tracked creators, scores their posts against each creator's normal and flags outliers.",
  input: competitorScanInput,
  timeoutMs: 30 * 60_000,
  run: (ctx) => runCompetitorScan(ctx.ws, { runId: ctx.runId, ...(ctx.input.handles ? { handles: ctx.input.handles } : {}), progress: (m) => ctx.progress(m) }),
});
