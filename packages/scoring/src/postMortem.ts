/**
 * Which posts get a post-mortem: every breakout (>= 2x), every flop (< 0.6x) and every new
 * best, wins and losses at the same depth.
 */

export type PostMortemKind = "breakout" | "flop" | "new_best";

export type PostMortemThresholds = { breakoutX: number; flopX: number };

export const DEFAULT_POST_MORTEM_THRESHOLDS: PostMortemThresholds = { breakoutX: 2, flopX: 0.6 };

/** Ordered by importance: a new best is reported as such even when it is also a breakout. */
export function classifyForPostMortem(
  x: number | null | undefined,
  previousBestX: number | null | undefined,
  t: PostMortemThresholds = DEFAULT_POST_MORTEM_THRESHOLDS,
): PostMortemKind | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof previousBestX === "number" && x > previousBestX && x >= 1) return "new_best";
  if (x >= t.breakoutX) return "breakout";
  if (x < t.flopX) return "flop";
  return null;
}
