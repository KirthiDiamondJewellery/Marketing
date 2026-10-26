import { z } from "zod";
import { ProviderError, type Platform, type PostMetricsSnapshot, type PublishRequest, type PublishResult } from "@attentionos/core";

/**
 * Pure request/response mapping for the Blotato REST API v2 (https://help.blotato.com, OpenAPI at
 * https://backend.blotato.com/openapi.json). Kept separate from I/O so the contract tests cover it with fixtures.
 */

export const PROVIDER = "blotato";
export const BASE_URL = "https://backend.blotato.com/v2";

/** Blotato calls X "twitter". Pinterest and Bluesky exist in Blotato but not in AttentionOS. */
export const TO_BLOTATO: Record<Platform, string> = {
  instagram: "instagram", tiktok: "tiktok", youtube: "youtube", facebook: "facebook", linkedin: "linkedin", x: "twitter", threads: "threads",
};
export function fromBlotatoPlatform(p: string): Platform | undefined {
  const entry = Object.entries(TO_BLOTATO).find(([, v]) => v === p);
  return entry?.[0] as Platform | undefined;
}

/** Facebook pages are addressed as `<accountId>/<pageId>` so one AttentionOS account id carries both. */
export function splitAccountId(id: string): { accountId: string; pageId?: string } {
  const [accountId, pageId] = id.split("/");
  return pageId ? { accountId: accountId!, pageId } : { accountId: accountId! };
}

const TIKTOK_PRIVACY = { public: "PUBLIC_TO_EVERYONE", friends: "MUTUAL_FOLLOW_FRIENDS", private: "SELF_ONLY" } as const;

/** Builds the per-platform `target` object. Field names follow the OpenAPI spec exactly. */
export function buildTarget(req: PublishRequest, pageId: string | undefined): Record<string, unknown> {
  const o = req.options ?? {};
  const isVideo = req.media.some((m) => m.kind === "video");
  switch (req.platform) {
    case "instagram": {
      const ig = o.instagram ?? {};
      const trial = ig.trialReel === true;
      return compactObj({
        targetType: "instagram",
        mediaType: isVideo ? "reel" : undefined,
        // Trial reels are never shared to the main grid.
        shareToFeed: isVideo && !trial ? ig.shareToFeed ?? true : undefined,
        collaborators: ig.collaborators?.length ? ig.collaborators.map((c) => c.replace(/^@/, "")) : undefined,
        coverImageUrl: ig.coverUrl,
        firstComment: ig.firstComment,
        // The field is `trial`, not `trialReel`. MANUAL = you decide when it graduates to followers.
        trial: trial ? { graduationStrategy: ig.trialGraduation === "SS_PERFORMANCE" ? "SS_PERFORMANCE" : "MANUAL" } : undefined,
      });
    }
    case "tiktok": {
      const tt = o.tiktok ?? {};
      // All seven fields are required by Blotato. TikTok captions can't be edited after posting.
      return {
        targetType: "tiktok",
        privacyLevel: TIKTOK_PRIVACY[tt.privacy ?? "public"],
        disabledComments: tt.allowComments === false,
        disabledDuet: tt.allowDuet === false,
        disabledStitch: tt.allowStitch === false,
        isBrandedContent: false,
        isYourBrand: false,
        isAiGenerated: tt.aiGenerated ?? false,
      };
    }
    case "youtube": {
      const yt = o.youtube ?? {};
      if (!yt.title) throw new ProviderError(PROVIDER, "invalid_request", "YouTube needs a title");
      return { targetType: "youtube", title: yt.title, privacyStatus: yt.privacy ?? "public", shouldNotifySubscribers: true, isMadeForKids: yt.madeForKids ?? false };
    }
    case "facebook": {
      const page = o.facebook?.pageId ?? pageId;
      if (!page) throw new ProviderError(PROVIDER, "invalid_request", "Facebook posts need a page; reconnect the Facebook account and pick a page");
      // Feed video is no longer supported by Blotato: videos must go out as reels.
      return compactObj({ targetType: "facebook", pageId: page, mediaType: isVideo ? "reel" : undefined });
    }
    case "linkedin":
      return compactObj({ targetType: "linkedin", pageId });
    case "x":
      return { targetType: "twitter" };
    case "threads":
      return { targetType: "threads" };
  }
}

/**
 * The full POST /v2/posts body. `scheduledTime` MUST sit at the payload root, next to `post`: nested anywhere
 * else it is silently ignored and the post goes out immediately. Times are sent as UTC ISO-8601.
 */
export function buildPostBody(req: PublishRequest, mediaUrls: string[]): Record<string, unknown> {
  const { accountId, pageId } = splitAccountId(req.accountId);
  const platform = TO_BLOTATO[req.platform];
  const body: Record<string, unknown> = {
    post: {
      accountId,
      content: { text: req.caption, mediaUrls, platform },
      target: buildTarget(req, pageId),
    },
  };
  if (req.scheduledAt) body.scheduledTime = new Date(req.scheduledAt).toISOString();
  return body;
}

export const createPostResponse = z.looseObject({ postSubmissionId: z.string().min(1), scheduledTime: z.string().optional() });

export const postStatusResponse = z.looseObject({
  postSubmissionId: z.string().optional(),
  status: z.string(),
  publicUrl: z.string().optional().nullable(),
  errorMessage: z.string().optional().nullable(),
  scheduledTime: z.string().optional().nullable(),
});

export type BlotatoPublishResult = PublishResult & { error?: string };

/**
 * Status of a submission. NOTE: Blotato answers `in-progress` for ANY id it doesn't know, including a schedule id
 * or a published post id passed by mistake. Only ever call this with a `postSubmissionId`.
 */
export function mapPostStatus(id: string, res: z.output<typeof postStatusResponse>): BlotatoPublishResult {
  const base = { providerPostId: id } as BlotatoPublishResult;
  switch (res.status) {
    case "published":
      return { ...base, status: "published", ...(res.publicUrl ? { url: res.publicUrl } : {}) };
    case "scheduled":
      return { ...base, status: "scheduled", ...(res.scheduledTime ? { scheduledAt: res.scheduledTime } : {}) };
    case "failed":
      return { ...base, status: "failed", ...(res.errorMessage ? { error: res.errorMessage } : {}) };
    default:
      return { ...base, status: "publishing" };
  }
}

/** Keyword variants: lower, Title and UPPER (see the README on case-sensitivity). Deduped, order kept. */
export function keywordVariants(keyword: string): string[] {
  const k = keyword.trim();
  if (!k) throw new ProviderError(PROVIDER, "invalid_request", "an empty keyword would fire on every comment");
  const lower = k.toLowerCase();
  return [...new Set([lower, lower.charAt(0).toUpperCase() + lower.slice(1), lower.toUpperCase(), k])];
}

/** Blotato metric counts arrive as strings. */
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function mapMetrics(args: {
  publishedPostId: string;
  platform: Platform;
  url?: string;
  publishedAt?: string;
  caption?: string;
  capturedAt: string;
  metrics: Record<string, unknown> | null | undefined;
}): PostMetricsSnapshot {
  const m = args.metrics ?? {};
  const watchMs = num(m.watchTimeMsAvg);
  return compactObj({
    // Blotato's published post id; the native platform id isn't exposed by this endpoint.
    platformPostId: args.publishedPostId,
    providerPostId: args.publishedPostId,
    platform: args.platform,
    capturedAt: args.capturedAt,
    url: args.url,
    publishedAt: args.publishedAt,
    caption: args.caption,
    views: num(m.viewsCount) ?? num(m.playsCount),
    reach: num(m.reachCount),
    likes: num(m.likesCount),
    comments: num(m.commentsCount) ?? num(m.repliesCount),
    shares: num(m.sharesCount),
    saves: num(m.savesCount),
    follows: num(m.followsCount),
    profileVisits: num(m.profileVisitsCount),
    avgWatchTimeS: watchMs !== undefined ? watchMs / 1000 : undefined,
    raw: args.metrics ?? undefined,
  }) as PostMetricsSnapshot;
}

/** Blotato error bodies: `{ code, message, action, details }` (legacy: `{ code, message }`). */
export const errorBody = z.looseObject({
  code: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
  action: z.string().optional(),
  statusCode: z.number().optional(),
});

/** 429 bodies say "Rate limit exceeded, retry in 49 seconds" instead of sending Retry-After. */
export function retryAfterFromBody(body: unknown): number | undefined {
  const parsed = errorBody.safeParse(body);
  const m = parsed.success ? /retry in (\d+)\s*seconds?/i.exec(parsed.data.message ?? "") : null;
  return m ? Number(m[1]) * 1000 : undefined;
}

/**
 * Error 30101 shows up when another DM tool (or a second workspace) is connected to the same Instagram account:
 * Meta routes the conversation to the other app, so a follow-gate message goes out and the real DM then fails.
 * It is not in Blotato's docs; the routing conflict itself is.
 */
export function describeError(status: number, body: unknown) {
  const parsed = errorBody.safeParse(body);
  const code = parsed.success ? parsed.data.code : undefined;
  const message = parsed.success ? parsed.data.message : undefined;
  const codeStr = code !== undefined ? String(code) : undefined;
  if (codeStr === "30101" || /another app|handling this conversation|conversation routing/i.test(message ?? "")) {
    return {
      code: "conflict" as const,
      vendorCode: code,
      message: "Another DM tool is connected to this Instagram account and is taking over the conversation (Blotato error 30101). Make Blotato the default app for messages in Meta Business Suite, or turn off the follow gate and put the link in the first message.",
    };
  }
  if (codeStr === "20101") return { code: "budget_exceeded" as const, vendorCode: code, message: "Blotato's monthly active-contacts limit is reached; upgrade the plan or wait for the next cycle." };
  if (codeStr === "20300" || status === 403) return { code: "auth" as const, vendorCode: code, message: "Your Blotato subscription isn't active (the free trial doesn't include the API)." };
  if (codeStr === "5000") return { code: "not_found" as const, vendorCode: code, message: "Blotato can't find that connected account; reconnect it in Blotato." };
  if (status === 401) return { code: "auth" as const, vendorCode: code, message: "Blotato rejected the API key. Copy it again from Settings → API, including any trailing '=' characters." };
  return { vendorCode: code, message: message ? `Blotato: ${message}` : undefined };
}

function compactObj<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
