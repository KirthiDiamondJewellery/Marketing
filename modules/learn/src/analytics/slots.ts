import { slotHeatmap, type SlotHeatmap } from "@attentionos/scoring";
import { learnSettings } from "../settings.ts";
import type { AnalyticsCtx } from "./ctx.ts";
import { postFacts, type PostFact } from "./posts.ts";

/**
 * Best posting slots: a day × time-block heatmap (local time) of settled posts' outcome against the account's
 * normal, with small slots shrunk toward the normal and gaps called out.
 */

export const SLOT_METRICS = {
  x: { label: "vs your usual", value: (p: PostFact) => p.x },
  send_rate: { label: "send rate", value: (p: PostFact) => p.rates.sendRate },
  follows_per_1k: { label: "follows per 1k views", value: (p: PostFact) => p.rates.followsPer1k },
} as const;
export type SlotMetric = keyof typeof SLOT_METRICS;

export type BestSlots = SlotHeatmap & { metric: SlotMetric; days: number | null; platform: string | null };

export function bestSlotsFrom(ctx: AnalyticsCtx, posts: readonly PostFact[], opts: { metric?: SlotMetric; days?: number | null; platform?: string | null } = {}): BestSlots {
  const s = learnSettings(ctx).slots;
  const metric = opts.metric ?? "x";
  const def = SLOT_METRICS[metric];
  const rows = posts
    .filter((p) => p.settled && (!opts.platform || p.platform === opts.platform))
    .map((p) => ({ publishedAt: p.publishedAt, x: def.value(p) }));
  const h = slotHeatmap(rows, { timeZone: ctx.config.workspace.timezone, blockHours: s.blockHours, minN: s.minN, priorN: s.priorN, confidence: learnSettings(ctx).attribution.confidence });
  return { ...h, metric, days: opts.days ?? null, platform: opts.platform ?? null };
}

export async function bestSlots(ctx: AnalyticsCtx, opts: { metric?: SlotMetric; days?: number | null; platform?: string | null; includeScanned?: boolean } = {}): Promise<BestSlots> {
  const { posts } = await postFacts(ctx, { ...(opts.days ? { sinceDays: opts.days } : {}), includeScanned: opts.includeScanned ?? false });
  return bestSlotsFrom(ctx, posts, opts);
}
