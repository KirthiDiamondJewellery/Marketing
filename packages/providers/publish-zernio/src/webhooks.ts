import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { InboxComment, InboxMessage, Platform, WebhookRequest, WebhookRoute } from "@attentionos/core";
import { accountIdOf, fromZernioPlatform, joinRef, platformEntrySchema } from "./mapping.ts";

/**
 * Zernio webhooks (https://docs.zernio.com/webhooks).
 *
 * - Signature: `X-Zernio-Signature` = lowercase hex HMAC-SHA256 of the RAW request body, keyed by the secret you
 *   chose when registering the webhook (Zernio never generates one). Legacy header: `X-Late-Signature`.
 * - No timestamp is signed and there's no replay window: dedupe on the event id (`X-Zernio-Event-Id` / payload `id`).
 * - Delivery is at-least-once, up to 7 attempts over ~51 hours; answer 2xx within 5 seconds and process async.
 */

export const SIGNATURE_HEADERS = ["x-zernio-signature", "x-late-signature"] as const;
export const EVENT_ID_HEADERS = ["x-zernio-event-id", "x-late-event-id"] as const;
export const WEBHOOK_SECRET_NAME = "ZERNIO_WEBHOOK_SECRET";

export function header(headers: Record<string, string | string[] | undefined>, names: readonly string[]): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (names.includes(k.toLowerCase())) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Constant-time check of the HMAC over the exact raw body bytes. */
export function verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string | Buffer, secret: string): boolean {
  if (!secret) return false;
  const given = header(headers, SIGNATURE_HEADERS)?.trim().toLowerCase().replace(/^sha256=/, "");
  if (!given || !/^[a-f0-9]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"));
}

// --- Normalised events ------------------------------------------------------------------------------------------

export type PostPlatformState = {
  platform?: Platform;
  accountId?: string;
  status?: string;
  platformPostId?: string;
  url?: string;
  error?: string;
};

type Base = { eventId: string; at: string; provider: "zernio" };

export type NormalizedEvent =
  | (Base & {
    type: "post.scheduled" | "post.published" | "post.partial" | "post.failed" | "post.cancelled" | "post.platform.published"
      | "post.platform.failed" | "post.platform.deleted" | "post.tiktok.url_resolved" | "post.recycled";
    providerPostId: string;
    status?: string;
    /** Our idempotency key, echoed from `metadata` when the post was created by AttentionOS. */
    idempotencyKey?: string;
    platforms: PostPlatformState[];
  })
  | (Base & { type: "post.external.created" | "post.external.updated" | "post.external.deleted"; accountId?: string; platformPostId?: string; platform?: Platform })
  | (Base & {
    type: "message.received" | "message.sent" | "message.edited" | "message.deleted" | "message.delivered" | "message.read" | "message.failed";
    accountId: string;
    /** `<accountId>:<conversationId>`, the id `Inbox.listMessages`/`sendMessage` take. */
    conversationId: string;
    message: InboxMessage;
    /** Set when an automation sent it (message.sent). */
    automationId?: string;
    sentVia?: string;
  })
  | (Base & { type: "conversation.started"; accountId: string; conversationId: string; platform?: Platform; participant?: { id?: string; handle?: string; name?: string } })
  | (Base & { type: "comment.received"; accountId: string; platformPostId?: string; comment: InboxComment })
  | (Base & { type: "analytics.synced"; accountId?: string; platform?: Platform })
  | (Base & { type: "account.connected" | "account.disconnected"; accountId?: string; platform?: Platform })
  | (Base & { type: "unknown"; event: string });

const idLike = z.union([z.string(), z.number()]).transform(String);
const refObj = z.looseObject({ id: idLike.optional(), _id: idLike.optional(), accountId: idLike.optional(), platform: z.string().nullish(), profileId: idLike.optional() });

const envelope = z.looseObject({
  id: idLike.optional(),
  event: z.string(),
  timestamp: z.string().optional(),
  post: z.looseObject({
    id: idLike.optional(),
    _id: idLike.optional(),
    status: z.string().nullish(),
    metadata: z.looseObject({ attentionosKey: z.string().optional() }).nullish(),
    platforms: z.array(platformEntrySchema).default([]),
    platformPostId: z.string().nullish(),
    platform: z.string().nullish(),
  }).optional(),
  message: z.looseObject({
    id: idLike,
    conversationId: idLike.optional(),
    platform: z.string().nullish(),
    direction: z.string().nullish(),
    text: z.string().nullish(),
    createdAt: z.string().nullish(),
    sender: z.looseObject({ id: idLike.optional(), name: z.string().nullish(), username: z.string().nullish() }).nullish(),
    sentVia: z.string().nullish(),
    automationId: idLike.nullish(),
  }).optional(),
  conversation: z.looseObject({ id: idLike.optional(), participant: z.looseObject({ id: idLike.optional(), name: z.string().nullish(), username: z.string().nullish() }).nullish() }).optional(),
  comment: z.looseObject({
    id: idLike,
    postId: idLike.nullish(),
    platformPostId: z.string().nullish(),
    platform: z.string().nullish(),
    text: z.string().nullish(),
    createdAt: z.string().nullish(),
    author: z.looseObject({ id: idLike.optional(), username: z.string().nullish(), name: z.string().nullish() }).nullish(),
  }).optional(),
  account: refObj.optional(),
});

export class WebhookError extends Error {
  constructor(message: string, public readonly status: 400 | 401) {
    super(message);
    this.name = "WebhookError";
  }
}

/** Turns one verified webhook payload into a typed event. Unknown event names come back as `type: "unknown"`. */
export function normalizeEvent(payload: unknown, headerEventId?: string): NormalizedEvent {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) throw new WebhookError(`webhook payload isn't a Zernio event: ${parsed.error.issues[0]?.message ?? "invalid"}`, 400);
  const p = parsed.data;
  const eventId = p.id ?? headerEventId ?? `${p.event}:${p.timestamp ?? ""}`;
  const base: Base = { eventId, at: p.timestamp ?? new Date().toISOString(), provider: "zernio" };
  const accountId = p.account?.accountId ?? p.account?.id ?? p.account?._id;
  const accountPlatform = fromZernioPlatform(p.account?.platform);

  if (p.event.startsWith("post.external.")) {
    return { ...base, type: p.event as "post.external.created", ...(accountId ? { accountId } : {}), ...(p.post?.platformPostId ? { platformPostId: p.post.platformPostId } : {}), ...(accountPlatform ? { platform: accountPlatform } : {}) };
  }
  if (p.event.startsWith("post.")) {
    const id = p.post?.id ?? p.post?._id;
    if (!id) throw new WebhookError(`${p.event} without a post id`, 400);
    return {
      ...base,
      type: p.event as "post.published",
      providerPostId: id,
      ...(p.post?.status ? { status: p.post.status } : {}),
      ...(p.post?.metadata?.attentionosKey ? { idempotencyKey: p.post.metadata.attentionosKey } : {}),
      platforms: (p.post?.platforms ?? []).map((e) => {
        const platform = fromZernioPlatform(e.platform);
        const acct = accountIdOf(e);
        const url = e.platformPostUrl ?? e.publishedUrl;
        return {
          ...(platform ? { platform } : {}),
          ...(acct ? { accountId: acct } : {}),
          ...(e.status ? { status: e.status } : {}),
          ...(e.platformPostId ? { platformPostId: e.platformPostId } : {}),
          ...(url ? { url } : {}),
          ...(e.errorMessage ? { error: e.errorMessage } : {}),
        };
      }),
    };
  }
  if (p.event.startsWith("message.")) {
    const m = p.message;
    const convId = m?.conversationId ?? p.conversation?.id;
    if (!m || !convId || !accountId) throw new WebhookError(`${p.event} without message, conversation or account`, 400);
    const platform = fromZernioPlatform(m.platform) ?? accountPlatform ?? "instagram";
    const conversationId = joinRef(accountId, convId);
    return {
      ...base,
      type: p.event as "message.received",
      accountId,
      conversationId,
      message: {
        id: m.id,
        conversationId,
        platform,
        from: { id: m.sender?.id ?? "unknown", ...(m.sender?.username ? { handle: m.sender.username } : {}), ...(m.sender?.name ? { name: m.sender.name } : {}) },
        // UNTRUSTED text: only tool-less LLM calls may read it.
        text: m.text ?? "",
        at: m.createdAt ?? base.at,
        direction: m.direction === "outgoing" || m.direction === "out" ? "out" : "in",
      },
      ...(m.automationId ? { automationId: m.automationId } : {}),
      ...(m.sentVia ? { sentVia: m.sentVia } : {}),
    };
  }
  if (p.event === "conversation.started") {
    const convId = p.conversation?.id;
    if (!convId || !accountId) throw new WebhookError("conversation.started without conversation or account", 400);
    const part = p.conversation?.participant;
    return {
      ...base,
      type: "conversation.started",
      accountId,
      conversationId: joinRef(accountId, convId),
      ...(accountPlatform ? { platform: accountPlatform } : {}),
      ...(part ? { participant: { ...(part.id ? { id: part.id } : {}), ...(part.username ? { handle: part.username } : {}), ...(part.name ? { name: part.name } : {}) } } : {}),
    };
  }
  if (p.event === "comment.received") {
    const c = p.comment;
    if (!c || !accountId) throw new WebhookError("comment.received without comment or account", 400);
    const postRef = c.postId ?? c.platformPostId ?? "unknown";
    return {
      ...base,
      type: "comment.received",
      accountId,
      ...(c.platformPostId ? { platformPostId: c.platformPostId } : {}),
      comment: {
        id: joinRef(accountId, postRef, c.id),
        providerPostId: postRef,
        platform: fromZernioPlatform(c.platform) ?? accountPlatform ?? "instagram",
        from: { id: c.author?.id ?? "unknown", ...(c.author?.username ? { handle: c.author.username } : {}) },
        text: c.text ?? "",
        at: c.createdAt ?? base.at,
      },
    };
  }
  if (p.event === "analytics.synced") {
    return { ...base, type: "analytics.synced", ...(accountId ? { accountId } : {}), ...(accountPlatform ? { platform: accountPlatform } : {}) };
  }
  if (p.event === "account.connected" || p.event === "account.disconnected") {
    return { ...base, type: p.event, ...(accountId ? { accountId } : {}), ...(accountPlatform ? { platform: accountPlatform } : {}) };
  }
  return { ...base, type: "unknown", event: p.event };
}

export type { WebhookRequest, WebhookRoute };
export type WebhookHandler = (req: WebhookRequest) => Promise<{ events: NormalizedEvent[] }>;

/** Jobs the worker queues for Zernio events (see `webhookRoute`). */
export const WEBHOOK_JOBS = {
  postEvent: "publishing.post-event",
  inboxEvent: "community.inbox-event",
  syncAccounts: "publishing.sync-accounts",
  ownSync: "research.own-sync",
} as const;

/**
 * Maps one normalised event to the job the worker should queue (core `WebhookCapable.webhookJob`). Dedupe keys come
 * from Zernio's event id, so retried deliveries never run twice. `analytics.synced` fires hourly per account and
 * carries no metrics: it triggers one own-sync per hour.
 */
export function webhookRoute(e: NormalizedEvent): WebhookRoute | null {
  const key = `zernio:${e.eventId}`;
  switch (e.type) {
    case "post.scheduled": case "post.published": case "post.partial": case "post.failed": case "post.cancelled":
    case "post.platform.published": case "post.platform.failed": case "post.platform.deleted": case "post.tiktok.url_resolved": case "post.recycled":
      return { jobId: WEBHOOK_JOBS.postEvent, input: { event: e }, dedupeKey: key };
    case "post.external.created": case "post.external.updated": case "post.external.deleted":
      return { jobId: WEBHOOK_JOBS.ownSync, input: {}, dedupeKey: `zernio:own-sync:${e.at.slice(0, 13)}` };
    case "message.received": case "comment.received": case "conversation.started":
      return { jobId: WEBHOOK_JOBS.inboxEvent, input: { event: e }, dedupeKey: key };
    case "analytics.synced":
      return { jobId: WEBHOOK_JOBS.ownSync, input: {}, dedupeKey: `zernio:own-sync:${e.at.slice(0, 13)}` };
    case "account.connected": case "account.disconnected":
      return { jobId: WEBHOOK_JOBS.syncAccounts, input: {}, dedupeKey: key };
    default:
      return null;
  }
}

/**
 * Builds the handler for the worker's `POST /webhooks/zernio` route. It verifies the signature over the raw body and
 * returns the normalised events; it does NOT dedupe or persist (the worker dedupes on `eventId`, answers 2xx fast and
 * hands events to the publishing/community modules). Throws `WebhookError` with an HTTP status on bad input.
 */
export function createWebhookHandler(secret: string | undefined): WebhookHandler {
  return async (req) => {
    if (!secret) throw new WebhookError(`set ${WEBHOOK_SECRET_NAME} to receive Zernio webhooks`, 401);
    if (!verifyWebhook(req.headers, req.body, secret)) throw new WebhookError("bad or missing X-Zernio-Signature", 401);
    let payload: unknown;
    try {
      payload = JSON.parse(req.body);
    } catch {
      throw new WebhookError("webhook body isn't JSON", 400);
    }
    const events = Array.isArray(payload) ? payload : [payload];
    const eventId = header(req.headers, EVENT_ID_HEADERS);
    return { events: events.map((e, i) => normalizeEvent(e, events.length === 1 ? eventId : eventId ? `${eventId}:${i}` : undefined)) };
  };
}

/** `POST /webhooks/zernio` handler reading the secret from `ZERNIO_WEBHOOK_SECRET` in the environment. */
export const webhookHandler: WebhookHandler = (req) => createWebhookHandler(process.env[WEBHOOK_SECRET_NAME])(req);
