import { median, quantile } from "@attentionos/scoring";
import { loadFeatureStats } from "../attribution.ts";
import { SCHEDULED_LABELS, SNAPSHOT_SCHEDULE } from "../schedule.ts";
import { HOUR_MS, iso, num, retentionAt, type AnalyticsCtx } from "./ctx.ts";
import { postFacts, whyLines, type PlatformNorms, type PostFact } from "./posts.ts";

/**
 * Everything about one post: its numbers at every capture against the account's usual curve, its retention curve
 * against the usual one, why it did what it did, its funnel and its post-mortems.
 */

export type SeriesPoint = { label: string; hours: number; capturedAt: string | null; views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; follows: number | null; x: number | null };
export type CurvePoint = { label: string; hours: number; median: number | null; low: number | null; high: number | null; n: number };

export type PostDetail = {
  post: PostFact;
  norms: PlatformNorms | null;
  rank: { onPlatform: number; of: number } | null;
  series: SeriesPoint[];
  /** Views at each scheduled capture for the account's other posts on this platform. */
  usualCurve: CurvePoint[];
  retention: { t: number; pct: number }[] | null;
  usualRetention: { t: number; pct: number }[] | null;
  why: string[];
  featureLines: string[];
  /** The same as structured rows: how each of this post's choices usually performs (last 90 days). */
  features: { dimension: string; value: string; n: number; medianX: number | null; lift: number | null; sufficient: boolean; verdict: string }[];
  plan: Record<string, unknown> | null;
  caption: string | null;
  postMortems: { id: string; kind: string; x: number | null; bodyMd: string; lessons: string[]; createdAt: string | null }[];
};

export async function postDetail(ctx: AnalyticsCtx, postId: string, opts: { includeScanned?: boolean } = {}): Promise<PostDetail | null> {
  const facts = await postFacts(ctx, { includeScanned: opts.includeScanned ?? false });
  const post = facts.posts.find((p) => p.postId === postId) ?? facts.posts.find((p) => p.numbersFrom === postId);
  if (!post) return null;
  const peers = facts.posts.filter((p) => p.platform === post.platform && p.postId !== post.postId);

  const rows = await ctx.sql`
    select m.post_id, m.snapshot, m.captured_at, m.views, m.likes, m.comments, m.shares, m.saves, m.follows, m.x_score, p.published_at
      from post_metrics m join posts p on p.id = m.post_id and p.workspace_id = m.workspace_id
     where m.workspace_id = ${ctx.id} and p.platform = ${post.platform} and p.status = 'published'
     order by m.captured_at`;
  const hoursOf = (r: (typeof rows)[number]) => ((r.captured_at as Date).getTime() - (r.published_at as Date).getTime()) / HOUR_MS;
  const series: SeriesPoint[] = rows
    .filter((r) => r.post_id === post.numbersFrom)
    .map((r) => ({
      label: r.snapshot as string, hours: Math.round(hoursOf(r) * 10) / 10, capturedAt: iso(r.captured_at),
      views: num(r.views), likes: num(r.likes), comments: num(r.comments), shares: num(r.shares), saves: num(r.saves), follows: num(r.follows), x: num(r.x_score),
    }));
  const peerIds = new Set(peers.map((p) => p.numbersFrom));
  const usualCurve: CurvePoint[] = SCHEDULED_LABELS.map((label) => {
    const vs = rows.filter((r) => peerIds.has(r.post_id as string) && r.snapshot === label).map((r) => num(r.views));
    const n = vs.filter((v) => v !== null).length;
    return { label, hours: SNAPSHOT_SCHEDULE[label].afterH, median: median(vs), low: n >= 3 ? quantile(vs, 0.25) : null, high: n >= 3 ? quantile(vs, 0.75) : null, n };
  });

  const curves = peers.map((p) => p.retention).filter((c): c is { t: number; pct: number }[] => !!c);
  let usualRetention: { t: number; pct: number }[] | null = null;
  if (curves.length >= 3 && post.retention) {
    usualRetention = post.retention
      .map((pt) => ({ t: pt.t, pct: median(curves.map((c) => retentionAt(c, pt.t))) }))
      .filter((pt): pt is { t: number; pct: number } => pt.pct !== null);
  }

  const featureStats = await loadFeatureStats(ctx, "90d");
  const matching = featureStats.filter((s) => post.features[s.dimension] === s.value);
  const scored = facts.posts.filter((p) => p.platform === post.platform && p.x !== null).sort((a, b) => b.x! - a.x!);
  const idx = scored.findIndex((p) => p.postId === post.postId);

  const [content] = post.contentId
    ? await ctx.sql`select title, kind, lane, pillar, funnel_stage, angle, story_structure, template, hook_pattern, cta_type from content where id = ${post.contentId} and workspace_id = ${ctx.id}`
    : [];
  const [cap] = await ctx.sql`select caption from posts where id = ${post.postId} and workspace_id = ${ctx.id}`;
  const pms = await ctx.sql`
    select id, kind, x_score, body_md, lessons, created_at from post_mortems
     where workspace_id = ${ctx.id} and post_id = any(${[post.postId, post.numbersFrom]}) order by created_at desc`;

  return {
    post,
    norms: facts.norms[post.platform] ?? null,
    rank: idx >= 0 ? { onPlatform: idx + 1, of: scored.length } : null,
    series,
    usualCurve,
    retention: post.retention,
    usualRetention,
    why: whyLines(post, facts.norms[post.platform], featureStats),
    featureLines: matching.map((s) => s.line),
    features: matching.map((s) => ({ dimension: s.dimension, value: s.value, n: s.n, medianX: s.medianX, lift: s.lift, sufficient: s.sufficient, verdict: s.verdict })),
    plan: content ? { ...content } : null,
    caption: (cap?.caption as string | null) ?? post.scan?.caption ?? null,
    postMortems: pms.map((r) => ({
      id: r.id as string, kind: r.kind as string, x: num(r.x_score), bodyMd: r.body_md as string,
      lessons: Array.isArray(r.lessons) ? (r.lessons as unknown[]).map((l) => (typeof l === "string" ? l : String((l as { text?: unknown })?.text ?? ""))).filter(Boolean) : [],
      createdAt: iso(r.created_at),
    })),
  };
}
