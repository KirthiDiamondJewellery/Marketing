/** Small, dependency-free statistics helpers. Every function is pure and deterministic. */

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Median of the finite numbers in `values`; null when there are none. */
export function median(values: readonly (number | null | undefined)[]): number | null {
  const xs = values.filter(isNum).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/** Linear-interpolated quantile (q in [0, 1]) of finite numbers; null when empty. */
export function quantile(values: readonly (number | null | undefined)[], q: number): number | null {
  const xs = values.filter(isNum).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pos = Math.min(1, Math.max(0, q)) * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (pos - lo);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const round = (v: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** P(X <= k) for X ~ Binomial(n, 1/2). */
function binomHalfCdf(n: number, k: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  // log-space to stay exact enough for n in the thousands
  let logC = 0; // log C(n, 0)
  let sum = 0;
  const logHalfN = n * Math.log(0.5);
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC + logHalfN);
  }
  return Math.min(1, sum);
}

/**
 * Distribution-free confidence interval for the median using order statistics (the sign-test interval).
 * Returns [lo, hi] at AT LEAST `confidence` coverage. With very small samples the interval widens to
 * [min, max], which is the honest answer.
 */
export function medianCi(values: readonly (number | null | undefined)[], confidence = 0.9): [number, number] | null {
  const xs = values.filter(isNum).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return null;
  const alphaHalf = (1 - confidence) / 2;
  // Largest r (1-based) such that P(B <= r - 1) <= alpha/2; interval is [x_(r), x_(n - r + 1)].
  let r = 0;
  for (let cand = 1; cand <= Math.ceil(n / 2); cand++) {
    if (binomHalfCdf(n, cand - 1) <= alphaHalf) r = cand;
    else break;
  }
  if (r === 0) return [xs[0]!, xs[n - 1]!];
  return [xs[r - 1]!, xs[n - r]!];
}

/** FNV-1a 32-bit hash; used to derive deterministic seeds from strings such as a date plus workspace id. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32) returning floats in [0, 1). Same seed, same sequence. */
export function seededRandom(seed: number | string): () => number {
  let a = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks one option. With probability `explore` the pick is uniform (exploration); otherwise it is
 * proportional to weight (exploitation). Options with weight <= 0 are only reachable by exploration.
 */
export function pickWeighted<T extends { weight: number }>(options: readonly T[], rand: () => number, explore = 0.2): T | undefined {
  if (options.length === 0) return undefined;
  if (rand() < explore) return options[Math.floor(rand() * options.length)];
  const total = options.reduce((s, o) => s + Math.max(0, o.weight), 0);
  if (total <= 0) return options[Math.floor(rand() * options.length)];
  let r = rand() * total;
  for (const o of options) {
    r -= Math.max(0, o.weight);
    if (r < 0) return o;
  }
  return options[options.length - 1];
}
