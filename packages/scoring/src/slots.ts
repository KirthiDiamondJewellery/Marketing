import { isNum, median, medianCi, round } from "./stats.ts";
import { toDate, zonedParts, type DateLike } from "./time.ts";

/**
 * Best posting slots: a day × time-block heatmap of how posts did against the account's own normal.
 *
 * Raw cell medians from 1–2 posts are noise, so every cell also carries a shrunk estimate that pulls small cells
 * toward the account's overall median (empirical-Bayes style: `(n·median + k·overall) / (n + k)`), an evidence
 * level from its sample size, and a rank-based confidence range once it reaches `minN`. "Best slots" only ever
 * lists cells with enough posts; the rest are reported as gaps.
 */

/** Monday-first, the way people plan a week. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export type SlotEvidence = "none" | "low" | "medium" | "high";

export type SlotCell = {
  /** 0 = Monday … 6 = Sunday. */
  day: number;
  block: number;
  startHour: number;
  endHour: number;
  n: number;
  medianX: number | null;
  /** Median pulled toward the overall median by `priorN` pseudo-posts. */
  shrunkX: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  evidence: SlotEvidence;
};

export type SlotMarginal = { key: number; label: string; n: number; medianX: number | null; shrunkX: number | null; evidence: SlotEvidence };

export type SlotHeatmap = {
  blockHours: number;
  timeZone: string;
  n: number;
  overallMedian: number | null;
  cells: SlotCell[];
  byDay: SlotMarginal[];
  byBlock: SlotMarginal[];
  /** Up to three cells with at least `minN` posts, best shrunk estimate first. */
  best: SlotCell[];
  /** One plain sentence per thin area, e.g. "GAP: no posts on weekends yet." */
  gaps: string[];
};

export type SlotOptions = { timeZone?: string; blockHours?: 1 | 2 | 3 | 4 | 6; minN?: number; priorN?: number; confidence?: number };

export function evidenceFor(n: number, minN: number): SlotEvidence {
  if (n === 0) return "none";
  if (n < minN) return "low";
  if (n < minN * 2) return "medium";
  return "high";
}

export function shrink(med: number | null, n: number, overall: number | null, priorN: number): number | null {
  if (med === null) return null;
  if (overall === null || priorN <= 0) return med;
  return round((n * med + priorN * overall) / (n + priorN), 3);
}

const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 || h === 24 ? "am" : "pm"}`;
export const blockLabel = (start: number, end: number) => `${hourLabel(start)}–${hourLabel(end)}`;

export function slotHeatmap(rows: readonly { publishedAt: DateLike | null | undefined; x: number | null | undefined }[], opts: SlotOptions = {}): SlotHeatmap {
  const timeZone = opts.timeZone ?? "UTC";
  const blockHours = opts.blockHours ?? 3;
  const minN = opts.minN ?? 3;
  const priorN = opts.priorN ?? 3;
  const confidence = opts.confidence ?? 0.9;
  const blocks = 24 / blockHours;

  const grid: number[][][] = Array.from({ length: 7 }, () => Array.from({ length: blocks }, () => []));
  const all: number[] = [];
  for (const r of rows) {
    const d = toDate(r.publishedAt);
    if (!d || !isNum(r.x)) continue;
    const p = zonedParts(d, timeZone);
    const day = (p.weekday + 6) % 7;
    grid[day]![Math.floor(p.hour / blockHours)]!.push(r.x);
    all.push(r.x);
  }
  const overall = median(all);

  const cells: SlotCell[] = [];
  for (let day = 0; day < 7; day++) {
    for (let block = 0; block < blocks; block++) {
      const xs = grid[day]![block]!;
      const m = median(xs);
      const ci = xs.length >= minN ? medianCi(xs, confidence) : null;
      cells.push({
        day, block, startHour: block * blockHours, endHour: (block + 1) * blockHours, n: xs.length,
        medianX: m === null ? null : round(m, 3), shrunkX: shrink(m, xs.length, overall, priorN),
        ciLow: ci ? round(ci[0], 3) : null, ciHigh: ci ? round(ci[1], 3) : null,
        evidence: evidenceFor(xs.length, minN),
      });
    }
  }

  const marginal = (xs: number[], key: number, label: string): SlotMarginal => {
    const m = median(xs);
    return { key, label, n: xs.length, medianX: m === null ? null : round(m, 3), shrunkX: shrink(m, xs.length, overall, priorN), evidence: evidenceFor(xs.length, minN) };
  };
  const byDay = WEEKDAYS.map((label, day) => marginal(grid[day]!.flat(), day, label));
  const byBlock = Array.from({ length: blocks }, (_, b) => marginal(grid.flatMap((d) => d[b]!), b, blockLabel(b * blockHours, (b + 1) * blockHours)));

  const best = cells
    .filter((c) => c.n >= minN && c.shrunkX !== null)
    .sort((a, b) => b.shrunkX! - a.shrunkX! || b.n - a.n)
    .slice(0, 3);

  const gaps: string[] = [];
  if (all.length === 0) gaps.push("GAP: no measured posts yet, so there is nothing to compare posting times with.");
  else {
    const sampled = cells.filter((c) => c.n > 0).length;
    if (!best.length) gaps.push(`GAP: no time slot has ${minN} posts yet (${all.length} measured post${all.length === 1 ? "" : "s"} across ${sampled} slot${sampled === 1 ? "" : "s"}). Spread posts out to learn more.`);
    const emptyDays = byDay.filter((d) => d.n === 0).map((d) => d.label);
    if (emptyDays.length && emptyDays.length < 7) gaps.push(`GAP: no posts on ${emptyDays.join(", ")} yet.`);
  }
  return { blockHours, timeZone, n: all.length, overallMedian: overall === null ? null : round(overall, 3), cells, byDay, byBlock, best, gaps };
}
