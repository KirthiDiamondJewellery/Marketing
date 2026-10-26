import type { WorkspaceContext } from "@attentionos/core";

/**
 * Hook selection weighted by what `learn` measured: pattern weights from feature attribution,
 * with a share of picks (20% by default) spent exploring patterns regardless of weight.
 */

export type HookCandidate = {
  id: string;
  pattern: string;
  origin: "own" | "competitor" | "manual";
  /** Bank score (own: x vs own median; competitor: decayed outlier x). */
  score: number | null;
};

export type HookPick = HookCandidate & { reason: "exploit" | "explore"; weight: number };

/** Small seeded PRNG (mulberry32) so picks are reproducible in tests and audits. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORIGIN_BOOST: Record<HookCandidate["origin"], number> = { own: 1.5, manual: 1.2, competitor: 1 };

function weightedIndex(weights: number[], rng: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/**
 * Picks up to `count` hooks with distinct patterns. Each pick either exploits (pattern weight × bank score ×
 * origin boost) or, with probability `exploration`, explores (uniform over the remaining patterns).
 * Missing pattern weights default to 1, so with no learn data the choice is uniform across patterns.
 */
export function selectHooks(
  candidates: readonly HookCandidate[],
  patternWeights: Readonly<Record<string, number>>,
  opts: { count?: number; exploration?: number; rng?: () => number } = {},
): HookPick[] {
  const count = opts.count ?? 3;
  const exploration = opts.exploration ?? 0.2;
  const rng = opts.rng ?? Math.random;
  const remaining = [...candidates];
  const picks: HookPick[] = [];
  while (picks.length < count && remaining.length > 0) {
    const patterns = [...new Set(remaining.map((c) => c.pattern))].sort();
    const explore = rng() < exploration;
    let pattern: string;
    if (explore) {
      pattern = patterns[Math.floor(rng() * patterns.length)]!;
    } else {
      const w = patterns.map((p) => Math.max(0, patternWeights[p] ?? 1));
      pattern = patterns[weightedIndex(w, rng)]!;
    }
    const inPattern = remaining.filter((c) => c.pattern === pattern);
    const hw = inPattern.map((c) => Math.max(0.1, c.score ?? 1) * ORIGIN_BOOST[c.origin]);
    const chosen = inPattern[weightedIndex(hw, rng)]!;
    picks.push({ ...chosen, reason: explore ? "explore" : "exploit", weight: patternWeights[pattern] ?? 1 });
    for (let i = remaining.length - 1; i >= 0; i--) if (remaining[i]!.pattern === pattern) remaining.splice(i, 1);
  }
  return picks;
}

export type LearnWeightsFn = (ws: WorkspaceContext, dimension: string) => Promise<Record<string, number>>;

/**
 * Loads hook-pattern weights from `@attentionos/module-learn` when that module is installed. Expected export:
 * `getFeatureWeights(ws, dimension) => Promise<Record<value, weight>>`. Falls back to {} (uniform).
 */
export async function loadLearnWeights(ws: WorkspaceContext, dimension = "hook_pattern", importer: (spec: string) => Promise<unknown> = (s) => import(s)): Promise<Record<string, number>> {
  const spec = "@attentionos/module-learn";
  try {
    const mod = (await importer(spec)) as { getFeatureWeights?: LearnWeightsFn; default?: { getFeatureWeights?: LearnWeightsFn } };
    const fn = mod.getFeatureWeights ?? mod.default?.getFeatureWeights;
    if (typeof fn !== "function") return {};
    const weights = await fn(ws, dimension);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(weights ?? {})) if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
