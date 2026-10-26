import { Cron } from "croner";

/**
 * Cron expressions from module manifests and config, evaluated in the workspace timezone. Five fields
 * (minute hour day-of-month month day-of-week) or a nickname (@hourly, @daily, @weekly, @monthly, @yearly).
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const NICKNAMES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);

export function parseCron(expr: string, timezone: string): Cron {
  const trimmed = expr.trim();
  if (!NICKNAMES.has(trimmed.toLowerCase())) {
    const fields = trimmed.split(/\s+/).filter(Boolean);
    if (fields.length !== 5) {
      throw new CronError(`"${expr}" isn't a valid schedule. Use 5 fields: minute hour day month weekday (e.g. "0 7 * * 1-5" for 7:00 on weekdays).`);
    }
  }
  try {
    return new Cron(trimmed, { timezone, paused: true });
  } catch (err) {
    throw new CronError(`"${expr}" isn't a valid schedule: ${(err as Error).message}`);
  }
}

export function isValidCron(expr: string, timezone = "UTC"): boolean {
  try {
    parseCron(expr, timezone);
    return true;
  } catch {
    return false;
  }
}

export function nextFire(expr: string, timezone: string, after: Date): Date | null {
  return parseCron(expr, timezone).nextRun(after);
}

/** The most recent fire time in (since, until], or null. Missed older fires are dropped on purpose (no backlog). */
export function latestFire(expr: string, timezone: string, since: Date, until: Date): Date | null {
  const cron = parseCron(expr, timezone);
  let last: Date | null = null;
  let cursor = since;
  for (let i = 0; i < 10_000; i++) {
    const next = cron.nextRun(cursor);
    if (!next || next > until) break;
    last = next;
    cursor = next;
  }
  return last;
}
