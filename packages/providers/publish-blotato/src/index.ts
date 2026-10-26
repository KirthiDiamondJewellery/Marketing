import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ProviderError,
  type AttentionOSConfig, type DmAutomation, type DmAutomationRequest, type Inbox, type InboxComment, type InboxMessage,
  type Logger, type MediaRef, type OwnAnalytics, type Platform, type PostMetricsSnapshot, type PublishRequest, type Publisher,
  type PublisherCapabilities, type SocialAccount, type WebhookCapable, type WebhookRequest, type WebhookRoute,
} from "@attentionos/core";
import { assertH264Aac, ffprobe, HttpClient, mimeFor, putFile, type FetchLike, type ProbeFn } from "@attentionos/provider-shared";
import {
  BASE_URL, PROVIDER, TO_BLOTATO, buildPostBody, createPostResponse, describeError, fromBlotatoPlatform, keywordVariants,
  mapMetrics, mapPostStatus, postStatusResponse, retryAfterFromBody, splitAccountId, type BlotatoPublishResult,
} from "./mapping.ts";

export {
  BASE_URL, TO_BLOTATO, buildPostBody, buildTarget, keywordVariants, mapMetrics, mapPostStatus, retryAfterFromBody, splitAccountId,
  type BlotatoPublishResult,
} from "./mapping.ts";
export { assertH264Aac, type ProbeFn, type VideoProbe } from "@attentionos/provider-shared";

export const BLOTATO_SECRETS = {
  apiKey: "BLOTATO_API_KEY",
  /** Public URL of the worker's `POST /webhooks/blotato` (through your tunnel). Optional: enables lead capture. */
  webhookUrl: "BLOTATO_WEBHOOK_URL",
  /** Any long random string; sent by Blotato as a custom header on every automation webhook. */
  webhookSecret: "BLOTATO_WEBHOOK_SECRET",
} as const;

/** Headers AttentionOS asks Blotato to send with each automation webhook (Blotato's body is only `{email, isFollower}`). */
export const WEBHOOK_HEADERS = { secret: "x-attentionos-secret", keyword: "x-attentionos-keyword", post: "x-attentionos-post" } as const;
export const LEAD_CAPTURED_JOB = "community.lead-captured";

const leadWebhookBody = z.looseObject({ email: z.string().nullish(), isFollower: z.boolean().nullish() });

/**
 * Routes a Blotato automation webhook. The body carries no contact id, handle, comment or automation id, so the
 * keyword and post come from the custom headers set when the automation was created. Without an email there is
 * nothing to hand off.
 */
export function blotatoWebhookRoute(payload: unknown, req: WebhookRequest): WebhookRoute | null {
  const body = leadWebhookBody.safeParse(payload);
  if (!body.success || !body.data.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.data.email)) return null;
  const keyword = req.headers[WEBHOOK_HEADERS.keyword]?.toLowerCase();
  const post = req.headers[WEBHOOK_HEADERS.post];
  const email = body.data.email.trim().toLowerCase();
  return {
    jobId: LEAD_CAPTURED_JOB,
    input: { email, ...(body.data.isFollower !== null && body.data.isFollower !== undefined ? { isFollower: body.data.isFollower } : {}), ...(keyword ? { keyword } : {}), ...(post ? { postRef: post } : {}), source: "instagram keyword DM" },
    dedupeKey: `blotato:lead:${keyword ?? "none"}:${email}`,
  };
}

/** Blotato's POST /v2/posts allows 30 requests a minute: keep 2.5 s between posts. */
export const POST_SPACING_MS = 2_500;
/** Starter plan upload cap; Creator and Agency allow 1 GB. */
export const MAX_UPLOAD_BYTES = 400 * 1024 * 1024;

export type BlotatoCreateOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Video codec probe (defaults to ffprobe when installed). */
  probe?: ProbeFn;
};

export type BlotatoProvider = Publisher & Inbox & OwnAnalytics & Required<WebhookCapable> & {
  /** Blotato has no idempotency keys: the publishing module must never blindly resend a post that may have gone out. */
  readonly supportsIdempotencyKeys: false;
  /** Resolves any post reference (submission id, Blotato published id or native platform id) to Blotato's published post id. */
  resolvePublishedPostId(ref: string, hint?: { accountId?: string; platform?: Platform }): Promise<string>;
};

// --- Response schemas (loose: Blotato adds fields over time) -----------------------------------------------------

const accountsResponse = z.looseObject({
  items: z.array(z.looseObject({ id: z.union([z.string(), z.number()]), platform: z.string(), fullname: z.string().nullish(), username: z.string().nullish() })),
});
const subaccountsResponse = z.looseObject({
  items: z.array(z.looseObject({ id: z.union([z.string(), z.number()]), accountId: z.union([z.string(), z.number()]).optional(), name: z.string().nullish() })),
});
const uploadResponse = z.looseObject({ presignedUrl: z.string().url(), publicUrl: z.string().url() });
const listPostsResponse = z.looseObject({
  items: z.array(z.looseObject({
    id: z.union([z.string(), z.number()]),
    postTime: z.string().nullish(),
    platform: z.string().nullish(),
    text: z.string().nullish(),
    account: z.looseObject({ id: z.union([z.string(), z.number()]).optional() }).nullish(),
    state: z.looseObject({ type: z.string(), postUrl: z.string().nullish(), analytics: z.unknown().optional(), errorMessage: z.string().nullish() }).nullish(),
  })).default([]),
  cursor: z.string().nullish(),
});
const flowSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  accountId: z.union([z.string(), z.number()]).nullish(),
  isActive: z.boolean().nullish(),
  triggers: z.array(z.looseObject({ type: z.string().optional(), keywords: z.array(z.string()).nullish(), postId: z.union([z.string(), z.number()]).nullish() })).nullish(),
});
const createFlowResponse = z.looseObject({ flow: flowSchema });
const commentSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  accountId: z.union([z.string(), z.number()]).nullish(),
  platform: z.string().nullish(),
  postId: z.union([z.string(), z.number()]).nullish(),
  platformPostId: z.string().nullish(),
  authorId: z.string().nullish(),
  authorUsername: z.string().nullish(),
  isAuthor: z.boolean().nullish(),
  text: z.string().nullish(),
  createdAt: z.string().nullish(),
});
const listCommentsResponse = z.looseObject({ items: z.array(commentSchema).default([]), cursor: z.string().nullish() });
const conversationSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  accountId: z.union([z.string(), z.number()]).nullish(),
  platform: z.string().nullish(),
  participantId: z.string().nullish(),
  participantUsername: z.string().nullish(),
  participant: z.looseObject({ id: z.string().nullish(), username: z.string().nullish(), name: z.string().nullish() }).nullish(),
  lastMessageAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
});
const listConversationsResponse = z.looseObject({ items: z.array(conversationSchema).default([]), cursor: z.string().nullish() });
const messageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  conversationId: z.union([z.string(), z.number()]).nullish(),
  platform: z.string().nullish(),
  senderId: z.string().nullish(),
  senderUsername: z.string().nullish(),
  isFromMe: z.boolean().nullish(),
  direction: z.string().nullish(),
  text: z.string().nullish(),
  createdAt: z.string().nullish(),
});
const listMessagesResponse = z.looseObject({ items: z.array(messageSchema).default([]), cursor: z.string().nullish() });
const createdIdResponse = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), comment: z.looseObject({ id: z.union([z.string(), z.number()]) }).optional(), message: z.looseObject({ id: z.union([z.string(), z.number()]) }).optional() });
const postAnalyticsResponse = z.looseObject({
  publishedPostId: z.union([z.string(), z.number()]).optional(),
  platform: z.string().nullish(),
  lastFetchedAt: z.string().nullish(),
  metrics: z.record(z.string(), z.unknown()).nullish(),
});
const meResponse = z.looseObject({ subscriptionStatus: z.string().nullish(), subscriptionPlan: z.string().nullish() });

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? undefined : String(v));

/** Parses `raw[key]` when present (wrapped responses), else `raw` itself. */
function unwrap<S extends z.ZodType>(raw: unknown, keys: string[], schema: S, what: string): z.output<S> {
  let value: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k];
      if (v !== undefined) { value = v; break; }
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderError(PROVIDER, "upstream", `unexpected ${what} response from Blotato`, { raw });
  return parsed.data;
}

export function create(opts: BlotatoCreateOptions): BlotatoProvider {
  const apiKey = opts.secret(BLOTATO_SECRETS.apiKey);
  const webhookUrl = opts.secret(BLOTATO_SECRETS.webhookUrl);
  const webhookSecret = opts.secret(BLOTATO_SECRETS.webhookSecret);
  const now = opts.now ?? (() => new Date());
  const probe = opts.probe ?? ffprobe;
  const common = {
    provider: PROVIDER,
    baseUrl: BASE_URL,
    // No "Bearer": Blotato uses its own header. Keys can end in "=": never trim them.
    headers: () => ({ "blotato-api-key": apiKey ?? "" }),
    log: opts.log,
    fetch: opts.fetch,
    sleep: opts.sleep,
    describeError,
    retryAfterFromBody,
  };
  const http = new HttpClient({ ...common, maxRetries: 4 });
  // Writes are spaced out and only retried when Blotato refused them (429): with no idempotency key, a retry after a
  // 5xx or a dropped connection could post twice.
  const postHttp = new HttpClient({ ...common, maxRetries: 2, minSpacingMs: POST_SPACING_MS });
  const writeHttp = new HttpClient({ ...common, maxRetries: 2, minSpacingMs: POST_SPACING_MS });
  /** Process-local dedupe for publish(); the module's database key is the real guard. */
  const submitted = new Map<string, BlotatoPublishResult>();

  const requireKey = () => {
    if (!apiKey) throw new ProviderError(PROVIDER, "auth", `add ${BLOTATO_SECRETS.apiKey} to your .env (Blotato → Settings → API)`);
  };

  async function upload(media: MediaRef): Promise<{ url: string }> {
    requireKey();
    if (media.url && !media.localPath) {
      if (!/^https:\/\//.test(media.url)) throw new ProviderError(PROVIDER, "invalid_request", "media URLs must be public https:// links");
      return { url: media.url };
    }
    if (!media.localPath) throw new ProviderError(PROVIDER, "invalid_request", "media needs a local file or a URL");
    await assertH264Aac(PROVIDER, media.localPath, probe);
    const filename = media.localPath.split(/[\\/]/).pop()!;
    const res = await http.request("POST", "/media/uploads", { body: { filename }, schema: uploadResponse });
    await putFile({ provider: PROVIDER, uploadUrl: res.presignedUrl, localPath: media.localPath, contentType: mimeFor(media.localPath, media.mimeType), fetch: opts.fetch });
    return { url: res.publicUrl };
  }

  async function listPublished(params: { platform?: Platform; since?: string; limit?: number; cursor?: string }) {
    return http.request("GET", "/posts", {
      query: { status: "published", platform: params.platform ? TO_BLOTATO[params.platform] : undefined, since: params.since, limit: params.limit ?? 100, cursor: params.cursor },
      schema: listPostsResponse,
    });
  }

  async function resolvePublishedPostId(ref: string, hint: { accountId?: string; platform?: Platform } = {}): Promise<string> {
    requireKey();
    // 1. A postSubmissionId of a published post: match its public URL in the published listing.
    const status = await http.request("GET", `/posts/${encodeURIComponent(ref)}`, { schema: postStatusResponse });
    if (status.status === "published" && status.publicUrl) {
      const listing = await listPublished({ platform: hint.platform, limit: 250 });
      const hit = listing.items.find((i) => i.state?.postUrl === status.publicUrl);
      if (hit) return String(hit.id);
    }
    if (status.status === "scheduled") {
      throw new ProviderError(PROVIDER, "not_found", "the post isn't published yet; Blotato can only attach a DM automation after it goes live");
    }
    // 2. Already a Blotato published post id (`in-progress` is what Blotato answers for ids it doesn't know as submissions).
    try {
      await http.request("GET", `/published-posts/${encodeURIComponent(ref)}`, { retry: false });
      return ref;
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== "not_found") throw err;
    }
    // 3. A native platform id (a reel you uploaded yourself): Blotato only learns it once the first comment syncs.
    const comments = await http.request("GET", "/comments", {
      query: { accountId: hint.accountId ? splitAccountId(hint.accountId).accountId : undefined, platform: hint.platform ? TO_BLOTATO[hint.platform] : undefined, limit: 100 },
      schema: listCommentsResponse,
    });
    const match = comments.items.find((c) => c.platformPostId === ref && c.postId !== null && c.postId !== undefined);
    if (match) return String(match.postId);
    throw new ProviderError(
      PROVIDER,
      "not_found",
      "Blotato doesn't know this post yet. Posts you upload yourself only get a Blotato id after the first comment syncs: leave a comment on the post (from another account) and try again.",
    );
  }

  const provider: BlotatoProvider = {
    id: PROVIDER,
    supportsIdempotencyKeys: false,

    async health() {
      if (!apiKey) return { ok: false, detail: "No Blotato API key", fix: `Add ${BLOTATO_SECRETS.apiKey} to your .env. Note: creating an API key ends Blotato's free trial and starts billing.` };
      try {
        const me = await http.request("GET", "/users/me", { schema: meResponse });
        const active = !me.subscriptionStatus || /active|trialing/i.test(me.subscriptionStatus);
        return active
          ? { ok: true, detail: `Connected to Blotato${me.subscriptionPlan ? ` (${me.subscriptionPlan} plan)` : ""}` }
          : { ok: false, detail: `Blotato subscription is ${me.subscriptionStatus}`, fix: "Reactivate your Blotato plan; the API needs a paid plan" };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err), fix: "Check the API key (keep any trailing '=')" };
      }
    },

    capabilities(): PublisherCapabilities {
      return {
        platforms: ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads"],
        scheduling: true,
        instagramTrialReels: true,
        instagramCollaborators: true,
        firstComment: true,
        maxVideoBytes: MAX_UPLOAD_BYTES,
      };
    },

    async listAccounts(): Promise<SocialAccount[]> {
      requireKey();
      const res = await http.request("GET", "/users/me/accounts", { schema: accountsResponse });
      const out: SocialAccount[] = [];
      for (const a of res.items) {
        const platform = fromBlotatoPlatform(a.platform);
        if (!platform) continue;
        const handle = (a.username ?? a.fullname ?? String(a.id)).replace(/^@/, "");
        if (platform === "facebook") {
          // Facebook posts go to a Page: expose each page as its own account.
          const subs = await http.request("GET", `/users/me/accounts/${encodeURIComponent(String(a.id))}/subaccounts`, { schema: subaccountsResponse });
          for (const s of subs.items) {
            out.push({ providerAccountId: `${a.id}/${s.id}`, platform, handle: s.name ?? handle, displayName: s.name ?? undefined, status: "connected" });
          }
          continue;
        }
        out.push({ providerAccountId: String(a.id), platform, handle, ...(a.fullname ? { displayName: a.fullname } : {}), status: "connected" });
      }
      return out;
    },

    uploadMedia: upload,

    async publish(req: PublishRequest) {
      requireKey();
      const seen = submitted.get(req.idempotencyKey);
      if (seen) return seen;
      const mediaUrls: string[] = [];
      for (const m of req.media) mediaUrls.push((await upload(m)).url);
      const body = buildPostBody(req, mediaUrls);
      const res = await postHttp.request("POST", "/posts", { body, schema: createPostResponse, retry: "rate_limited" });
      // This is a SUBMISSION id, not the post id: use it only to poll status. Comments, DM automations and
      // analytics need the published post id (see resolvePublishedPostId).
      const result: BlotatoPublishResult = {
        providerPostId: res.postSubmissionId,
        status: res.scheduledTime || req.scheduledAt ? "scheduled" : "publishing",
        ...(res.scheduledTime ?? req.scheduledAt ? { scheduledAt: res.scheduledTime ?? req.scheduledAt } : {}),
      };
      submitted.set(req.idempotencyKey, result);
      return result;
    },

    async getPost(providerPostId: string) {
      requireKey();
      const res = await http.request("GET", `/posts/${encodeURIComponent(providerPostId)}`, { schema: postStatusResponse });
      return mapPostStatus(providerPostId, res);
    },

    async cancel(providerPostId: string) {
      requireKey();
      // Scheduled posts are cancelled by SCHEDULE id, which differs from the submission id. Find it by
      // comparing the queued drafts' scheduled time and text with the submission.
      const status = await http.request("GET", `/posts/${encodeURIComponent(providerPostId)}`, { schema: postStatusResponse });
      if (status.status === "published") throw new ProviderError(PROVIDER, "invalid_request", "the post is already live; delete it on the platform itself");
      const schedules = await http.request("GET", "/schedules", {
        query: { limit: 50 },
        schema: z.looseObject({ items: z.array(z.looseObject({ id: z.string(), scheduledAt: z.string().nullish(), draft: z.unknown().optional() })).default([]) }),
      });
      const target = status.scheduledTime ? Date.parse(status.scheduledTime) : NaN;
      const candidates = schedules.items.filter((s) => s.scheduledAt && Date.parse(s.scheduledAt) === target);
      if (candidates.length !== 1) {
        throw new ProviderError(PROVIDER, candidates.length === 0 ? "not_found" : "conflict",
          candidates.length === 0 ? "couldn't find that post in Blotato's schedule (it may already be publishing)" : "more than one post is scheduled for that minute; cancel it in Blotato's calendar");
      }
      // DELETE must not carry a JSON content-type (Blotato answers 400): send no body.
      await writeHttp.request("DELETE", `/schedules/${encodeURIComponent(candidates[0]!.id)}`);
    },

    // --- Inbox (Instagram and Facebook only) ---------------------------------------------------------------

    async createDmAutomation(req: DmAutomationRequest): Promise<DmAutomation> {
      requireKey();
      if ([...req.dmText].length > 640) throw new ProviderError(PROVIDER, "invalid_request", "the DM text is over 640 characters");
      if ((req.buttons?.length ?? 0) > 3) throw new ProviderError(PROVIDER, "invalid_request", "at most 3 buttons");
      for (const b of req.buttons ?? []) if ([...b.label].length > 20) throw new ProviderError(PROVIDER, "invalid_request", `button label "${b.label}" is over 20 characters`);
      if (req.requireFollow && req.platform !== "instagram") throw new ProviderError(PROVIDER, "invalid_request", "a follow gate only works on Instagram");
      if (req.providerPostId === null) {
        throw new ProviderError(PROVIDER, "invalid_request", "keyword automations must be scoped to one post: Blotato matches keywords inside other words, so an account-wide trigger fires on unrelated comments");
      }
      const { accountId, pageId } = splitAccountId(req.accountId);
      const postId = await resolvePublishedPostId(req.providerPostId, { accountId: req.accountId, platform: req.platform });
      const keywords = keywordVariants(req.keyword);
      const body = {
        accountId,
        platform: req.platform,
        target: { targetType: req.platform, ...(req.platform === "facebook" && pageId ? { pageId } : {}) },
        name: `keyword: ${req.keyword}`.slice(0, 60),
        // Comment trigger only: a message trigger would also fire on DMs that merely contain the word.
        triggers: [{ type: "comment-received", keywords, postId }],
        dmMessage: req.dmText,
        buttons: (req.buttons ?? []).map((b) => ({ type: "url", title: b.label, url: b.url })),
        ...(req.requireFollow ? { followGate: { message: req.followGateText ?? "Follow the account first, then tap the button and I'll send it over.", buttonTitle: "I'm following" } } : {}),
        // Lead capture: Blotato calls this after the DM is sent (15 s timeout, no retries, body only {email, isFollower}).
        ...(webhookUrl && webhookSecret
          ? { webhook: { method: "POST", url: webhookUrl, headers: { [WEBHOOK_HEADERS.secret]: webhookSecret, [WEBHOOK_HEADERS.keyword]: req.keyword.toLowerCase(), [WEBHOOK_HEADERS.post]: postId } } }
          : {}),
        isActive: true,
      };
      if (req.replyComment) opts.log.debug("blotato: public comment replies aren't part of DM automations; skipped");
      const res = await writeHttp.request("POST", "/dm-automations", { body, schema: createFlowResponse, retry: "rate_limited" });
      return { id: String(res.flow.id), keyword: req.keyword, providerPostId: postId, active: res.flow.isActive ?? true };
    },

    async listDmAutomations(accountId: string) {
      requireKey();
      const flows = unwrap(await http.request("GET", "/dm-automations"), ["items", "flows"], z.array(flowSchema), "automations");
      const { accountId: acct } = splitAccountId(accountId);
      return flows
        .filter((f) => f.accountId === undefined || f.accountId === null || String(f.accountId) === acct)
        .map((f) => {
          const trig = f.triggers?.find((t) => t.type === "comment-received") ?? f.triggers?.[0];
          return { id: String(f.id), keyword: trig?.keywords?.[0] ?? "", providerPostId: str(trig?.postId) ?? null, active: f.isActive ?? false };
        });
    },

    async deleteDmAutomation(id: string) {
      requireKey();
      // Blotato archives on delete; it can be restored with PATCH isActive:true.
      await writeHttp.request("DELETE", `/dm-automations/${encodeURIComponent(id)}`);
    },

    async listConversations(accountId: string, o = {}) {
      requireKey();
      const res = await http.request("GET", "/conversations", { query: { accountId: splitAccountId(accountId).accountId, limit: o.limit ?? 50 }, schema: listConversationsResponse });
      return res.items
        .map((c) => ({
          id: String(c.id),
          lastMessageAt: c.lastMessageAt ?? c.updatedAt ?? new Date(0).toISOString(),
          participant: c.participant?.username ?? c.participantUsername ?? c.participant?.id ?? c.participantId ?? "unknown",
        }))
        .filter((c) => !o.since || c.lastMessageAt >= o.since);
    },

    async listMessages(conversationId: string, o = {}) {
      requireKey();
      const res = await http.request("GET", "/messages", { query: { conversationId, limit: o.limit ?? 50 }, schema: listMessagesResponse });
      return res.items
        .map((m): InboxMessage => ({
          id: String(m.id),
          conversationId: str(m.conversationId) ?? conversationId,
          platform: fromBlotatoPlatform(m.platform ?? "instagram") ?? "instagram",
          from: { id: m.senderId ?? "unknown", ...(m.senderUsername ? { handle: m.senderUsername } : {}) },
          text: m.text ?? "",
          at: m.createdAt ?? new Date(0).toISOString(),
          direction: m.isFromMe || m.direction === "outgoing" || m.direction === "out" ? "out" : "in",
        }))
        .filter((m) => !o.since || m.at >= o.since);
    },

    async listComments(providerPostId: string, o = {}) {
      requireKey();
      const res = await http.request("GET", "/comments", { query: { postId: providerPostId, since: o.since, limit: o.limit ?? 100 }, schema: listCommentsResponse });
      return res.items
        .filter((c) => !c.isAuthor)
        .map((c): InboxComment => ({
          id: String(c.id),
          providerPostId: str(c.postId) ?? providerPostId,
          platform: fromBlotatoPlatform(c.platform ?? "instagram") ?? "instagram",
          from: { id: c.authorId ?? "unknown", ...(c.authorUsername ? { handle: c.authorUsername } : {}) },
          text: c.text ?? "",
          at: c.createdAt ?? new Date(0).toISOString(),
        }));
    },

    async sendMessage(conversationId: string, text: string) {
      requireKey();
      const conv = unwrap(await http.request("GET", `/conversations/${encodeURIComponent(conversationId)}`), ["conversation"], conversationSchema, "conversation");
      const recipientId = conv.participant?.id ?? conv.participantId;
      const accountId = str(conv.accountId);
      if (!recipientId || !accountId) throw new ProviderError(PROVIDER, "not_found", "couldn't find who this conversation is with");
      const platform = conv.platform ?? "instagram";
      const res = await writeHttp.request("POST", "/messages", {
        body: { accountId, recipientId, text, target: { targetType: platform, responseType: "RESPONSE" } },
        schema: createdIdResponse,
        retry: "rate_limited",
      });
      return { id: str(res.id) ?? str(res.message?.id) ?? "sent" };
    },

    async replyToComment(commentId: string, text: string) {
      requireKey();
      const c = unwrap(await http.request("GET", `/comments/${encodeURIComponent(commentId)}`), ["comment"], commentSchema, "comment");
      if (c.postId === null || c.postId === undefined) throw new ProviderError(PROVIDER, "not_found", "couldn't find the post for that comment");
      const res = await writeHttp.request("POST", "/comments", { body: { postId: String(c.postId), text, parentCommentId: commentId }, schema: createdIdResponse, retry: "rate_limited" });
      return { id: str(res.id) ?? str(res.comment?.id) ?? "queued" };
    },

    // --- Analytics: posts published THROUGH Blotato only, 8 platforms, no LinkedIn --------------------------

    async listPostMetrics(accountId: string, o = {}): Promise<PostMetricsSnapshot[]> {
      requireKey();
      const { accountId: acct } = splitAccountId(accountId);
      const limit = Math.min(o.limit ?? 50, 250);
      const listing = await listPublished({ since: o.since, limit });
      const capturedAt = now().toISOString();
      const out: PostMetricsSnapshot[] = [];
      for (const item of listing.items) {
        if (item.account?.id !== undefined && String(item.account.id) !== acct) continue;
        const platform = fromBlotatoPlatform(item.platform ?? "");
        if (!platform || platform === "linkedin") continue;
        let metrics = (item.state?.analytics && typeof item.state.analytics === "object" ? (item.state.analytics as Record<string, unknown>) : undefined);
        if (metrics && "metrics" in metrics && typeof metrics.metrics === "object") metrics = metrics.metrics as Record<string, unknown>;
        if (!metrics) {
          try {
            const a = await http.request("GET", `/posts/${encodeURIComponent(String(item.id))}/analytics`, { schema: postAnalyticsResponse });
            metrics = a.metrics ?? undefined;
          } catch (err) {
            // 404 = this plan has no analytics, or the post wasn't published through Blotato.
            if (err instanceof ProviderError && err.code === "not_found") continue;
            throw err;
          }
        }
        out.push(mapMetrics({
          publishedPostId: String(item.id), platform, capturedAt, metrics,
          ...(item.state?.postUrl ? { url: item.state.postUrl } : {}),
          ...(item.postTime ? { publishedAt: item.postTime } : {}),
          ...(item.text ? { caption: item.text } : {}),
        }));
        if (out.length >= limit) break;
      }
      return out;
    },

    resolvePublishedPostId,

    verifyWebhook(req: WebhookRequest) {
      const given = req.headers[WEBHOOK_HEADERS.secret];
      if (!webhookSecret || !given) return false;
      const a = Buffer.from(given);
      const b = Buffer.from(webhookSecret);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    webhookJob: (payload, req) => blotatoWebhookRoute(payload, req),
  };
  return provider;
}
