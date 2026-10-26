import type { Platform } from "@attentionos/core";
import {
  collapseVariants, computeBaseline, lengthBucket, resolveRule, scorePost, slotBucket,
  type Baseline, type PostSample,
} from "@attentionos/scoring";
import { aosOf, iso, num, type AnalyticsCtx } from "./analytics/ctx.ts";

/**
 * Own-post scoring: every post's `x` against the user's own rolling baseline, per platform, using
 * the same weights as competitor scoring. The "settled" number for a post is its 7d snapshot, else 72h, else
 * the latest capture. Metrics that only arrive through another capture (skip rate and retention from a CSV
 * import, for example) are filled in from the most recent capture that has them.
 *
 * Trial variants (posts with `variant_of`) are collapsed into their main post: the group is represented by its
 * best variant by views, as a whole record, and carries the variant count.
 *
 * Opt-in (`includeScanned`): the owner's posts that setup read off their public account (`external_posts` under the
 * `own` tracked creator) join in as `source: "scan"` rows, so analytics has real numbers from the first day, before
 * any post goes out through AttentionOS or an analytics provider is connected. A scanned post that is also a
 * published post (same platform id or the same post URL) is dropped: the published row and its captures win.
 */

export type OwnPostScore = {
  /** A `posts` id, or an `external_posts` id for a scanned post. */
  postId: string;
  /** "published": a `posts` row with `post_metrics` captures. "scan": read off the public account (setup's import). */
  source: "published" | "scan";
  /** Scanned posts only: what the scan saw. */
  scan: ScanInfo | null;
  contentId: string | null;
  socialAccountId: string | null;
  title: string | null;
  platform: Platform;
  publishedAt: string;
  url: string | null;
  utmContent: string | null;
  /** Posts in the trial-variant group this one represents (1 = no variants). */
  variants: number;
  /** The variant whose numbers represent the group (differs from postId when a trial variant won). */
  numbersFrom: string;
  metricsId: number | null;
  snapshot: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  follows: number | null;
  profileVisits: number | null;
  leads: number | null;
  skipRate: number | null;
  completionRate: number | null;
  avgWatchS: number | null;
  clicks: number | null;
  durationS: number | null;
  /** Views at the 24h capture (the velocity input). */
  earlyViews: number | null;
  retention: { t: number; pct: number }[] | null;
  lastCapturedAt: string | null;
  x: number | null;
  /** True once the number comes from a 72h or later snapshot, or the post is older than 72h. */
  settled: boolean;
  features: Record<string, string | null>;
};

export type ScanInfo = { handle: string; caption: string | null; spokenHook: string | null; thumbnailUrl: string | null; transcribed: boolean; scannedAt: string };

export type OwnPostRow = Omit<OwnPostScore, "x">;

/** True when the row carries numbers: a metrics capture, or the counts a scan read. */
export const hasNumbers = (r: Pick<OwnPostScore, "metricsId" | "source">): boolean => r.metricsId !== null || r.source === "scan";
export type OwnScores = { posts: OwnPostScore[]; baselines: Partial<Record<Platform, Baseline>> };

type MetricRow = {
  id: number; postId: string; snapshot: string; capturedAt: Date; raw: unknown;
  views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
  follows: number | null; profileVisits: number | null; avgWatchS: number | null; skipRate: number | null; completionRate: number | null; leads: number | null;
};

const MERGE_FIELDS = ["views", "reach", "likes", "comments", "shares", "saves", "follows", "profileVisits", "avgWatchS", "skipRate", "completionRate", "leads"] as const;
const SETTLE_RANK: Record<string, number> = { "7d": 0, "72h": 1 };

/** Every metrics row for the workspace's published posts, newest first per post. */
async function loadMetricRows(ctx: AnalyticsCtx, postIds: string[]): Promise<Map<string, MetricRow[]>> {
  const out = new Map<string, MetricRow[]>();
  if (!postIds.length) return out;
  const rows = await ctx.sql`
    select id, post_id, snapshot, captured_at, raw, views, reach, likes, comments, shares, saves, follows, profile_visits,
           avg_watch_time_s, skip_rate, completion_rate, leads
      from post_metrics
     where workspace_id = ${ctx.id} and post_id = any(${postIds})
     order by post_id, captured_at desc, id desc`;
  for (const r of rows) {
    const m: MetricRow = {
      id: Number(r.id), postId: r.post_id as string, snapshot: r.snapshot as string, capturedAt: r.captured_at as Date, raw: r.raw,
      views: num(r.views), reach: num(r.reach), likes: num(r.likes), comments: num(r.comments), shares: num(r.shares), saves: num(r.saves),
      follows: num(r.follows), profileVisits: num(r.profile_visits), avgWatchS: num(r.avg_watch_time_s), skipRate: num(r.skip_rate),
      completionRate: num(r.completion_rate), leads: num(r.leads),
    };
    out.set(m.postId, [...(out.get(m.postId) ?? []), m]);
  }
  return out;
}

export async function loadOwnPosts(ctx: AnalyticsCtx, opts: { sinceDays?: number; includeScanned?: boolean } = {}): Promise<OwnPostRow[]> {
  const since = opts.sinceDays ? new Date(ctx.now().getTime() - opts.sinceDays * 86_400_000) : new Date(0);
  const rows = await ctx.sql`
    select p.id, p.content_id, p.social_account_id, p.platform, p.published_at, p.url, p.payload, p.caption, p.utm_content, p.variant_of,
           c.title, c.lane, c.hook_pattern, c.template, c.angle, c.funnel_stage, c.cta_type, c.story_structure
      from posts p
      left join content c on c.id = p.content_id and c.workspace_id = p.workspace_id
     where p.workspace_id = ${ctx.id} and p.status = 'published'
       and p.published_at is not null and p.published_at >= ${since}
     order by p.published_at`;
  const metrics = await loadMetricRows(ctx, rows.map((r) => r.id as string));
  const tz = ctx.config.workspace.timezone;
  const now = ctx.now().getTime();

  const built = rows.map((r) => {
    const publishedAt = r.published_at as Date;
    const all = metrics.get(r.id as string) ?? [];
    const settledRow = [...all].sort((a, b) => (SETTLE_RANK[a.snapshot] ?? 2) - (SETTLE_RANK[b.snapshot] ?? 2) || b.capturedAt.getTime() - a.capturedAt.getTime())[0] ?? null;
    const merged = Object.fromEntries(MERGE_FIELDS.map((f) => [f, settledRow?.[f] ?? all.find((m) => m[f] !== null)?.[f] ?? null])) as Record<(typeof MERGE_FIELDS)[number], number | null>;
    const early = all.find((m) => m.snapshot === "24h")
      ?? all.find((m) => {
        const h = (m.capturedAt.getTime() - publishedAt.getTime()) / 3_600_000;
        return m.snapshot === "latest" && h >= 18 && h <= 30;
      });
    const aosRows = all.map((m) => aosOf(m.raw));
    const durationS = num((settledRow?.raw as Record<string, unknown> | null)?.durationS)
      ?? num((r.payload as Record<string, unknown> | null)?.durationS)
      ?? all.map((m) => num((m.raw as Record<string, unknown> | null)?.durationS)).find((v) => v !== null) ?? null;
    const snapshot = settledRow?.snapshot ?? null;
    const caption = (r.caption as string | null) ?? null;
    return {
      variantOf: (r.variant_of as string | null) ?? null,
      row: {
        postId: r.id as string,
        source: "published" as const,
        scan: null,
        contentId: (r.content_id as string | null) ?? null,
        socialAccountId: (r.social_account_id as string | null) ?? null,
        title: (r.title as string | null) ?? (caption ? caption.split("\n")[0]!.slice(0, 90) : null),
        platform: r.platform as Platform,
        publishedAt: publishedAt.toISOString(),
        url: (r.url as string | null) ?? null,
        utmContent: (r.utm_content as string | null) ?? null,
        variants: 1,
        numbersFrom: r.id as string,
        metricsId: settledRow?.id ?? null,
        snapshot,
        ...merged,
        clicks: aosRows.find((a) => a.clicks !== undefined)?.clicks ?? null,
        durationS,
        earlyViews: early?.views ?? null,
        retention: aosRows.find((a) => a.retention)?.retention ?? null,
        lastCapturedAt: iso(all[0]?.capturedAt),
        settled: snapshot === "7d" || snapshot === "72h" || snapshot === "30d" || now - publishedAt.getTime() >= 72 * 3_600_000,
        features: {
          hook_pattern: (r.hook_pattern as string | null) ?? null,
          lane: (r.lane as string | null) ?? null,
          format: (r.template as string | null) ?? null,
          angle: (r.angle as string | null) ?? null,
          funnel_stage: (r.funnel_stage as string | null) ?? null,
          cta_type: (r.cta_type as string | null) ?? null,
          story_structure: (r.story_structure as string | null) ?? null,
          length_bucket: lengthBucket(durationS),
          slot: slotBucket(publishedAt, tz),
        },
      } satisfies OwnPostRow,
    };
  });

  // Trial variants: the group keeps the main post's identity and plan, and the best variant's numbers.
  const mainIds = new Set(built.map((b) => b.row.postId));
  const groups = collapseVariants(built, (b) => (b.variantOf && mainIds.has(b.variantOf) ? b.variantOf : b.row.postId), (b) => (b.row.metricsId === null ? null : (b.row.views ?? 0)));
  const published = groups
    .map(({ row: best, variants, members }) => {
      const main = members.find((m) => !m.variantOf || !mainIds.has(m.variantOf)) ?? best;
      if (best === main) return { ...main.row, variants };
      const b = best.row;
      return {
        ...main.row,
        variants,
        numbersFrom: b.postId,
        metricsId: b.metricsId, snapshot: b.snapshot, views: b.views, reach: b.reach, likes: b.likes, comments: b.comments, shares: b.shares,
        saves: b.saves, follows: b.follows, profileVisits: b.profileVisits, leads: b.leads, skipRate: b.skipRate, completionRate: b.completionRate,
        avgWatchS: b.avgWatchS, clicks: b.clicks, durationS: b.durationS ?? main.row.durationS, earlyViews: b.earlyViews, retention: b.retention,
        lastCapturedAt: b.lastCapturedAt, settled: b.settled,
      };
    });
  const scanned = opts.includeScanned ? await loadScannedOwnPosts(ctx, since) : [];
  return [...published, ...scanned].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

/**
 * The platform's own id for a post, read from its URL (Instagram shortcode, TikTok video id, YouTube video id), else
 * the URL without query or trailing slash. Lets a scanned post and a published post of the same video match even
 * when the two sources name it differently.
 */
export function postUrlKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  const ig = /instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(u);
  if (ig) return ig[1]!;
  const tt = /tiktok\.com\/.*\/(?:video|photo)\/(\d+)/i.exec(u);
  if (tt) return tt[1]!;
  const yt = /(?:youtube\.com\/(?:shorts\/|watch\?(?:.*&)?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i.exec(u);
  if (yt) return yt[1]!;
  return u.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase() || null;
}

/** The owner's scanned posts (setup's import), minus any that are already published posts. */
async function loadScannedOwnPosts(ctx: AnalyticsCtx, since: Date): Promise<OwnPostRow[]> {
  const rows = await ctx.sql`
    select e.id, e.platform, e.platform_post_id, e.url, e.published_at, e.caption, e.duration_s, e.views, e.likes, e.comments, e.shares,
           e.thumbnail_url, e.spoken_hook, e.transcript is not null as transcribed, e.tags, e.last_updated_at, tc.handle
      from external_posts e
      join tracked_creators tc on tc.id = e.tracked_creator_id and tc.workspace_id = e.workspace_id
     where e.workspace_id = ${ctx.id} and tc.tier = 'own' and e.published_at is not null and e.published_at >= ${since}
     order by e.published_at`;
  if (!rows.length) return [];
  const pub = await ctx.sql`select platform, platform_post_id, url from posts where workspace_id = ${ctx.id} and status = 'published'`;
  const known = new Set<string>();
  for (const p of pub) {
    if (p.platform_post_id) known.add(`${p.platform as string}:${p.platform_post_id as string}`);
    const k = postUrlKey(p.url as string | null);
    if (k) known.add(`${p.platform as string}:${k}`);
  }
  const tz = ctx.config.workspace.timezone;
  const now = ctx.now().getTime();
  const out: OwnPostRow[] = [];
  for (const r of rows) {
    const platform = r.platform as Platform;
    const urlKey = postUrlKey(r.url as string);
    if (known.has(`${platform}:${r.platform_post_id as string}`) || (urlKey && known.has(`${platform}:${urlKey}`))) continue;
    const publishedAt = r.published_at as Date;
    const caption = (r.caption as string | null) ?? null;
    const spokenHook = (r.spoken_hook as string | null) ?? null;
    const durationS = num(r.duration_s);
    const tags = (r.tags as Record<string, unknown> | null) ?? {};
    const firstLine = (t: string | null) => (t ? t.trim().split("\n")[0]!.slice(0, 90) || null : null);
    out.push({
      postId: r.id as string,
      source: "scan",
      scan: {
        handle: String(r.handle).replace(/^@+/, ""),
        caption,
        spokenHook,
        thumbnailUrl: (r.thumbnail_url as string | null) ?? null,
        transcribed: Boolean(r.transcribed),
        scannedAt: iso(r.last_updated_at) ?? publishedAt.toISOString(),
      },
      contentId: null,
      socialAccountId: null,
      title: firstLine(caption) ?? firstLine(spokenHook),
      platform,
      publishedAt: publishedAt.toISOString(),
      url: r.url as string,
      utmContent: null,
      variants: 1,
      numbersFrom: r.id as string,
      metricsId: null,
      snapshot: "scan",
      views: num(r.views),
      reach: null,
      likes: num(r.likes),
      comments: num(r.comments),
      shares: num(r.shares),
      saves: null,
      follows: null,
      profileVisits: null,
      leads: null,
      skipRate: null,
      completionRate: null,
      avgWatchS: null,
      clicks: null,
      durationS,
      earlyViews: null,
      retention: null,
      lastCapturedAt: iso(r.last_updated_at),
      // A scan reads a post's running total; past 3 days that total is as settled as a 72h capture.
      settled: now - publishedAt.getTime() >= 72 * 3_600_000,
      features: {
        hook_pattern: null,
        lane: null,
        format: typeof tags.format === "string" ? tags.format : null,
        angle: null,
        funnel_stage: null,
        cta_type: null,
        story_structure: null,
        length_bucket: lengthBucket(durationS),
        slot: slotBucket(publishedAt, tz),
      },
    });
  }
  return out;
}

/** Scores loaded posts against per-platform own baselines. Pure. */
export function scoreOwnPosts(rows: readonly OwnPostRow[], now: Date, minPosts = 5): OwnScores {
  const baselines: Partial<Record<Platform, Baseline>> = {};
  const sample = (r: OwnPostRow): PostSample => ({
    publishedAt: r.publishedAt, durationS: r.durationS, views: r.views, likes: r.likes, comments: r.comments, shares: r.shares,
  });
  for (const platform of new Set(rows.map((r) => r.platform))) {
    // Own memes still count toward the user's normal: they are part of what the account posts.
    baselines[platform] = computeBaseline(rows.filter((r) => r.platform === platform && hasNumbers(r)).map(sample), now, { minPosts, excludeMemes: false });
  }
  const posts = rows.map((r) => {
    if (!hasNumbers(r)) return { ...r, x: null };
    const rule = resolveRule(r.platform);
    return { ...r, x: scorePost(sample(r), baselines[r.platform] ?? null, { ...rule, floors: {}, memeMaxS: 0 }).x };
  });
  return { posts, baselines };
}

export async function computeOwnScores(ctx: AnalyticsCtx, opts: { sinceDays?: number; persist?: boolean; includeScanned?: boolean } = {}): Promise<OwnScores> {
  // Baselines always use the full history; the window only filters what is returned.
  const all = scoreOwnPosts(await loadOwnPosts(ctx, { includeScanned: opts.includeScanned ?? false }), ctx.now());
  if (opts.persist !== false) {
    for (const p of all.posts) {
      if (p.metricsId !== null && p.x !== null) await ctx.sql`update post_metrics set x_score = ${p.x} where workspace_id = ${ctx.id} and id = ${p.metricsId}`;
    }
  }
  if (!opts.sinceDays) return all;
  const since = ctx.now().getTime() - opts.sinceDays * 86_400_000;
  return { ...all, posts: all.posts.filter((p) => new Date(p.publishedAt).getTime() >= since) };
}

export const lastCapture = async (ctx: AnalyticsCtx) => {
  const [r] = await ctx.sql`select max(captured_at) as at from post_metrics where workspace_id = ${ctx.id}`;
  return iso(r?.at);
};
