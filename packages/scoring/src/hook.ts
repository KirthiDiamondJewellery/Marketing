import { round } from "./stats.ts";

/**
 * Hook score for the two hook banks. Explainable on purpose:
 *
 *   score = winRate · evidence · decay
 *   winRate  = (wins + 1) / (uses + 2)           Laplace-smoothed, so an unused hook sits at 0.5
 *   evidence = log2(1 + originX)                  how far the post it came from beat its baseline
 *   decay    = 0.5 ^ (ageDays / halfLifeDays)     competitor hooks only: harvested openers go stale
 */

export type HookScoreInput = {
  uses: number;
  wins: number;
  /** `x` of the post the hook came from; unknown counts as 1 (no evidence either way). */
  originX?: number | null;
  origin: "own" | "competitor" | "manual";
  ageDays?: number;
  halfLifeDays?: number;
};

export function hookScore(input: HookScoreInput): number {
  const uses = Math.max(0, input.uses);
  const wins = Math.min(Math.max(0, input.wins), uses);
  const winRate = (wins + 1) / (uses + 2);
  const originX = typeof input.originX === "number" && input.originX > 0 ? input.originX : 1;
  const evidence = Math.log2(1 + originX);
  const decay = input.origin === "competitor" ? 0.5 ** (Math.max(0, input.ageDays ?? 0) / (input.halfLifeDays ?? 60)) : 1;
  return round(winRate * evidence * decay, 4);
}

/** Own openers that beat the user's median by at least `minX` (default 3) qualify for the own bank. */
export function qualifiesForOwnBank(x: number | null | undefined, minX = 3): boolean {
  return typeof x === "number" && x >= minX;
}

/** A use counts as a win when the post using the hook beat the baseline by `winX` (default 1.5). */
export function isHookWin(x: number | null | undefined, winX = 1.5): boolean {
  return typeof x === "number" && x >= winX;
}
