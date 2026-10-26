import { dayOfYear } from "./time.ts";

/**
 * Daily creator rotation: scan a window of `perDay` creators each day, moving the window by
 * day of year and wrapping around the list, so scraping cost stays flat however long the list grows.
 * Budget-aware: when the remaining monthly budget can't cover `perDay` creators every remaining day,
 * today's window shrinks to what is affordable.
 */

export type RotationBudget = {
  /** Budget left this period, USD. */
  remainingUsd: number;
  /** Estimated cost to scan one creator, USD. 0 = free (no cap). */
  costPerItemUsd: number;
  /** Days left in the period, counting today. */
  daysLeft: number;
};

export type RotationResult<T> = {
  picked: T[];
  /** How many were picked after the budget cap. */
  count: number;
  /** Where today's window starts in the list. */
  start: number;
  /** Set when the budget shrank today's window. */
  limitedBy?: "budget";
};

export function affordablePerDay(budget: RotationBudget): number {
  if (budget.costPerItemUsd <= 0) return Number.POSITIVE_INFINITY;
  if (budget.remainingUsd <= 0) return 0;
  return Math.floor(budget.remainingUsd / Math.max(1, budget.daysLeft) / budget.costPerItemUsd);
}

export function dailyRotation<T>(
  items: readonly T[],
  opts: { date: Date; perDay: number; timeZone?: string; budget?: RotationBudget },
): RotationResult<T> {
  const len = items.length;
  if (len === 0 || opts.perDay <= 0) return { picked: [], count: 0, start: 0 };
  const perDay = Math.min(opts.perDay, len);
  const doy = dayOfYear(opts.date, opts.timeZone ?? "UTC");
  // The window position uses the configured size so it doesn't jump around when the budget cap changes.
  const start = (doy * perDay) % len;
  const cap = opts.budget ? affordablePerDay(opts.budget) : Number.POSITIVE_INFINITY;
  const count = Math.min(perDay, cap);
  const picked: T[] = [];
  for (let i = 0; i < count; i++) picked.push(items[(start + i) % len]!);
  return { picked, count, start, ...(count < perDay ? { limitedBy: "budget" as const } : {}) };
}
