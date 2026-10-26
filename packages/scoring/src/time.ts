/** Time helpers shared by the scorers. */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export type DateLike = Date | string | number;

export function toDate(v: DateLike | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

/** Calendar parts of `date` in an IANA time zone. */
export function zonedParts(date: Date, timeZone = "UTC"): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday ?? "Sun"),
  };
}

/** Day of the year (1–366) of `date` in `timeZone`. */
export function dayOfYear(date: Date, timeZone = "UTC"): number {
  const { year, month, day } = zonedParts(date, timeZone);
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function localDay(date: Date, timeZone = "UTC"): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Days left in the calendar month of `date` (in `timeZone`), counting today. */
export function daysLeftInMonth(date: Date, timeZone = "UTC"): number {
  const { year, month, day } = zonedParts(date, timeZone);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return daysInMonth - day + 1;
}

/** The UTC instant of local midnight on a calendar day in `timeZone` (day/month may overflow, like Date.UTC). */
export function zonedMidnight(year: number, month: number, day: number, timeZone = "UTC"): Date {
  const guess = new Date(Date.UTC(year, month - 1, day));
  // Offset of the zone at that instant, applied twice so a DST change on that day still lands on local midnight.
  let t = guess.getTime();
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), timeZone);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    t = guess.getTime() - (wall - t);
  }
  return new Date(t);
}
