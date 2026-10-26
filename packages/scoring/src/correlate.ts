import { isNum, round } from "./stats.ts";

/**
 * Two-metric relationships for the "what moves with what" readout: least-squares fit plus Pearson r. Plain words
 * for the strength, and an explicit small-sample flag, so a correlation over 6 posts reads as a hint, not a law.
 */

export type Fit = {
  n: number;
  slope: number;
  intercept: number;
  r: number;
  r2: number;
  strength: "none" | "weak" | "moderate" | "strong";
  direction: "up" | "down";
  /** Plain-language strength ("Moderate positive link", "No clear link"). */
  words: string;
  /** Fewer than `smallN` (default 10) pairs: read as a hint. */
  small: boolean;
};

export function strengthOf(r: number): Fit["strength"] {
  const a = Math.abs(r);
  if (a < 0.2) return "none";
  if (a < 0.4) return "weak";
  if (a < 0.7) return "moderate";
  return "strong";
}

/** Least squares + Pearson over the pairs where both values are finite. Null when n < 3 or either axis has no variance. */
export function linearFit(xs: readonly (number | null | undefined)[], ys: readonly (number | null | undefined)[], opts: { smallN?: number } = {}): Fit | null {
  const pairs: [number, number][] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (isNum(x) && isNum(y)) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (sxx === 0 || syy === 0) return null;
  const slope = sxy / sxx;
  const r = Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
  const strength = strengthOf(r);
  const direction = r >= 0 ? "up" : "down";
  const words = strength === "none" ? "No clear link" : `${strength[0]!.toUpperCase()}${strength.slice(1)} ${direction === "up" ? "positive" : "negative"} link`;
  return { n, slope: round(slope, 6), intercept: round(my - slope * mx, 6), r: round(r, 3), r2: round(r * r, 3), strength, direction, words, small: n < (opts.smallN ?? 10) };
}

export type Driver = { key: string; fit: Fit };

/**
 * Ranks candidate metrics by |r| against a target metric. Candidates derived from the target (e.g. "saves" when the
 * target is "send rate") must be listed in `exclude` so arithmetic links don't show up as findings.
 */
export function rankDrivers<T>(
  rows: readonly T[],
  target: (row: T) => number | null | undefined,
  candidates: Record<string, (row: T) => number | null | undefined>,
  opts: { minN?: number; exclude?: readonly string[] } = {},
): Driver[] {
  const minN = opts.minN ?? 4;
  const ys = rows.map(target);
  const out: Driver[] = [];
  for (const [key, get] of Object.entries(candidates)) {
    if (opts.exclude?.includes(key)) continue;
    const fit = linearFit(rows.map(get), ys);
    if (fit && fit.n >= minN) out.push({ key, fit });
  }
  return out.sort((a, b) => Math.abs(b.fit.r) - Math.abs(a.fit.r) || a.key.localeCompare(b.key));
}

/** A "nice" 1/2/5 × 10^k step near span/5, for "each +step in X goes with about ±slope·step Y" sentences. */
export function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const m = raw / mag;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * mag;
}
