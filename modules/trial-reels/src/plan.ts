/**
 * The deterministic parts of scheduling a day of trial reels (no database, no clock of its own):
 * - posting order: take turns between reels, so copies of one video never post back to back;
 * - slots: evenly spaced across the window in the workspace timezone, first at the start, last at the end;
 * - the rolling 24-hour cap, counting every other post on the account;
 * - the owner's-words rule for titles: alternates may only reorder the owner's own title words.
 *
 * The looks of each variation (speed, colour, caption and title style, hashtags) are planned and rendered by
 * media-py (`trial-plan` / `trial-render`).
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export type Layout = "talking-head" | "split-screen";

/** Where the text goes, as fractions of the frame height (centre of the text). */
export const LAYOUTS: Record<Layout, { titleX: "left" | "center"; titleY: number; titleSeconds: number | null; captionY: number; label: string }> = {
  // Title above the head for the whole video, captions in the middle of the lower half.
  "talking-head": { titleX: "center", titleY: 0.17, titleSeconds: null, captionY: 0.6, label: "Talking head" },
  // Screen recording on top: title in the top bar for the first seconds, captions where the screen meets the speaker.
  "split-screen": { titleX: "left", titleY: 0.115, titleSeconds: 3.5, captionY: 0.46, label: "Split screen" },
};

/** Round-robin across reels so copies of the same video never post back to back. Keeps each reel's own order. */
export function interleave<T extends { reel: string }>(variants: readonly T[]): T[] {
  const byReel = new Map<string, T[]>();
  for (const v of variants) {
    const q = byReel.get(v.reel) ?? [];
    q.push(v);
    byReel.set(v.reel, q);
  }
  const queues = [...byReel.values()];
  const longest = Math.max(0, ...queues.map((q) => q.length));
  const out: T[] = [];
  for (let i = 0; i < longest; i++) for (const q of queues) if (i < q.length) out.push(q[i]!);
  return out;
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Local wall-clock time in a timezone → the instant. Handles DST. */
export function zonedToUtc(localDate: string, localTime: string, timeZone: string): Date {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const [hh, mm] = localTime.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetMs(new Date(guess), timeZone);
  ts = guess - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Local calendar date YYYY-MM-DD of an instant. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `count` evenly spaced instants between the window's start and end on `date` (local), rounded to the minute. */
export function slots(date: string, count: number, window: { start: string; end: string }, timeZone: string): Date[] {
  if (count <= 0) return [];
  const start = zonedToUtc(date, window.start, timeZone).getTime();
  const end = zonedToUtc(date, window.end, timeZone).getTime();
  const step = count === 1 ? 0 : (end - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => new Date(Math.round((start + step * i) / 60_000) * 60_000));
}

/** The most posts that fall inside any 24-hour window (sliding), for a sorted or unsorted list of instants. */
export function busiest24h(times: readonly Date[]): number {
  const t = times.map((d) => d.getTime()).sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < t.length; hi++) {
    while (t[hi]! - t[lo]! >= DAY_MS) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

/**
 * How many of the day's trial reels fit under the rolling cap: the largest n ≤ wanted such that spreading n posts
 * over the window keeps every 24-hour span at or under `cap`, counting the account's other posts.
 */
export function fitUnderCap(opts: { wanted: number; existing: readonly Date[]; cap: number; slotsFor: (n: number) => Date[] }): number {
  for (let n = opts.wanted; n > 0; n--) {
    if (busiest24h([...opts.existing, ...opts.slotsFor(n)]) <= opts.cap) return n;
  }
  return 0;
}

const CONNECTORS = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "your", "my", "with", "how", "why", "this", "it", "is", "you", "i"]);
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s'-]+/gu, " ").split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, "")).filter(Boolean);

/**
 * The owner's words only: an alternate title may reorder, drop or re-case the owner's own title words, plus a few
 * connecting words ("the", "your", "and"…). Returns the words that aren't the owner's, empty when the title passes.
 */
export function foreignTitleWords(ownerTitle: string, alternate: string): string[] {
  const own = new Set(words(ownerTitle));
  return [...new Set(words(alternate).filter((w) => !own.has(w) && !CONNECTORS.has(w)))];
}

/** Hashtags as bare words, de-duplicated (case-insensitive), in order. */
export function cleanHashtags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags.flatMap((t) => t.split(/[\s,]+/))) {
    const t = raw.trim().replace(/^#+/, "");
    if (!t || !/^[\p{L}\p{N}_]{1,60}$/u.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** Hashtags already in a caption ("#tips #howto"), without the #. */
export function hashtagsIn(caption: string | null | undefined): string[] {
  return cleanHashtags(caption?.match(/#[\p{L}\p{N}_]+/gu) ?? []);
}

/** A short slug for a reel ("pricing-myths"), unique within the batch. */
export function slugFor(title: string, taken: ReadonlySet<string>): string {
  const base = words(title).filter((w) => !CONNECTORS.has(w)).slice(0, 3).join("-").replace(/[^a-z0-9-]/g, "").slice(0, 24).replace(/-+$/, "") || "reel";
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

/** Split the day's total evenly; any remainder goes to the first reels (matches media-py's plan). */
export function splitTotal(total: number, reels: number): number[] {
  const base = Math.floor(total / reels);
  const extra = total % reels;
  return Array.from({ length: reels }, (_, i) => base + (i < extra ? 1 : 0));
}
