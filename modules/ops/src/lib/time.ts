/**
 * Time-zone helpers built on Intl (no dependencies). Every user-facing time is in the workspace time zone.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function localParts(date: Date, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute!, second: out.second! };
}

/** Offset of `tz` from UTC at `date`, in ms (positive east of UTC). */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight for a local calendar date. Handles DST changes. */
export function localMidnight(year: number, month: number, day: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  const second = guess - tzOffsetMs(new Date(t), tz);
  if (second !== t) t = second;
  return new Date(t);
}

/** [start, end) of the local day containing `now`, shifted by `offsetDays` (-1 = yesterday). */
export function localDayBounds(now: Date, tz: string, offsetDays = 0): { start: Date; end: Date; date: string } {
  const p = localParts(now, tz);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + 1;
  const d = base.getUTCDate();
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    start: localMidnight(y, m, d, tz),
    end: localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz),
    date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  };
}

/** "Tue, Oct 13". */
export function dayLabel(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(now);
}

/** "9:30 AM". */
export function timeLabel(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
}

/** Minutes since local midnight. */
export function localMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** "HH:MM" (or "H:MM") to minutes since midnight; throws on invalid input. */
export function parseHm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`"${value}" is not a time like 21:30`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`"${value}" is not a valid time of day`);
  return h * 60 + min;
}

export function formatHm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
