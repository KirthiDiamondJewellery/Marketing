import { z } from "zod";
import { defineNativeJob, ProviderError, type TrendItem, type WorkspaceContext } from "@attentionos/core";
import {
  canonicalUrl, computeHeat, contentWords, HEAT_SOURCE_KINDS, jaccard, selectTrendPicks, shouldFollowUp, velocityLabel,
  type HeatSourceKind,
} from "@attentionos/scoring";
import { enqueueRun, periodStart, queueNotification } from "../lib/ops.ts";
import { alertedOpenTrends, alertedSince, expireStale, markAlerted, markFollowedUp, saveHeat, upsertTrendItem, type StoredTrend } from "../repo/trends.ts";
import { researchSettings } from "../settings.ts";

export type RadarResult = {
  sources: { id: string; items: number; error?: string }[];
  items: number;
  candidates: number;
  picked: { trendId: string; title: string; heat: number }[];
  followUps: number;
  expired: number;
};

/** Words that describe this brand's world, from the Brand Kit docs. Used for a 0–1 relevance score. */
export function brandVocabulary(ws: WorkspaceContext): Set<string> {
  const kit = ws.brand();
  const text = [kit.brand.oneLiner, kit.docs["icp"], kit.docs["offers"], kit.docs["pillars"]].filter(Boolean).join(" ");
  return new Set(contentWords(text));
}

export function relevanceOf(title: string, text: string | undefined, vocab: Set<string>): number {
  if (vocab.size === 0) return 1;
  const hits = contentWords(`${title} ${text ?? ""}`).filter((w) => vocab.has(w)).length;
  return Math.min(1, hits / 3);
}

/** Groups the run's items into stories: same canonical link, or near-identical headlines. */
export function clusterStories(items: { key: string; sourceId: string; url: string; title: string }[]): Map<string, number> {
  const groups: { urls: Set<string>; words: string[]; sources: Set<string>; keys: string[] }[] = [];
  for (const it of items) {
    const url = canonicalUrl(it.url);
    const words = contentWords(it.title);
    const g = groups.find((x) => x.urls.has(url) || (words.length >= 3 && x.words.length >= 3 && jaccard(words, x.words) >= 0.5));
    if (g) {
      g.urls.add(url);
      g.sources.add(it.sourceId);
      g.keys.push(it.key);
    } else groups.push({ urls: new Set([url]), words, sources: new Set([it.sourceId]), keys: [it.key] });
  }
  const coverage = new Map<string, number>();
  for (const g of groups) for (const k of g.keys) coverage.set(k, g.sources.size);
  return coverage;
}

export async function runTrendRadar(ws: WorkspaceContext, opts: { runId?: string | null; progress?: (m: string) => Promise<void> } = {}): Promise<RadarResult> {
  const progress = opts.progress ?? (async () => {});
  const settings = researchSettings(ws).trendRadar;
  const result: RadarResult = { sources: [], items: 0, candidates: 0, picked: [], followUps: 0, expired: 0 };
  const now = ws.now();

  const fetched: { item: TrendItem; kind: HeatSourceKind; weight: number; rank: number }[] = [];
  for (const source of ws.brand().sources.sources.filter((s) => s.enabled)) {
    const provider = ws.providers.trendSources[source.kind];
    if (!provider) {
      result.sources.push({ id: source.id, items: 0, error: `no ${source.kind} provider is set up` });
      continue;
    }
    try {
      const items = await provider.fetch(source.target, { limit: settings.perSourceLimit });
      items.forEach((item, i) => fetched.push({ item: { ...item, sourceId: source.id }, kind: source.kind, weight: source.weight, rank: i + 1 }));
      result.sources.push({ id: source.id, items: items.length });
    } catch (err) {
      result.sources.push({ id: source.id, items: 0, error: err instanceof ProviderError ? err.message : (err as Error).message });
    }
  }
  result.items = fetched.length;

  const coverage = clusterStories(fetched.map((f) => ({ key: `${f.item.sourceId}\u0000${f.item.externalId}`, sourceId: f.item.sourceId, url: f.item.url, title: f.item.title })));
  const vocab = brandVocabulary(ws);
  const heatConfig = settings.heat as Partial<Record<HeatSourceKind, Record<string, number>>>;
  const scored: { trend: StoredTrend; heat: number; score: number; velocity: number; candidate: boolean; relevance: number }[] = [];

  for (const f of fetched) {
    const { trend, previous } = await upsertTrendItem(ws, f.item);
    const cov = coverage.get(`${f.item.sourceId}\u0000${f.item.externalId}`) ?? 1;
    const h = computeHeat({
      kind: (HEAT_SOURCE_KINDS as readonly string[]).includes(f.kind) ? f.kind : "rss",
      points: f.item.points ?? null,
      comments: f.item.comments ?? null,
      followers: f.item.followers ?? null,
      rank: typeof f.item.points === "number" ? null : f.rank,
      publishedAt: f.item.publishedAt ? new Date(f.item.publishedAt) : null,
      now,
      previous: previous ? { points: previous.points, comments: previous.comments, capturedAt: previous.capturedAt } : null,
      sourceWeight: f.weight,
      coverage: cov,
      config: heatConfig,
    });
    const relevance = relevanceOf(f.item.title, f.item.text, vocab);
    await saveHeat(ws, trend.id, { velocity: h.velocity, heat: h.heat, relevance, coverage: cov });
    scored.push({ trend, heat: h.heat, score: h.score, velocity: h.velocity, candidate: h.candidate, relevance });
  }

  // Follow-up once when a story we already sent has doubled its velocity.
  const open = await alertedOpenTrends(ws, scored.map((s) => s.trend.id));
  for (const t of open) {
    const s = scored.find((x) => x.trend.id === t.id);
    if (!s || !shouldFollowUp({ alertedVelocity: t.alertedVelocity, velocity: s.velocity, alreadyFollowedUp: false, factor: settings.followUpFactor })) continue;
    await markFollowedUp(ws, t.id);
    await queueNotification(ws, { text: `Still climbing: "${t.title}" is now moving at ${velocityLabel(s.velocity)}. If you haven't filmed it yet, now is the time.\n${t.url}`, dedupeKey: `trend-followup:${t.id}`, priority: "high" });
    result.followUps++;
  }

  // Pick new stories within the daily and per-run caps; relevance nudges the order.
  const candidates = scored
    .filter((s) => s.candidate && s.trend.status === "new" && !s.trend.alertedAt && s.relevance >= settings.minRelevance)
    .map((s) => ({ id: s.trend.id, url: s.trend.url, heat: Math.round(s.heat * (0.5 + 0.5 * s.relevance)), score: s.score, s }));
  result.candidates = candidates.length;
  const alertedToday = await alertedSince(ws, periodStart(now, ws.config.workspace.timezone, "day"));
  const picks = selectTrendPicks(candidates, { alertedToday, dayCap: settings.dayCap, perRun: settings.perRun });
  for (const p of picks) {
    const filmBy = new Date(now.getTime() + settings.filmWithinHours * 3_600_000);
    await markAlerted(ws, p.id, p.s.velocity, filmBy);
    await enqueueRun(ws, {
      jobId: "research.trend-writer",
      agent: "analyst",
      input: { trendId: p.id },
      dedupeKey: `trend-writer:${p.id}`,
      parentRunId: opts.runId ?? null,
      createdBy: "agent:analyst",
    });
    result.picked.push({ trendId: p.id, title: p.s.trend.title, heat: p.s.heat });
  }
  result.expired = await expireStale(ws, settings.expireAfterHours);

  const failed = result.sources.filter((s) => s.error);
  await progress(
    `Scanned ${result.sources.length - failed.length} trend source${result.sources.length - failed.length === 1 ? "" : "s"} (${result.items} stories)` +
      (result.picked.length ? `; picked ${result.picked.length} stor${result.picked.length === 1 ? "y" : "ies"} for a news reel kit` : "; nothing hot enough to film right now") +
      (result.followUps ? `; ${result.followUps} story still climbing` : "") +
      (failed.length ? `. Couldn't read: ${failed.map((f) => f.id).join(", ")}` : ""),
  );
  return result;
}

export const trendRadarJob = defineNativeJob({
  kind: "native",
  id: "research.trend-radar",
  agent: "analyst",
  description: "Reads your trend sources, measures how fast each story is moving and picks the ones worth filming today.",
  input: z.object({}),
  timeoutMs: 10 * 60_000,
  run: (ctx) => runTrendRadar(ctx.ws, { runId: ctx.runId, progress: (m) => ctx.progress(m) }),
});
