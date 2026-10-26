import { median, medianCi, round, isNum, clamp } from "./stats.ts";
import { zonedParts } from "./time.ts";

/**
 * Feature attribution for `learn`. For each dimension value: median x, lift vs the overall
 * median, n, and a rank-based (order-statistic) confidence interval for the median. Below `minN` the
 * report prints an explicit GAP line instead of guessing.
 */

export const FEATURE_DIMENSIONS = [
  "hook_pattern", "lane", "format", "angle", "funnel_stage", "cta_type", "length_bucket", "slot", "story_structure",
] as const;
export type FeatureDimension = (typeof FEATURE_DIMENSIONS)[number];

const DIMENSION_LABELS: Record<string, string> = {
  hook_pattern: "hook pattern",
  lane: "lane",
  format: "format",
  angle: "angle",
  funnel_stage: "funnel stage",
  cta_type: "CTA",
  length_bucket: "length",
  slot: "posting slot",
  story_structure: "story structure",
};

export type AttributionRow = { x: number | null | undefined; features: Partial<Record<string, string | null | undefined>> };

export type FeatureStat = {
  dimension: string;
  value: string;
  n: number;
  medianX: number | null;
  /** medianX / overall median. */
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  sufficient: boolean;
  /** The CI excludes the overall median: this value really is better (or worse) than usual. */
  clear: boolean;
  /** The confidence range expressed as lift (ci / overall median). */
  liftLow: number | null;
  liftHigh: number | null;
  /**
   * Plain verdict: "gap" (n < minN), "clear_win"/"clear_loss" (range excludes the normal), "leaning_up"/"leaning_down"
   * (median ≥ 10% off but the range still crosses the normal), "flat" otherwise.
   */
  verdict: FeatureVerdict;
  /** One plain-language report line; starts with "GAP:" when n < minN. */
  line: string;
};

export type FeatureVerdict = "gap" | "clear_win" | "clear_loss" | "leaning_up" | "leaning_down" | "flat";

export type AttributionOptions = {
  minN: number;
  confidence: number;
  dimensions: readonly string[];
  /** What the numbers are ("x" by default); used in report lines. */
  metricLabel: string;
  /** Formats a value of the metric for report lines (default "1.4x"). */
  format: (v: number | null) => string;
};

export function verdictOf(s: { sufficient: boolean; clear: boolean; lift: number | null; ciLow: number | null }, overall: number | null): FeatureVerdict {
  if (!s.sufficient) return "gap";
  if (s.clear && overall !== null && s.ciLow !== null) return s.ciLow > overall ? "clear_win" : "clear_loss";
  if (s.lift !== null && s.lift >= 1.1) return "leaning_up";
  if (s.lift !== null && s.lift <= 0.9) return "leaning_down";
  return "flat";
}

export type AttributionResult = {
  n: number;
  overallMedian: number | null;
  stats: FeatureStat[];
  gaps: string[];
};

const fmtX = (v: number | null) => (v === null ? "n/a" : `${round(v, 2)}x`);

export function featureAttribution(rows: readonly AttributionRow[], opts: Partial<AttributionOptions> = {}): AttributionResult {
  const minN = opts.minN ?? 5;
  const confidence = opts.confidence ?? 0.9;
  const dimensions = opts.dimensions ?? FEATURE_DIMENSIONS;
  const fmt = opts.format ?? fmtX;
  const metricLabel = opts.metricLabel ?? "";
  const scored = rows.filter((r): r is AttributionRow & { x: number } => isNum(r.x));
  const overall = median(scored.map((r) => r.x));
  const stats: FeatureStat[] = [];

  for (const dim of dimensions) {
    const groups = new Map<string, number[]>();
    for (const r of scored) {
      const v = r.features[dim];
      if (v === null || v === undefined || v === "") continue;
      const arr = groups.get(v) ?? [];
      arr.push(r.x);
      groups.set(v, arr);
    }
    for (const [value, xs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const label = `${DIMENSION_LABELS[dim] ?? dim} "${value}"`;
      const sufficient = xs.length >= minN;
      const m = median(xs);
      const lift = m !== null && overall !== null && overall > 0 ? round(m / overall, 3) : null;
      const ci = sufficient ? medianCi(xs, confidence) : null;
      const clear = !!ci && overall !== null && (ci[0] > overall || ci[1] < overall);
      const line = sufficient
        ? `${label}: median ${metricLabel ? `${metricLabel} ` : ""}${fmt(m)} (lift ${lift === null ? "n/a" : `${round(lift, 2)}x`}, n=${xs.length}, ${Math.round(confidence * 100)}% range ${fmt(ci?.[0] ?? null)}–${fmt(ci?.[1] ?? null)})`
        : `GAP: ${label} has ${xs.length} post${xs.length === 1 ? "" : "s"} (need ${minN}). Not enough data to judge yet.`;
      stats.push({
        dimension: dim,
        value,
        n: xs.length,
        medianX: m === null ? null : round(m, 3),
        lift,
        ciLow: ci ? round(ci[0], 3) : null,
        ciHigh: ci ? round(ci[1], 3) : null,
        sufficient,
        clear,
        liftLow: ci && overall !== null && overall > 0 ? round(ci[0] / overall, 3) : null,
        liftHigh: ci && overall !== null && overall > 0 ? round(ci[1] / overall, 3) : null,
        verdict: verdictOf({ sufficient, clear, lift, ciLow: ci ? ci[0] : null }, overall),
        line,
      });
    }
  }
  return { n: scored.length, overallMedian: overall === null ? null : round(overall, 3), stats, gaps: stats.filter((s) => !s.sufficient).map((s) => s.line) };
}

/** Length buckets for short-form video. */
export function lengthBucket(durationS: number | null | undefined): string | null {
  if (typeof durationS !== "number" || durationS <= 0) return null;
  if (durationS < 15) return "0-15s";
  if (durationS < 30) return "15-30s";
  if (durationS < 45) return "30-45s";
  if (durationS < 60) return "45-60s";
  if (durationS < 90) return "60-90s";
  return "90s+";
}

/** Coarse posting slot (day part, local time). Coarse on purpose: fine slots never reach min n. */
export function slotBucket(publishedAt: Date | null | undefined, timeZone = "UTC"): string | null {
  if (!publishedAt) return null;
  const h = zonedParts(publishedAt, timeZone).hour;
  if (h >= 5 && h < 9) return "early-morning";
  if (h >= 9 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

/** Dimension → value → weight. 1 = neutral. */
export type FeatureWeights = Record<string, Record<string, number>>;

export type BlendedWeights = {
  /** Share of the weight that comes from own data (0 = competitor only, 1 = own only). */
  ownShare: number;
  weights: FeatureWeights;
};

/**
 * Blends own and competitor attribution into picker weights: competitor signals dominate until
 * about `fullTrustAt` own posts exist, then own data does. Only sufficient stats move a weight; every weight
 * is clamped to [min, max] so one lucky post can't starve a lane.
 */
export function blendWeights(opts: {
  own: readonly FeatureStat[];
  competitor: readonly FeatureStat[];
  ownPosts: number;
  fullTrustAt?: number;
  min?: number;
  max?: number;
}): BlendedWeights {
  const fullTrustAt = opts.fullTrustAt ?? 20;
  const ownShare = clamp(opts.ownPosts / fullTrustAt, 0, 1);
  const lo = opts.min ?? 0.5;
  const hi = opts.max ?? 2;
  const liftMap = (stats: readonly FeatureStat[]) => {
    const m = new Map<string, number>();
    for (const s of stats) if (s.sufficient && s.lift !== null) m.set(`${s.dimension}\u0000${s.value}`, s.lift);
    return m;
  };
  const own = liftMap(opts.own);
  const comp = liftMap(opts.competitor);
  const weights: FeatureWeights = {};
  for (const key of new Set([...own.keys(), ...comp.keys()])) {
    const [dim, value] = key.split("\u0000") as [string, string];
    const w = ownShare * (own.get(key) ?? 1) + (1 - ownShare) * (comp.get(key) ?? 1);
    (weights[dim] ??= {})[value] = round(clamp(w, lo, hi), 3);
  }
  return { ownShare: round(ownShare, 3), weights };
}

/** Weight of a value, 1 when unknown. */
export function weightOf(weights: FeatureWeights, dimension: string, value: string | null | undefined): number {
  if (!value) return 1;
  return weights[dimension]?.[value] ?? 1;
}
