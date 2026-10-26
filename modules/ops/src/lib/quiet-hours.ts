import { formatHm, localMinutes, parseHm } from "./time.ts";

/**
 * Quiet hours: during the window, normal and low-priority messages wait in the outbox and go out
 * when it ends. High-priority messages (a failed publish, a hot lead) still go out.
 * Windows may wrap past midnight ("21:30"–"07:00"). Equal start and end means no quiet hours.
 */

export type QuietWindow = { start: string; end: string };

export function isQuietHours(now: Date, tz: string, window: QuietWindow | null | undefined): boolean {
  if (!window) return false;
  const start = parseHm(window.start);
  const end = parseHm(window.end);
  if (start === end) return false;
  const m = localMinutes(now, tz);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** When the current quiet window ends, or null when it isn't quiet now. */
export function quietUntil(now: Date, tz: string, window: QuietWindow | null | undefined): Date | null {
  if (!window || !isQuietHours(now, tz, window)) return null;
  const end = parseHm(window.end);
  const m = localMinutes(now, tz);
  const minutes = (end - m + 1440) % 1440 || 1440;
  const t = new Date(now.getTime() + minutes * 60_000);
  t.setUTCSeconds(0, 0);
  return t;
}

export type Priority = "low" | "normal" | "high";

/** True when a message of this priority may be delivered now. */
export function mayDeliver(priority: Priority | undefined, now: Date, tz: string, window: QuietWindow | null | undefined): boolean {
  return priority === "high" || !isQuietHours(now, tz, window);
}

/** Parses user input like "21:30-07:00", "9:30pm to 7am", "off". Returns null for "off". */
export function parseQuietInput(input: string): QuietWindow | null {
  const s = input.trim().toLowerCase();
  if (/^(off|none|disable|disabled|clear)$/.test(s)) return null;
  const m = /^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/.exec(s);
  if (!m) throw new Error('Use a range like "21:30-07:00" or "9:30pm to 7am", or "off".');
  return { start: formatHm(toMinutes(m[1]!)), end: formatHm(toMinutes(m[2]!)) };
}

function toMinutes(raw: string): number {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw.trim());
  if (!m) throw new Error(`"${raw}" is not a time`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  if (m[3]) {
    if (h < 1 || h > 12) throw new Error(`"${raw}" is not a time`);
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  }
  return parseHm(`${h}:${String(min).padStart(2, "0")}`);
}
