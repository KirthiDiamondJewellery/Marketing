/** Time helpers for the Edit page: post times are shown and picked in the workspace's time zone. */

function parts(t: number, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

function offset(t: number, tz: string): number {
  const p = parts(t, tz);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - t;
}

/** "2026-10-14T09:00" in the given zone → ISO string (UTC). */
export function zonedToIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let t = guess - offset(guess, tz);
  t = guess - offset(t, tz);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function fmt(t: number, tz: string): string {
  const p = parts(t, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour! % 24)}:${pad(p.minute!)}`;
}

/** Now, as a datetime-local value in the zone (the picker's minimum). */
export function localNow(tz: string): string {
  return fmt(Date.now(), tz);
}

/** Tomorrow at 9am in the zone, the picker's starting value. */
export function defaultPickTime(tz: string): string {
  const tomorrow = fmt(Date.now() + 86_400_000, tz);
  return `${tomorrow.slice(0, 10)}T09:00`;
}

/** "Thu 9:00 AM", or "Next open slot" when the time isn't planned yet. */
export function slotTime(iso: string | null, tz: string): string {
  if (!iso) return "Next open slot";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: tz })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}`;
}

/** "America/New_York" → "New York". */
export function tzCity(tz: string): string {
  return (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}
