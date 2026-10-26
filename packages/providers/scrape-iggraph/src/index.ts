import { z } from "zod";
import {
  ProviderError,
  type AttentionOSConfig, type ExternalPost, type Logger, type OwnAnalytics, type PostMetricsSnapshot, type ProviderHealth, type Scraper,
} from "@attentionos/core";
import { requestJson, type FetchLike } from "@attentionos/provider-shared";

/**
 * Instagram Graph API (https://developers.facebook.com/docs/instagram-platform).
 *
 * - Scraper: `business_discovery` reads PUBLIC professional (business/creator) accounts through your own
 *   IG professional account: GET /{IG_USER_ID}?fields=business_discovery.username(<handle>){…media…}.
 *   It is the official, terms-safe fallback to Apify; personal accounts can't be read this way.
 * - OwnAnalytics: your own media list (GET /{IG_USER_ID}/media) plus per-media insights
 *   (GET /{media-id}/insights) for full-history backfill.
 *
 * Secrets: IG_ACCESS_TOKEN, IG_USER_ID. Optional: IG_GRAPH_HOST (default graph.facebook.com, which
 * business_discovery requires), IG_GRAPH_VERSION (default v23.0).
 * Cost: free (rate limited per app and user).
 */

export const PROVIDER_ID = "iggraph";

const MEDIA_FIELDS_FULL = "id,caption,media_type,media_product_type,like_count,comments_count,view_count,timestamp,permalink,thumbnail_url,media_url";
const MEDIA_FIELDS_NO_VIEWS = "id,caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink,thumbnail_url,media_url";
const OWN_MEDIA_FIELDS = "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,thumbnail_url";
const REEL_METRICS = "views,reach,saved,shares,total_interactions,ig_reels_avg_watch_time";
const FEED_METRICS = "views,reach,saved,shares,total_interactions,follows,profile_visits";
const FALLBACK_METRICS = "reach,saved";

const count = z.number().int().nonnegative().optional().catch(undefined);

export const graphMediaSchema = z.object({
  id: z.string(),
  caption: z.string().optional().catch(undefined),
  media_type: z.string().optional().catch(undefined),
  media_product_type: z.string().optional().catch(undefined),
  like_count: count,
  comments_count: count,
  view_count: count,
  timestamp: z.string(),
  permalink: z.string().optional().catch(undefined),
  thumbnail_url: z.string().optional().catch(undefined),
  media_url: z.string().optional().catch(undefined),
});
export type GraphMedia = z.output<typeof graphMediaSchema>;

const pagingSchema = z.object({ next: z.string().optional(), cursors: z.object({ after: z.string().optional() }).optional() }).optional();

const businessDiscoverySchema = z.object({
  business_discovery: z.object({
    username: z.string().optional(),
    followers_count: z.number().optional(),
    media_count: z.number().optional(),
    media: z.object({ data: z.array(z.unknown()).default([]), paging: pagingSchema }).optional(),
  }),
});

const insightsSchema = z.object({
  data: z.array(z.object({ name: z.string(), values: z.array(z.object({ value: z.unknown() })).optional(), total_value: z.object({ value: z.unknown() }).optional() })).default([]),
});

export const isVideo = (m: GraphMedia) => m.media_product_type === "REELS" || m.media_type === "VIDEO";

/** business_discovery media → ExternalPost. Duration isn't exposed by the Graph API. */
export function mediaToExternalPost(m: GraphMedia, handle: string): ExternalPost {
  return dropUndefined<ExternalPost>({
    platform: "instagram",
    platformPostId: m.id,
    authorHandle: handle.replace(/^@/, ""),
    url: m.permalink ?? `https://www.instagram.com/p/${m.id}/`,
    publishedAt: new Date(m.timestamp).toISOString(),
    caption: m.caption,
    views: m.view_count,
    likes: m.like_count,
    comments: m.comments_count,
    videoUrl: isVideo(m) ? m.media_url : undefined,
    thumbnailUrl: m.thumbnail_url ?? (isVideo(m) ? undefined : m.media_url),
  });
}

function dropUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** Insights response → metric name → number. Handles both `values[0].value` and `total_value.value`. */
export function parseInsights(raw: unknown): Record<string, number> {
  const parsed = insightsSchema.safeParse(raw);
  if (!parsed.success) return {};
  const out: Record<string, number> = {};
  for (const e of parsed.data.data) {
    const v = e.total_value?.value ?? e.values?.[0]?.value;
    if (typeof v === "number" && Number.isFinite(v)) out[e.name] = v;
  }
  return out;
}

export function toSnapshot(m: GraphMedia, insights: Record<string, number>, capturedAt: string): PostMetricsSnapshot {
  const avgMs = insights["ig_reels_avg_watch_time"];
  return dropUndefined<PostMetricsSnapshot>({
    platformPostId: m.id,
    platform: "instagram",
    capturedAt,
    url: m.permalink,
    publishedAt: new Date(m.timestamp).toISOString(),
    caption: m.caption,
    views: insights["views"] ?? m.view_count,
    reach: insights["reach"],
    likes: m.like_count,
    comments: m.comments_count,
    shares: insights["shares"],
    saves: insights["saved"],
    follows: insights["follows"],
    profileVisits: insights["profile_visits"],
    avgWatchTimeS: typeof avgMs === "number" ? avgMs / 1000 : undefined,
    raw: { media_type: m.media_type, media_product_type: m.media_product_type, insights },
  });
}

type Opts = { secret(name: string): string | undefined; config: AttentionOSConfig; log: Logger; fetch?: FetchLike; now?: () => Date };

function graphClient(opts: Opts) {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const host = opts.secret("IG_GRAPH_HOST") ?? "graph.facebook.com";
  const version = opts.secret("IG_GRAPH_VERSION") ?? "v23.0";
  const creds = () => {
    const token = opts.secret("IG_ACCESS_TOKEN");
    const userId = opts.secret("IG_USER_ID");
    if (!token || !userId) {
      throw new ProviderError(PROVIDER_ID, "auth", "IG_ACCESS_TOKEN and IG_USER_ID must both be set in .env (see the Instagram Graph setup guide).");
    }
    return { token, userId };
  };
  async function get<T>(pathOrUrl: string, params: Record<string, string> = {}): Promise<T> {
    const { token } = creds();
    const url = pathOrUrl.startsWith("https://")
      ? pathOrUrl
      : `https://${host}/${version}/${pathOrUrl}?${new URLSearchParams({ ...params, access_token: token })}`;
    try {
      return await requestJson<T>(fetchImpl, url, { provider: PROVIDER_ID, timeoutMs: 30_000 });
    } catch (err) {
      throw remapGraphError(err);
    }
  }
  return { get, creds };
}

/** Graph errors come back as HTTP 400 with `{error: {code, error_subcode, message}}`; map the codes that matter. */
export function remapGraphError(err: unknown): unknown {
  if (!(err instanceof ProviderError)) return err;
  const g = (err.details?.raw as { error?: { code?: number; error_subcode?: number; message?: string } } | undefined)?.error;
  if (!g) return err;
  const msg = g.message ?? err.message;
  let code = err.code;
  if (g.code === 190 || g.code === 102) code = "auth";
  else if ([4, 17, 32, 613].includes(g.code ?? -1)) code = "rate_limited";
  else if (g.code === 110 || g.error_subcode === 2207013 || /cannot be found|business_discovery/i.test(msg)) code = "not_found";
  return new ProviderError(PROVIDER_ID, code, msg, { ...err.details, vendorCode: g.code });
}

/** Scraper over business_discovery. Instagram only. */
export function create(opts: Opts): Scraper {
  const graph = graphClient(opts);
  return {
    id: PROVIDER_ID,
    async health(): Promise<ProviderHealth> {
      try {
        const { userId } = graph.creds();
        const me = await graph.get<{ username?: string }>(userId, { fields: "username" });
        return { ok: true, detail: `Connected to Instagram as @${me.username ?? "your account"}` };
      } catch (err) {
        return {
          ok: false,
          detail: `Instagram Graph API: ${(err as Error).message}`,
          fix: "Create a long-lived token for your Instagram professional account (connected to a Facebook Page) and set IG_ACCESS_TOKEN and IG_USER_ID",
        };
      }
    },
    async estimateCostUsd() {
      return 0;
    },
    async listCreatorPosts(handle, platform, o) {
      if (platform !== "instagram") throw new ProviderError(PROVIDER_ID, "unsupported", `the Instagram Graph API can't read ${platform}`);
      const { userId } = graph.creds();
      const h = handle.replace(/^@/, "");
      const limit = Math.min(o?.limit ?? 25, 100);
      let body: unknown;
      for (const fields of [MEDIA_FIELDS_FULL, MEDIA_FIELDS_NO_VIEWS]) {
        try {
          body = await graph.get(userId, { fields: `business_discovery.username(${h}){followers_count,media_count,media.limit(${limit}){${fields}}}` });
          break;
        } catch (err) {
          // Some API tiers reject view_count; retry without it so likes and comments still come back.
          if (fields === MEDIA_FIELDS_FULL && err instanceof ProviderError && /view_count/.test(err.message)) continue;
          throw err;
        }
      }
      const parsed = businessDiscoverySchema.safeParse(body);
      if (!parsed.success) throw new ProviderError(PROVIDER_ID, "upstream", "unexpected business_discovery response");
      const media = (parsed.data.business_discovery.media?.data ?? [])
        .map((m) => graphMediaSchema.safeParse(m))
        .flatMap((r) => (r.success ? [r.data] : []));
      return media
        .map((m) => mediaToExternalPost(m, h))
        .filter((p) => !o?.since || p.publishedAt >= o.since)
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    },
  };
}

/** OwnAnalytics over your own media + insights (full-history backfill). */
export function createOwnAnalytics(opts: Opts): OwnAnalytics {
  const graph = graphClient(opts);
  const now = opts.now ?? (() => new Date());
  async function insightsFor(m: GraphMedia): Promise<Record<string, number>> {
    const metrics = isVideo(m) ? REEL_METRICS : FEED_METRICS;
    for (const metric of [metrics, FALLBACK_METRICS]) {
      try {
        return parseInsights(await graph.get(`${m.id}/insights`, { metric }));
      } catch (err) {
        if (err instanceof ProviderError && (err.code === "auth" || err.code === "rate_limited")) throw err;
        // Older or unsupported media reject some metrics; fall back to the always-available pair.
      }
    }
    return {};
  }
  return {
    id: PROVIDER_ID,
    health: () => create(opts).health(),
    async listPostMetrics(accountId, o) {
      const { userId } = graph.creds();
      const igUser = /^\d+$/.test(accountId) ? accountId : userId;
      const limit = o?.limit ?? 200;
      const out: PostMetricsSnapshot[] = [];
      let next: string | undefined;
      let page = await graph.get<{ data?: unknown[]; paging?: { next?: string } }>(`${igUser}/media`, { fields: OWN_MEDIA_FIELDS, limit: String(Math.min(50, limit)) });
      for (;;) {
        let reachedSince = false;
        for (const raw of page.data ?? []) {
          const r = graphMediaSchema.safeParse(raw);
          if (!r.success) continue;
          if (o?.since && new Date(r.data.timestamp).toISOString() < o.since) {
            reachedSince = true;
            break;
          }
          out.push(toSnapshot(r.data, await insightsFor(r.data), now().toISOString()));
          if (out.length >= limit) return out;
        }
        next = page.paging?.next;
        if (reachedSince || !next) break;
        page = await graph.get(next);
      }
      return out;
    },
  };
}
