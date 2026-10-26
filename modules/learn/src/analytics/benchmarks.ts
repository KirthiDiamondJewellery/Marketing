import type { Platform } from "@attentionos/core";
import { benchmarks, type Benchmarks } from "@attentionos/scoring";
import { DAY_MS, iso, num, type AnalyticsCtx } from "./ctx.ts";
import type { PostFact } from "./posts.ts";

/**
 * Competitor benchmarks, per platform: your median post against each tracked creator's median, how often each side
 * produces outliers, and the creators' recent outliers (what to study next). Your own scanned posts (the `own`
 * tracked creator) are you, never a peer; pass them in through `own` (postFacts with `includeScanned`).
 */

export type CompetitorOutlier = {
  id: string;
  handle: string;
  platform: string;
  url: string;
  publishedAt: string | null;
  views: number | null;
  comments: number | null;
  x: number | null;
  hook: string | null;
  format: string | null;
  durationS: number | null;
};

export type PlatformBenchmark = Benchmarks & { platform: Platform; outliers: CompetitorOutlier[] };

export async function competitorBenchmarks(ctx: AnalyticsCtx, own: readonly PostFact[], opts: { days?: number; outlierDays?: number } = {}): Promise<PlatformBenchmark[]> {
  const days = opts.days ?? 90;
  const since = new Date(ctx.now().getTime() - days * DAY_MS);
  const rows = await ctx.sql`
    select e.id, e.platform, e.author_handle, e.url, e.published_at, e.views, e.likes, e.comments, e.x_score, e.is_outlier, e.is_pinned,
           e.spoken_hook, e.caption, e.duration_s, e.tags, tc.handle as creator_handle
      from external_posts e left join tracked_creators tc on tc.id = e.tracked_creator_id and tc.workspace_id = e.workspace_id
     where e.workspace_id = ${ctx.id} and not e.is_meme and not e.is_pinned and (e.published_at is null or e.published_at >= ${since})
       and (tc.tier is null or tc.tier <> 'own')
     order by e.published_at desc nulls last`;
  const platforms = [...new Set(rows.map((r) => r.platform as Platform))];
  const ownSince = ctx.now().getTime() - days * DAY_MS;
  const out: PlatformBenchmark[] = [];
  for (const platform of platforms) {
    const theirs = rows.filter((r) => r.platform === platform);
    const byCreator = new Map<string, typeof theirs>();
    for (const r of theirs) {
      const k = ((r.creator_handle as string | null) ?? (r.author_handle as string)).replace(/^@/, "");
      byCreator.set(k, [...(byCreator.get(k) ?? []), r]);
    }
    const mine = own.filter((p) => p.platform === platform && p.settled && Date.parse(p.publishedAt) >= ownSince && p.data !== "none");
    const b = benchmarks(
      mine.map((p) => ({ views: p.views, likes: p.likes, comments: p.comments, x: p.x })),
      [...byCreator.entries()].map(([handle, posts]) => ({
        key: handle, label: `@${handle}`,
        posts: posts.map((r) => ({ views: num(r.views), likes: num(r.likes), comments: num(r.comments), x: num(r.x_score) })),
      })),
    );
    const outlierSince = ctx.now().getTime() - (opts.outlierDays ?? 30) * DAY_MS;
    const outliers = theirs
      .filter((r) => r.is_outlier && (!r.published_at || (r.published_at as Date).getTime() >= outlierSince))
      .sort((a, c) => (num(c.x_score) ?? 0) - (num(a.x_score) ?? 0))
      .slice(0, 8)
      .map((r): CompetitorOutlier => {
        const tags = (r.tags as Record<string, unknown> | null) ?? {};
        return {
          id: r.id as string, handle: `@${String(r.author_handle).replace(/^@/, "")}`, platform: r.platform as string, url: r.url as string,
          publishedAt: iso(r.published_at), views: num(r.views), comments: num(r.comments), x: num(r.x_score),
          hook: (r.spoken_hook as string | null) ?? (r.caption ? String(r.caption).split("\n")[0]!.slice(0, 140) : null),
          format: typeof tags.format === "string" ? tags.format : null, durationS: num(r.duration_s),
        };
      });
    out.push({ ...b, platform, outliers });
  }
  // The platform with the most of your own posts first.
  return out.sort((a, c) => c.own.n - a.own.n || c.peers.length - a.peers.length);
}
