import { z } from "zod";
import { compact, defineTool, PLATFORMS, ToolError } from "@attentionos/core";
import { normaliseHandle, removeCompetitorFromFile, upsertCompetitorInFile } from "../lib/brandFiles.ts";
import { fmtUsd, periodStart, spendSince } from "../lib/ops.ts";
import { creatorStats, listTrackedCreators, syncTrackedCreators } from "../repo/creators.ts";
import { outlierCount } from "../repo/externalPosts.ts";
import { ownSyncStats } from "../repo/ownPosts.ts";
import { trendCounts } from "../repo/trends.ts";

const TIERS = ["core", "adjacent", "aspirational", "remake"] as const;

export const listTrackedCreatorsTool = defineTool({
  name: "research_list_tracked_creators",
  description: "List the creators the competitor scan rotates through (from brand/competitors.yaml), with each one's baseline (their normal numbers) and when they were last checked.",
  input: z.object({ platform: z.enum(PLATFORMS).optional(), includeInactive: z.boolean().default(false) }),
  annotations: { readOnly: true },
  async handler({ ws }, input) {
    const rows = await listTrackedCreators(ws, input);
    return rows.map((c) => compact({
      handle: `@${c.handle}`, platform: c.platform, tier: c.tier, active: c.active ? undefined : false,
      baseline: c.baseline ? { views: c.baseline.views, comments: c.baseline.comments, posts: c.baseline.n, enough: c.baseline.sufficient } : undefined,
      lastChecked: c.lastScannedAt, notes: c.notes,
    }));
  },
});

export const addTrackedCreatorTool = defineTool({
  name: "research_add_tracked_creator",
  description:
    "Track a creator in the competitor scan. Writes them into brand/competitors.yaml (keeping the file's comments) and adds them to today's rotation pool. " +
    "Tier: core (same audience), adjacent (neighbouring niche), aspirational (bigger, same format), remake (creators whose formats you remake).",
  input: z.object({
    handle: z.string().min(2).max(60),
    platform: z.enum(PLATFORMS),
    tier: z.enum(TIERS).default("core"),
    notes: z.string().max(300).optional(),
  }),
  async handler({ ws }, input) {
    const handle = normaliseHandle(input.handle);
    if (!/^[\w.-]{2,60}$/.test(handle)) throw new ToolError("That doesn't look like a handle", "Use the account name without spaces, e.g. @demo_creator_a");
    const change = upsertCompetitorInFile(ws.paths.brand, { handle, platform: input.platform, tier: input.tier, ...(input.notes ? { notes: input.notes } : {}) });
    const sync = await syncTrackedCreators(ws);
    return { result: change, handle: `@${handle}`, platform: input.platform, tracked: sync.active };
  },
});

export const removeTrackedCreatorTool = defineTool({
  name: "research_remove_tracked_creator",
  description: "Stop tracking a creator: removes them from brand/competitors.yaml and the rotation. Their past posts stay in the library.",
  input: z.object({ handle: z.string().min(2), platform: z.enum(PLATFORMS) }),
  annotations: { destructive: true, idempotent: true },
  async handler({ ws }, input) {
    const removed = removeCompetitorFromFile(ws.paths.brand, input.handle, input.platform);
    const sync = await syncTrackedCreators(ws);
    if (!removed) return { result: "not_listed", tracked: sync.active };
    return { result: "removed", handle: `@${normaliseHandle(input.handle)}`, tracked: sync.active };
  },
});

export const researchStatusTool = defineTool({
  name: "research_status",
  description: "One-glance research status: own posts synced, tracked creators and last scan, outliers this week, trend desk counts, and scraping spend against the monthly budget.",
  input: z.object({}),
  annotations: { readOnly: true },
  async handler({ ws }) {
    const tz = ws.config.workspace.timezone;
    const [own, creators, outliers7d, trends, scraping] = await Promise.all([
      ownSyncStats(ws),
      creatorStats(ws),
      outlierCount(ws, 7),
      trendCounts(ws),
      spendSince(ws, "scraping", periodStart(ws.now(), tz, "month")),
    ]);
    const limit = ws.config.budgets.scrapingMonthlyUsd;
    return compact({
      ownPosts: own.posts,
      lastMetricsAt: own.lastCapturedAt,
      trackedCreators: creators.active,
      lastCompetitorScan: creators.lastScanAt,
      outliersThisWeek: outliers7d,
      trends,
      scraping: { spent: fmtUsd(scraping), budget: fmtUsd(limit), left: fmtUsd(Math.max(0, limit - scraping)) },
      providers: {
        analytics: ws.providers.ownAnalytics?.id ?? "not connected",
        scraper: ws.providers.scraper?.id ?? "not connected",
        trendSources: Object.keys(ws.providers.trendSources),
      },
    });
  },
});
