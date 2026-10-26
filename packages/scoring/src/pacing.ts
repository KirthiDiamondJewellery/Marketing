import { clamp, isNum, round } from "./stats.ts";
import { zonedMidnight, zonedParts } from "./time.ts";

/**
 * Goal pacing (north star): target vs actual for the current period and an on-track projection.
 *
 * - Count goals ("leads per week", "revenue per week") accumulate: the projection is today's total plus the expected
 *   rest of the period. The expected daily rate blends this period's run rate with the trailing rate, trusting this
 *   period more as it goes on (so a slow Monday doesn't call the week lost).
 * - Average goals ("follows per post", "skip rate") don't accumulate: the projection is the current value, and
 *   `direction` says whether lower is better (skip rate).
 */

export type PaceStatus = "met" | "on_track" | "at_risk" | "behind" | "no_target" | "no_data";

export type GoalPaceInput = {
  target: number | null;
  /** "sum" accumulates over the period; "average" is a level. */
  kind: "sum" | "average";
  /** "up" when more is better (default), "down" when less is better (skip rate). */
  direction?: "up" | "down";
  periodStart: Date;
  periodEnd: Date;
  now: Date;
  /** Total so far (sum) or current value (average). */
  actual: number | null;
  /** Per-day rate over a trailing window (e.g. last 28 days), used early in the period. */
  trailingDailyRate?: number | null;
  /** At-risk band: projected within this share of the target. Default 0.85. */
  atRiskShare?: number;
};

export type GoalPace = {
  status: PaceStatus;
  target: number | null;
  actual: number | null;
  /** 0–1 of the period that has passed. */
  elapsed: number;
  /** Where a straight line to the target would be today (sum goals). */
  expectedByNow: number | null;
  projected: number | null;
  /** Per day needed for the rest of the period to hit the target (sum goals). */
  requiredPerDay: number | null;
  daysLeft: number;
  /** projected / target (or target / projected for "down" goals): 1 = exactly on target. */
  paceRatio: number | null;
  /** One plain-language line. */
  line: string;
};

const DAY = 86_400_000;
const fmt = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(round(v, 1)));

export function goalPacing(i: GoalPaceInput): GoalPace {
  const span = Math.max(1, i.periodEnd.getTime() - i.periodStart.getTime());
  const elapsed = clamp((i.now.getTime() - i.periodStart.getTime()) / span, 0, 1);
  const daysTotal = span / DAY;
  const daysLeft = round(Math.max(0, (i.periodEnd.getTime() - i.now.getTime()) / DAY), 2);
  const direction = i.direction ?? "up";
  const atRisk = i.atRiskShare ?? 0.85;
  const target = isNum(i.target) ? i.target : null;
  const actual = isNum(i.actual) ? i.actual : null;
  const base = { target, actual, elapsed: round(elapsed, 3), daysLeft };

  if (actual === null) {
    return { ...base, status: "no_data", expectedByNow: null, projected: null, requiredPerDay: null, paceRatio: null, line: "Not measured yet this period." };
  }

  let projected: number;
  let expectedByNow: number | null = null;
  let requiredPerDay: number | null = null;
  if (i.kind === "sum") {
    const daysElapsed = Math.max(elapsed * daysTotal, 1 / 24);
    const runRate = actual / daysElapsed;
    const trailing = isNum(i.trailingDailyRate) ? i.trailingDailyRate : null;
    const rate = trailing === null ? runRate : elapsed * runRate + (1 - elapsed) * trailing;
    projected = round(actual + rate * daysLeft, 2);
    if (target !== null) {
      expectedByNow = round(target * elapsed, 2);
      requiredPerDay = daysLeft > 0 ? round(Math.max(0, target - actual) / daysLeft, 3) : null;
    }
  } else {
    projected = actual;
  }

  if (target === null) {
    return { ...base, status: "no_target", expectedByNow, projected, requiredPerDay, paceRatio: null, line: `Projected ${fmt(projected)} this period. Set a target to track pace.` };
  }

  const better = (a: number, b: number) => (direction === "up" ? a >= b : a <= b);
  const paceRatio = direction === "up" ? (target === 0 ? null : round(projected / target, 3)) : projected === 0 ? null : round(target / projected, 3);
  let status: PaceStatus;
  if (i.kind === "sum" && direction === "up" && actual >= target) status = "met";
  else if (i.kind === "average" && better(actual, target)) status = "met";
  else if (better(projected, target)) status = "on_track";
  else if (paceRatio !== null && paceRatio >= atRisk) status = "at_risk";
  else status = "behind";

  let line: string;
  if (i.kind === "sum") {
    line = status === "met"
      ? `Goal met: ${fmt(actual)} of ${fmt(target)}.`
      : `${fmt(actual)} of ${fmt(target)} so far; on pace for about ${fmt(projected)}${status === "on_track" ? "" : daysLeft >= 1 && requiredPerDay !== null ? `. Needs ${fmt(requiredPerDay)} a day to hit it` : daysLeft > 0 ? `. Needs ${fmt(Math.max(0, target - actual))} more before the period ends` : ""}.`;
  } else {
    line = status === "met"
      ? `At ${fmt(actual)}, ${direction === "up" ? "at or above" : "at or under"} the ${fmt(target)} target.`
      : `At ${fmt(actual)} against a target of ${fmt(target)} (${direction === "up" ? "higher" : "lower"} is better).`;
  }
  return { ...base, status, expectedByNow, projected, requiredPerDay, paceRatio, line };
}

/** The calendar week (Monday 00:00 to the next Monday, in `timeZone`) that contains `now`. */
export function localWeek(now: Date, timeZone = "UTC"): { start: Date; end: Date } {
  const p = zonedParts(now, timeZone);
  const back = (p.weekday + 6) % 7;
  const start = zonedMidnight(p.year, p.month, p.day - back, timeZone);
  const end = zonedMidnight(p.year, p.month, p.day - back + 7, timeZone);
  return { start, end };
}

/** The calendar month containing `now`, in `timeZone`. */
export function localMonth(now: Date, timeZone = "UTC"): { start: Date; end: Date } {
  const p = zonedParts(now, timeZone);
  return { start: zonedMidnight(p.year, p.month, 1, timeZone), end: zonedMidnight(p.year, p.month + 1, 1, timeZone) };
}
