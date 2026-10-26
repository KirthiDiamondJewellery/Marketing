import { isNum, round } from "./stats.ts";
import { toDate, type DateLike } from "./time.ts";

/**
 * Business attribution: post → clicks → leads → bookings → revenue, keyed on `utm_content`.
 *
 * - A tag resolves to a post by exact `utm_content` (the same tag goes on every platform of a piece, so
 *   `utm_source` picks the platform), else by its trailing post number (`…_42`).
 * - First touch: when events carry a visitor id, each visitor's outcomes are credited to the tag of their first
 *   tagged event. Events without a visitor id are credited to their own tag.
 * - Leads are de-duplicated by email (one person signing up twice is one lead).
 */

export const FUNNEL_KINDS = ["click", "lead", "booking", "sale"] as const;
export type FunnelKind = (typeof FUNNEL_KINDS)[number];

export type FunnelEvent = {
  kind: FunnelKind;
  at: DateLike;
  utmContent?: string | null;
  utmSource?: string | null;
  visitorId?: string | null;
  email?: string | null;
  valueUsd?: number | null;
};

export type FunnelPostKey = { postId: string; platform: string; utmContent: string | null; publishedAt: DateLike | null };

export type FunnelCounts = { clicks: number; leads: number; bookings: number; sales: number; revenue: number };

export type FunnelAttribution = {
  byPost: Map<string, FunnelCounts>;
  /** Tagged events whose tag matches no post, by tag. */
  unmatched: Map<string, FunnelCounts>;
  /** Events with no tag at all (direct, bio link without a tag, …). */
  untagged: FunnelCounts;
  totals: FunnelCounts;
};

export const emptyCounts = (): FunnelCounts => ({ clicks: 0, leads: 0, bookings: 0, sales: 0, revenue: 0 });

const tagNumber = (tag: string) => /_(\d+)$/.exec(tag)?.[1] ?? null;
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Builds a resolver from a tag (+ optional platform) to a post id. */
export function utmResolver(posts: readonly FunnelPostKey[]): (utmContent: string | null | undefined, utmSource?: string | null) => string | null {
  const byTag = new Map<string, FunnelPostKey[]>();
  const byNumber = new Map<string, FunnelPostKey[]>();
  const sorted = [...posts].sort((a, b) => (toDate(a.publishedAt)?.getTime() ?? Infinity) - (toDate(b.publishedAt)?.getTime() ?? Infinity));
  for (const p of sorted) {
    if (!p.utmContent) continue;
    const t = norm(p.utmContent);
    byTag.set(t, [...(byTag.get(t) ?? []), p]);
    const n = tagNumber(t);
    if (n) byNumber.set(n, [...(byNumber.get(n) ?? []), p]);
  }
  return (utm, source) => {
    const t = norm(utm);
    if (!t) return null;
    const candidates = byTag.get(t) ?? (tagNumber(t) ? byNumber.get(tagNumber(t)!) : undefined);
    if (!candidates?.length) return null;
    const s = norm(source);
    return (s ? candidates.find((c) => norm(c.platform) === s) : undefined)?.postId ?? candidates[0]!.postId;
  };
}

function add(c: FunnelCounts, e: FunnelEvent): void {
  if (e.kind === "click") c.clicks++;
  else if (e.kind === "lead") c.leads++;
  else if (e.kind === "booking") c.bookings++;
  else if (e.kind === "sale") {
    c.sales++;
    if (isNum(e.valueUsd) && e.valueUsd > 0) c.revenue = round(c.revenue + e.valueUsd, 2);
  }
}

export function attributeFunnel(events: readonly FunnelEvent[], posts: readonly FunnelPostKey[]): FunnelAttribution {
  const resolve = utmResolver(posts);
  const ordered = [...events].sort((a, b) => (toDate(a.at)?.getTime() ?? 0) - (toDate(b.at)?.getTime() ?? 0));
  // First touch per visitor.
  const firstTouch = new Map<string, { utm: string; source: string | null }>();
  for (const e of ordered) {
    if (e.visitorId && e.utmContent && !firstTouch.has(e.visitorId)) firstTouch.set(e.visitorId, { utm: e.utmContent, source: e.utmSource ?? null });
  }
  const seenLeads = new Set<string>();
  const out: FunnelAttribution = { byPost: new Map(), unmatched: new Map(), untagged: emptyCounts(), totals: emptyCounts() };
  for (const e of ordered) {
    if (e.kind === "lead" && e.email) {
      const key = norm(e.email);
      if (seenLeads.has(key)) continue;
      seenLeads.add(key);
    }
    const touch = e.visitorId ? firstTouch.get(e.visitorId) : undefined;
    const utm = touch?.utm ?? e.utmContent ?? null;
    const source = touch?.source ?? e.utmSource ?? null;
    add(out.totals, e);
    if (!utm) {
      add(out.untagged, e);
      continue;
    }
    const postId = resolve(utm, source);
    const map = postId ? out.byPost : out.unmatched;
    const key = postId ?? norm(utm);
    const c = map.get(key) ?? emptyCounts();
    add(c, e);
    map.set(key, c);
  }
  return out;
}

export type FunnelStep = { key: string; label: string; value: number | null; fromPrevious: number | null; fromTop: number | null };

/** Step-by-step conversion with "% of previous" and "% of top"; the biggest relative drop is flagged by the caller. */
export function funnelSteps(steps: readonly { key: string; label: string; value: number | null }[]): FunnelStep[] {
  const top = steps.find((s) => isNum(s.value) && s.value > 0)?.value ?? null;
  return steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1]!.value : null;
    return {
      ...s,
      fromPrevious: isNum(s.value) && isNum(prev) && prev > 0 ? round(s.value / prev, 4) : null,
      fromTop: isNum(s.value) && isNum(top) && top > 0 ? round(s.value / top, 5) : null,
    };
  });
}

/** The step that loses the largest share of the people who reached the step before it. */
export function biggestDrop(steps: readonly FunnelStep[]): FunnelStep | null {
  let worst: FunnelStep | null = null;
  for (const s of steps.slice(1)) if (s.fromPrevious !== null && (worst === null || s.fromPrevious < worst.fromPrevious!)) worst = s;
  return worst;
}
