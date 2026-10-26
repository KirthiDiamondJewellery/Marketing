/**
 * Shared formatting for the work surfaces (calendar, studio, research, inbox, insights, brand kit).
 * Pure functions: safe in server and client components. Times always render in the workspace timezone.
 */

export const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  x: "X",
  threads: "Threads",
};

export const platformLabel = (p: string | null | undefined) => (p ? (PLATFORM_LABEL[p] ?? humanize(p)) : "");

export const FUNNEL_LABEL: Record<string, string> = {
  tofu: "Top of funnel",
  mofu: "Middle of funnel",
  bofu: "Bottom of funnel",
};

/** "contrarian_claim" → "Contrarian claim", "cost-reality" → "Cost reality". */
export function humanize(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

export function fmtCompact(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "–";
  const v = Number(n);
  if (!Number.isFinite(v)) return "–";
  return Math.abs(v) < 10_000 ? whole.format(v) : compact.format(v);
}

export function fmtInt(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "–";
  return whole.format(Number(n));
}

/** 3.4 → "3.4×" (two decimals under 1×, so 0.45× stays readable). */
export function fmtX(x: number | string | null | undefined): string {
  if (x === null || x === undefined || x === "") return "–";
  const v = Number(x);
  if (!Number.isFinite(v)) return "–";
  return `${v < 1 ? v.toFixed(2) : v.toFixed(1)}×`;
}

export function fmtUsd(n: number, opts: { cents?: boolean } = {}): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.cents === false ? 0 : 2,
    maximumFractionDigits: opts.cents === false ? 0 : 2,
  }).format(n);
}

export function fmtPct(n: number | string | null | undefined, digits = 0): string {
  if (n === null || n === undefined || n === "") return "–";
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

export function fmtDuration(s: number | string | null | undefined): string {
  if (s === null || s === undefined || s === "") return "–";
  const v = Math.round(Number(s));
  const m = Math.floor(v / 60);
  return m ? `${m}:${String(v % 60).padStart(2, "0")}` : `${v}s`;
}

// ---------------------------------------------------------------------------------------------------------------
// Dates in the workspace timezone
// ---------------------------------------------------------------------------------------------------------------

export type ZonedParts = { y: number; m: number; d: number; h: number; mi: number; weekday: number };

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in `tz` (month 1–12, weekday 0 = Sunday). */
export function zonedParts(date: Date | string, tz: string): ZonedParts {
  const d = typeof date === "string" ? new Date(date) : date;
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(d)) out[p.type] = p.value;
  return {
    y: Number(out.year),
    m: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour) % 24,
    mi: Number(out.minute),
    weekday: WEEKDAYS[out.weekday ?? "Sun"] ?? 0,
  };
}

/** The instant whose wall clock in `tz` reads y-m-d h:mi. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(t), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    const diff = asUtc - guess;
    if (diff === 0) break;
    t -= diff;
  }
  return new Date(t);
}

/** YYYY-MM-DD for the wall-clock day of an instant in `tz`. */
export function dayKey(date: Date | string, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function parseDayKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}

/** Adds whole days to a YYYY-MM-DD key (calendar math, no timezone involved). */
export function addDays(key: string, n: number): string {
  const { y, m, d } = parseDayKey(key);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function weekdayOf(key: string): number {
  const { y, m, d } = parseDayKey(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the week containing `key`. */
export function startOfWeek(key: string): string {
  const wd = weekdayOf(key);
  return addDays(key, wd === 0 ? -6 : 1 - wd);
}

export function fmtDate(date: Date | string | null | undefined, tz: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  if (!date) return "–";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(typeof date === "string" ? new Date(date) : date);
}

export function fmtTime(date: Date | string | null | undefined, tz: string): string {
  if (!date) return "–";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(typeof date === "string" ? new Date(date) : date);
}

/** "Fri, Oct 17, 11:00 AM" */
export function fmtDateTime(date: Date | string | null | undefined, tz: string): string {
  if (!date) return "–";
  return `${fmtDate(date, tz)}, ${fmtTime(date, tz)}`;
}

/** "Friday, 11:00 AM" (the reschedule toast). */
export function fmtWeekdayTime(date: Date | string, tz: string): string {
  return `${fmtDate(date, tz, { weekday: "long" })}, ${fmtTime(date, tz)}`;
}

/** "12 min ago", "in 3 hours", "2 days ago". */
export function fmtRelative(date: Date | string | null | undefined, now: Date = new Date()): string {
  if (!date) return "–";
  const t = typeof date === "string" ? new Date(date) : date;
  const diff = t.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  let s: string;
  if (abs < 60_000) return future ? "in a moment" : "just now";
  if (abs < 3_600_000) s = unit(Math.round(abs / 60_000), "min").replace("mins", "min");
  else if (abs < 86_400_000) s = unit(Math.round(abs / 3_600_000), "hour");
  else if (abs < 30 * 86_400_000) s = unit(Math.round(abs / 86_400_000), "day");
  else s = unit(Math.round(abs / (30 * 86_400_000)), "month");
  return future ? `in ${s}` : `${s} ago`;
}

export function firstLine(text: string | null | undefined, max = 80): string {
  if (!text) return "";
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Strip a leading "@" so handles never render as "@@name". */
export const handle = (h: string | null | undefined) => (h ? `@${h.replace(/^@+/, "")}` : "");
