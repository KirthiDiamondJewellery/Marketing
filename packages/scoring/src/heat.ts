import { clamp, round } from "./stats.ts";
import { hoursBetween } from "./time.ts";
import { canonicalUrl } from "./text.ts";

/**
 * Trend heat: "how fast is this spreading right now".
 *
 * - engagement: a per-source blend of counters (HN points + half the comments, Reddit score + comments, …).
 * - velocity:   engagement gained per hour. Between two snapshots at least 45 min apart it is the RECENT
 *               rate (a story still climbing beats one coasting on its total); otherwise the lifetime
 *               average (engagement / age).
 * - score:      velocity / per-source bar. A story is a candidate when score >= 1, it is fresh, and it
 *               clears the absolute floor (so a 10-minute-old post with 50 points can't win on rate alone).
 * - heat 0–100: 25·log10(1 + velocity·weight) on a log scale, plus a small-account bonus (points per
 *               follower vs a 2% par, -8..+12), times an age decay. Feeds with no counters (RSS, Google
 *               News) score on freshness plus coverage (how many feeds carry the same story).
 */

export const HEAT_SOURCE_KINDS = ["rss", "google_news", "hn", "reddit", "github", "x_apify"] as const;
export type HeatSourceKind = (typeof HEAT_SOURCE_KINDS)[number];

export type HeatSourceConfig = {
  /** Engagement-per-hour equivalence between sources (one HN point is worth more than one X like). */
  weight: number;
  /** Velocity (per hour) that makes score = 1. */
  bar: number;
  /** Minimum total engagement before velocity counts. */
  floor: number;
  /** Older than this the item is not a candidate. */
  maxAgeHours: number;
  /** Multipliers applied once an item is older than `hours` (highest matching wins). */
  decay: { hours: number; factor: number }[];
};

const NEWS_DECAY = [{ hours: 24, factor: 0.85 }, { hours: 36, factor: 0.7 }, { hours: 72, factor: 0.5 }];

export const DEFAULT_HEAT_CONFIG: Record<HeatSourceKind, HeatSourceConfig> = {
  hn: { weight: 15, bar: 40, floor: 150, maxAgeHours: 36, decay: NEWS_DECAY },
  reddit: { weight: 1, bar: 60, floor: 300, maxAgeHours: 36, decay: NEWS_DECAY },
  // Repos climb for days, so GitHub fades late and keeps a week-long window.
  github: { weight: 4, bar: 8, floor: 200, maxAgeHours: 24 * 7, decay: [{ hours: 96, factor: 0.7 }] },
  x_apify: { weight: 1, bar: 400, floor: 800, maxAgeHours: 24, decay: NEWS_DECAY },
  // Feeds without counters: score = coverage·sourceWeight / bar, heat from freshness + coverage.
  rss: { weight: 1, bar: 1, floor: 0, maxAgeHours: 48, decay: NEWS_DECAY },
  google_news: { weight: 1, bar: 1, floor: 0, maxAgeHours: 48, decay: NEWS_DECAY },
};

export type HeatCounters = {
  points?: number | null;
  comments?: number | null;
  followers?: number | null;
  /** Position in the source's own ranking (1 = top), used when a feed exposes no counters. */
  rank?: number | null;
};

export type HeatInput = HeatCounters & {
  kind: HeatSourceKind;
  publishedAt: Date | null;
  now: Date;
  previous?: (HeatCounters & { capturedAt: Date }) | null;
  /** Weight of this source from `sources.yaml` (default 1). */
  sourceWeight?: number;
  /** Distinct sources carrying the same story (default 1). */
  coverage?: number;
  config?: Partial<Record<HeatSourceKind, Partial<HeatSourceConfig>>>;
};

export type HeatResult = {
  engagement: number;
  velocity: number;
  score: number;
  heat: number;
  fresh: boolean;
  floorMet: boolean;
  /** fresh && floorMet && score >= 1 */
  candidate: boolean;
};

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function heatConfigFor(kind: HeatSourceKind, overrides?: HeatInput["config"]): HeatSourceConfig {
  return { ...DEFAULT_HEAT_CONFIG[kind], ...(overrides?.[kind] ?? {}) };
}

export function engagementOf(kind: HeatSourceKind, c: HeatCounters): number {
  switch (kind) {
    case "hn":
      return n(c.points) + 0.5 * n(c.comments);
    case "github":
      return n(c.points);
    case "x_apify":
    case "reddit":
      return n(c.points) + n(c.comments);
    default:
      return n(c.points) + n(c.comments);
  }
}

/** Engagement per hour: the recent rate between snapshots when they are >= 45 min apart, else lifetime. */
export function velocityOf(opts: { engagement: number; publishedAt: Date | null; now: Date; previousEngagement?: number | null; previousAt?: Date | null }): number {
  const { engagement, publishedAt, now, previousEngagement, previousAt } = opts;
  if (previousAt && typeof previousEngagement === "number") {
    const gapH = hoursBetween(previousAt, now);
    if (gapH >= 0.75) return Math.max(0, (engagement - previousEngagement) / gapH);
  }
  if (!publishedAt) return 0;
  const ageH = Math.max(0.5, hoursBetween(publishedAt, now));
  return engagement / ageH;
}

function ageFactor(cfg: HeatSourceConfig, ageH: number | null): number {
  if (ageH === null) return 1;
  let f = 1;
  for (const step of [...cfg.decay].sort((a, b) => a.hours - b.hours)) if (ageH > step.hours) f = step.factor;
  return f;
}

export function computeHeat(input: HeatInput): HeatResult {
  const cfg = heatConfigFor(input.kind, input.config);
  const sourceWeight = input.sourceWeight ?? 1;
  const coverage = Math.max(1, input.coverage ?? 1);
  const ageH = input.publishedAt ? Math.max(0, hoursBetween(input.publishedAt, input.now)) : null;
  const fresh = ageH === null ? true : ageH <= cfg.maxAgeHours;
  const engagement = engagementOf(input.kind, input);
  const hasCounters = typeof input.points === "number" || typeof input.comments === "number";

  let velocity = 0;
  let score: number;
  let heat: number;
  let floorMet: boolean;

  if (!hasCounters) {
    floorMet = true;
    if (typeof input.rank === "number") {
      // Ranked feeds without scores (Reddit RSS): the top of today's list is hot, the tail is warm.
      heat = Math.max(30, 74 - 4 * (input.rank - 1));
      score = input.rank <= 10 ? (sourceWeight * coverage) / cfg.bar : 0;
    } else {
      // Plain feeds: fresh items start warm; each extra outlet carrying the story adds heat.
      heat = 40 + Math.min(30, 12 * Math.log2(coverage));
      score = (sourceWeight * coverage) / cfg.bar;
    }
  } else {
    const prevEng = input.previous ? engagementOf(input.kind, input.previous) : null;
    velocity = velocityOf({ engagement, publishedAt: input.publishedAt, now: input.now, previousEngagement: prevEng, previousAt: input.previous?.capturedAt ?? null });
    floorMet = engagement >= cfg.floor;
    score = (velocity * sourceWeight) / cfg.bar;
    heat = 25 * Math.log10(1 + Math.max(0, velocity) * cfg.weight * sourceWeight);
    if (typeof input.followers === "number" && n(input.points) > 0) {
      // Points per follower against a 2% par: a post out-running its account gains up to 12,
      // a mega account's routine post loses up to 8.
      const ratio = n(input.points) / Math.max(500, input.followers);
      heat += clamp(4 * Math.log10(ratio / 0.02), -8, 12);
    }
    if (coverage > 1) heat += Math.min(10, 5 * Math.log2(coverage));
  }

  heat = Math.round(clamp(heat * ageFactor(cfg, ageH), 0, 100));
  score = round(score, 3);
  return { engagement, velocity: round(velocity, 3), score, heat, fresh, floorMet, candidate: fresh && floorMet && score >= 1 };
}

export type RadarCandidate = { id: string; url: string; heat: number; score: number };

export type PickOptions = {
  /** Most new trend kits per day. Default 6. */
  dayCap: number;
  /** Most new trend kits per run. Default 1. */
  perRun: number;
  /** Kits already produced today. */
  alertedToday: number;
};

export const DEFAULT_PICK_OPTIONS: Omit<PickOptions, "alertedToday"> = { dayCap: 6, perRun: 1 };

/** Candidates sorted by heat, one per canonical URL, capped by the per-run and daily caps. */
export function selectTrendPicks<T extends RadarCandidate>(candidates: readonly T[], opts: Partial<PickOptions> & { alertedToday: number }): T[] {
  const dayCap = opts.dayCap ?? DEFAULT_PICK_OPTIONS.dayCap;
  const perRun = opts.perRun ?? DEFAULT_PICK_OPTIONS.perRun;
  const slots = Math.max(0, Math.min(perRun, dayCap - opts.alertedToday));
  if (slots === 0) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of [...candidates].sort((a, b) => b.heat - a.heat || b.score - a.score || a.id.localeCompare(b.id))) {
    const key = canonicalUrl(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= slots) break;
  }
  return out;
}

/** A follow-up is due once, when a story we already sent has at least doubled its velocity. */
export function shouldFollowUp(opts: { alertedVelocity: number | null | undefined; velocity: number; alreadyFollowedUp: boolean; factor?: number }): boolean {
  if (opts.alreadyFollowedUp) return false;
  if (typeof opts.alertedVelocity !== "number" || opts.alertedVelocity <= 0) return false;
  return opts.velocity >= (opts.factor ?? 2) * opts.alertedVelocity;
}

/** "1.2k/h" style label for velocity. */
export function velocityLabel(v: number | null | undefined): string {
  if (!v || v < 1) return "under 1/h";
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k/h`;
  return `${Math.round(v)}/h`;
}
