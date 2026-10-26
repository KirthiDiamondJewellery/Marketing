import { createHash } from "node:crypto";
import {
  ProviderError,
  type MediaRef, type Platform, type PlatformOptions, type PublisherCapabilities, type PublishRequest, type PublishResult, type WorkspaceContext,
} from "@attentionos/core";
import type { ValidationResult } from "@attentionos/guardrails";
import { publishingSettings } from "../settings.ts";
import { activity, gate, latestApproval, notify, type GateResult } from "./gate.ts";
import { buildWeekManifest, manifestTable, planSlots, postIdempotencyKey, type ManifestItem, type WeekManifest } from "./manifest.ts";
import { checkPayload, describeCheck } from "./payload.ts";
import {
  accountsSnapshot, advanceContent, captionFor, ensurePostNumber, freshAccounts, getPost, getPostByKey, insertPost, loadContent,
  platformsWithPosts, readyContent, rearmPost, updatePost, type AccountRow, type ContentForPost, type PostPayload, type PostRow, type PostStatus,
} from "./repo.ts";
import { addDays, localDate, localTime, mondayOf, nextMonday, zonedToUtc } from "./time.ts";
import { trackingFor } from "./tracking.ts";
import { swapKeywordCta } from "./crosspost.ts";

/**
 * Scheduling flows. Every path is:
 *   validate payload (no API call) → dry run → insert post (idempotency key) → approval gate → hand off to provider.
 * Re-running any step is safe: keys dedupe posts, the hand-off claims a row atomically, and ambiguous sends are
 * never retried blindly against providers without idempotency keys.
 */

const AGENT = "publisher" as const;
/** Capabilities used when no publisher is connected (everything goes out as assist). */
const MANUAL_CAPS: PublisherCapabilities = {
  platforms: ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads"],
  scheduling: true, instagramTrialReels: false, instagramCollaborators: false, firstComment: false,
};
/** Errors that don't apply when the user posts by hand. */
const ASSIST_IGNORED = new Set(["payload.account_missing", "payload.account_not_connected", "payload.platform_unsupported", "payload.scheduling_unsupported", "payload.collaborators_unsupported", "payload.first_comment_unsupported"]);
/** A slot that passed while waiting for approval is still published if it's less than this late. */
const LATE_GRACE_MS = 2 * 3_600_000;
const STALE_SENDING_MS = 15 * 60_000;

export type ScheduleInput = {
  contentId: string;
  platform: Platform;
  /** ISO-8601 with timezone. Omit to publish now (or, for assist, notify now). */
  scheduledAt?: string;
  dryRun: boolean;
  captionOverride?: string;
  options?: PlatformOptions;
  media?: MediaRef;
  accountId?: string;
  /** Campaign or offer posts: wait for approval even under review_key. Defaults to bottom-of-funnel content. */
  isKey?: boolean;
  mode?: "auto" | "assist";
  idempotencySuffix?: string;
  crossPostOf?: string;
  weekPlanId?: string;
  /** Instagram trial reel: never on the main grid; graduation MANUAL unless the owner turned on automatic. */
  trial?: { variation: number; seed: string; variantOf: string | null; graduation?: "MANUAL" | "SS_PERFORMANCE" };
  /** The post is covered by a person's approval of the whole batch (subject of an `approvals` row). */
  planApproval?: { subjectType: string; subjectId: string };
  runId?: string | null;
};

export type SchedulePreview = {
  platform: Platform;
  account?: string;
  scheduledAt?: string;
  local?: string;
  caption: string;
  media?: MediaRef;
  utmContent: string;
  trackedUrl?: string;
  shortLink?: string;
  mode: "auto" | "assist";
  idempotencyKey: string;
};

export type ScheduleOutcome = {
  outcome: "dry_run" | "invalid" | "awaiting_approval" | "rejected" | "scheduled" | "publishing" | "published" | "queued" | "assist" | "already_exists" | "failed";
  message: string;
  postId?: string;
  approvalRef?: string;
  check: ValidationResult;
  preview?: SchedulePreview;
};

type Prepared = {
  content: ContentForPost;
  request: PublishRequest;
  check: ValidationResult;
  mode: "auto" | "assist";
  account?: AccountRow;
  tracking: { utmContent: string; trackedUrl?: string; shortLink?: string; note?: string };
  title: string;
};

const fail = (code: string, message: string, fix?: string): ValidationResult => ({ ok: false, errors: [{ code, message, ...(fix ? { fix } : {}) }], warnings: [] });

export function uuidFrom(text: string): string {
  const h = createHash("sha256").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function capabilities(ws: WorkspaceContext): PublisherCapabilities {
  return ws.providers.publisher?.capabilities() ?? MANUAL_CAPS;
}

function supportsIdempotency(ws: WorkspaceContext): boolean {
  return (ws.providers.publisher as { supportsIdempotencyKeys?: boolean } | undefined)?.supportsIdempotencyKeys === true;
}

function when(ws: WorkspaceContext, iso: string | Date | null | undefined): string {
  if (!iso) return "now";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const tz = ws.config.workspace.timezone;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  return `${day} ${localTime(d, tz)}`;
}

const label = (p: Platform) => ({ instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", x: "X", threads: "Threads" })[p];

export async function preparePost(ws: WorkspaceContext, input: ScheduleInput): Promise<Prepared | { error: ValidationResult }> {
  const settings = publishingSettings(ws.config);
  const content = await loadContent(ws, input.contentId);
  if (!content) return { error: fail("publishing.content_missing", "That piece of content doesn't exist in this workspace.") };
  const cap = input.captionOverride !== undefined ? { caption: input.captionOverride, options: {} as PlatformOptions } : captionFor(content.captions, input.platform);
  if (!cap) return { error: fail("publishing.caption_missing", `"${content.title}" has no ${label(input.platform)} caption yet.`, "Write the captions package first (scripting).") };
  const media = input.media ?? content.media;
  if (!media) return { error: fail("publishing.media_missing", `"${content.title}" has no finished video yet.`, "Render and approve the edit first.") };

  const hasPublisher = Boolean(ws.providers.publisher);
  const mode: "auto" | "assist" = !hasPublisher ? "assist" : input.mode ?? (input.platform === "instagram" && !settings.instagram.autopost && !input.trial ? "assist" : "auto");
  const accounts = hasPublisher ? await freshAccounts(ws) : [];
  const account = input.accountId
    ? accounts.find((a) => a.providerAccountId === input.accountId)
    : accounts.find((a) => a.platform === input.platform && a.status === "connected") ?? accounts.find((a) => a.platform === input.platform);

  const postNumber = content.postNumber ?? (input.dryRun ? undefined : await ensurePostNumber(ws, content.id));
  const tracking = postNumber
    ? await trackingFor(ws, { platform: input.platform, keyword: content.keyword, postNumber, leadMagnetUrl: content.leadMagnetUrl, label: content.title, createShort: !input.dryRun })
    : { utmContent: `${content.keyword ? content.keyword.toLowerCase() : "post"}_<next post number>`, note: "The post number is assigned when the post is scheduled." };

  const options: PlatformOptions = { ...cap.options, ...input.options };
  if (input.trial) options.instagram = { ...options.instagram, trialReel: true, shareToFeed: false, trialGraduation: input.trial.graduation === "SS_PERFORMANCE" ? "SS_PERFORMANCE" : "MANUAL" };
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt).toISOString() : undefined;
  const request: PublishRequest = {
    idempotencyKey: postIdempotencyKey(content.id, input.platform, content.version, input.idempotencySuffix),
    accountId: account?.providerAccountId ?? "",
    platform: input.platform,
    caption: cap.caption,
    media: [media],
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
  let check = checkPayload({
    request, accounts, capabilities: capabilities(ws), now: ws.now(), leadMinutes: settings.leadMinutes,
    acknowledgements: ws.config.acknowledgements, cta: { type: content.ctaType, keyword: content.keyword },
  });
  if (input.scheduledAt && Number.isNaN(Date.parse(input.scheduledAt))) check = fail("publishing.schedule_format", "That time isn't a valid date.");
  if (mode === "assist") {
    const errors = check.errors.filter((e) => !ASSIST_IGNORED.has(e.code));
    check = { ok: errors.length === 0, errors, warnings: check.warnings };
  }
  return { content, request, check, mode, ...(account ? { account } : {}), tracking, title: content.title };
}

function previewOf(ws: WorkspaceContext, p: Prepared): SchedulePreview {
  return {
    platform: p.request.platform,
    ...(p.account ? { account: `@${p.account.handle}` } : {}),
    ...(p.request.scheduledAt ? { scheduledAt: p.request.scheduledAt, local: when(ws, p.request.scheduledAt) } : {}),
    caption: p.request.caption,
    ...(p.request.media[0] ? { media: p.request.media[0] } : {}),
    utmContent: p.tracking.utmContent,
    ...(p.tracking.trackedUrl ? { trackedUrl: p.tracking.trackedUrl } : {}),
    ...(p.tracking.shortLink ? { shortLink: p.tracking.shortLink } : {}),
    mode: p.mode,
    idempotencyKey: p.request.idempotencyKey,
  };
}

/** Bottom-of-funnel pieces and offer CTAs count as campaign posts under review_key. */
function isKeyPost(content: ContentForPost, explicit?: boolean): boolean {
  return explicit ?? (content.funnelStage === "bofu" || content.ctaType === "book_call");
}

/** Week plans are approved once for the whole week; otherwise each post is approved on its own. */
async function gatePost(ws: WorkspaceContext, post: PostRow, runId?: string | null): Promise<GateResult> {
  const payload = post.payload!;
  if (payload.planApproval) {
    // A batch the owner approved as a whole. Only a person's decision counts; agents can't approve their own work.
    const batch = await latestApproval(ws, payload.planApproval.subjectType, payload.planApproval.subjectId);
    if (batch?.status === "approved" && batch.decided_by && !batch.decided_by.startsWith("agent:")) return { allowed: true, via: "approved", ref: batch.ref };
    if (batch?.status === "rejected") return { allowed: false, status: "rejected", ref: batch.ref, created: false, note: batch.decision_note };
    if (batch?.status === "pending") return { allowed: false, status: "pending", ref: batch.ref, created: false };
  }
  if (payload.weekPlanId) {
    const plan = await latestApproval(ws, "week_plan", payload.weekPlanId, "campaign");
    if (plan?.status === "approved") return { allowed: true, via: "approved", ref: plan.ref };
    if (plan?.status === "pending") return { allowed: false, status: "pending", ref: plan.ref, created: false };
  }
  return gate(ws, {
    agent: AGENT, kind: "post", subjectType: "posts", subjectId: post.id, isKey: payload.isKey ?? false, runId: runId ?? null,
    summary: `Post "${payload.title}" to ${label(post.platform)} ${post.scheduled_at ? `on ${when(ws, post.scheduled_at)}` : "now"}`,
    preview: { platform: post.platform, caption: post.caption, scheduledAt: post.scheduled_at, media: payload.request.media[0] ?? null, utm_content: post.utm_content },
  });
}

export async function schedulePost(ws: WorkspaceContext, input: ScheduleInput): Promise<ScheduleOutcome> {
  const prep = await preparePost(ws, input);
  if ("error" in prep) return { outcome: "invalid", message: describeCheck(prep.error), check: prep.error };
  const preview = previewOf(ws, prep);
  if (!prep.check.ok) return { outcome: "invalid", message: describeCheck(prep.check), check: prep.check, preview };
  if (input.dryRun) {
    const what = prep.mode === "assist" ? "You'd get the file and caption to post yourself" : `Ready to schedule on ${label(input.platform)}`;
    return { outcome: "dry_run", message: `${what} ${input.scheduledAt ? `for ${when(ws, input.scheduledAt)}` : "now"}. Nothing was sent.${prep.check.warnings.length ? `\n${describeCheck(prep.check)}` : ""}`, check: prep.check, preview };
  }

  const payload: PostPayload = {
    request: prep.request, mode: prep.mode, title: prep.title, cta: { type: prep.content.ctaType, keyword: prep.content.keyword },
    isKey: isKeyPost(prep.content, input.isKey),
    ...(prep.tracking.trackedUrl ? { trackedUrl: prep.tracking.trackedUrl } : {}),
    ...(input.crossPostOf ? { crossPostOf: input.crossPostOf } : {}),
    ...(input.trial ? { trial: { variation: input.trial.variation, seed: input.trial.seed } } : {}),
    ...(input.weekPlanId ? { weekPlanId: input.weekPlanId } : {}),
    ...(input.planApproval ? { planApproval: input.planApproval } : {}),
  };
  const initial: PostStatus = prep.mode === "assist" ? "assist" : "draft";
  const row = {
    contentId: prep.content.id,
    socialAccountId: prep.account?.id ?? null,
    platform: input.platform,
    provider: ws.providers.publisher?.id ?? "manual",
    status: initial,
    scheduledAt: prep.request.scheduledAt ?? null,
    caption: prep.request.caption,
    utmContent: prep.tracking.utmContent,
    shortLink: prep.tracking.shortLink ?? null,
    isTrial: Boolean(input.trial),
    variantOf: input.trial?.variantOf ?? null,
    idempotencyKey: prep.request.idempotencyKey,
    payload,
  };
  let post: PostRow;
  const existing = await getPostByKey(ws, row.idempotencyKey);
  if (existing) {
    const rearmable = ["failed", "cancelled", "draft"].includes(existing.status) && !existing.provider_post_id;
    if (!rearmable) {
      return { outcome: "already_exists", message: `This post already exists (${existing.status}${existing.scheduled_at ? `, ${when(ws, existing.scheduled_at)}` : ""}). Nothing was sent twice.`, postId: existing.id, check: prep.check, preview };
    }
    post = await rearmPost(ws, existing.id, row);
  } else {
    post = (await insertPost(ws, row)).post;
  }
  // A trial reel never moves the piece itself along (its main post does).
  if (!input.trial) await advanceContent(ws, prep.content.id, "scheduled");

  if (prep.mode === "assist") {
    if (!prep.request.scheduledAt) await notifyAssist(ws, post);
    await activity(ws, AGENT, `Planned "${prep.title}" for ${label(input.platform)} ${prep.request.scheduledAt ? `on ${when(ws, prep.request.scheduledAt)}` : "now"}; you'll post it yourself`, { postId: post.id }, input.runId);
    return { outcome: "assist", message: `You'll get the file and caption ${prep.request.scheduledAt ? `before ${when(ws, prep.request.scheduledAt)}` : "now"} to post on ${label(input.platform)} yourself (trending audio can only be added in the app).`, postId: post.id, check: prep.check, preview };
  }

  const g = await gatePost(ws, post, input.runId);
  if (!g.allowed) {
    if (g.status === "rejected") return { outcome: "rejected", message: `This post was rejected (${g.ref})${g.note ? `: ${g.note}` : ""}. Change it, then schedule again.`, postId: post.id, approvalRef: g.ref, check: prep.check, preview };
    return { outcome: "awaiting_approval", message: `Waiting for your approval (${g.ref}). Once approved it goes out ${prep.request.scheduledAt ? `on ${when(ws, prep.request.scheduledAt)}` : "right away"}.`, postId: post.id, approvalRef: g.ref, check: prep.check, preview };
  }
  await updatePost(ws, post.id, { status: "queued" });
  const sent = await handOff(ws, post.id, input.runId);
  return { ...sent, postId: post.id, check: prep.check, preview, ...(g.ref ? { approvalRef: g.ref } : {}) };
}

function statusFrom(result: PublishResult): "published" | "failed" | "scheduled" | "publishing" {
  return result.status === "published" ? "published" : result.status === "failed" ? "failed" : result.status === "scheduled" ? "scheduled" : "publishing";
}

/**
 * Sends one queued post to the provider. Claims the row first (queued → publishing), re-validates against the latest
 * accounts snapshot, then calls the provider once.
 */
export async function handOff(ws: WorkspaceContext, postId: string, runId?: string | null): Promise<{ outcome: ScheduleOutcome["outcome"]; message: string }> {
  const publisher = ws.providers.publisher;
  if (!publisher) return { outcome: "queued", message: "Approved, but no publisher is connected. Connect Zernio or Blotato, or switch this post to assist." };
  const now = ws.now();
  const [claimed] = await ws.sql<PostRow[]>`
    update posts set status = 'publishing', updated_at = now(),
           payload = payload || ${ws.sql.json({ sendingAt: now.toISOString() } as never)}
     where workspace_id = ${ws.id} and id = ${postId} and status = 'queued'
     returning *`;
  if (!claimed) {
    const current = await getPost(ws, postId);
    return { outcome: (current?.status as ScheduleOutcome["outcome"]) ?? "failed", message: `Already ${current?.status ?? "gone"}.` };
  }
  const payload = claimed.payload;
  if (!payload?.request) {
    // Rows created outside the scheduler (imports, demo data) have no saved request to send.
    const message = "This post has no saved publishing details. Schedule it again from Studio.";
    await updatePost(ws, postId, { status: "failed", error: message });
    return { outcome: "failed", message };
  }
  let request = payload.request;
  if (request.scheduledAt && Date.parse(request.scheduledAt) <= now.getTime() + 2 * 60_000) {
    if (Date.parse(request.scheduledAt) < now.getTime() - LATE_GRACE_MS) {
      const message = `The slot (${when(ws, request.scheduledAt)}) passed while this post waited. Pick a new time and schedule it again.`;
      await updatePost(ws, postId, { status: "failed", error: message });
      return { outcome: "failed", message };
    }
    const { scheduledAt: _late, ...rest } = request;
    request = rest;
  }
  const settings = publishingSettings(ws.config);
  const check = checkPayload({
    request, accounts: await accountsSnapshot(ws), capabilities: publisher.capabilities(), now, leadMinutes: request.scheduledAt ? settings.leadMinutes : 0,
    acknowledgements: ws.config.acknowledgements, cta: payload.cta ?? { type: null },
  });
  if (!check.ok) {
    const message = describeCheck(check);
    await updatePost(ws, postId, { status: "failed", error: message });
    await notify(ws, { dedupeKey: `post-failed:${postId}`, text: `Couldn't post "${payload.title}" to ${label(claimed.platform)}:\n${message}`, priority: "high" });
    return { outcome: "failed", message };
  }
  try {
    const result = await publisher.publish(request);
    const status = statusFrom(result);
    const error = status === "failed" ? (result as PublishResult & { error?: string }).error ?? "The provider reported a failure." : null;
    await updatePost(ws, postId, {
      status, provider_post_id: result.providerPostId, platform_post_id: result.platformPostId ?? null, url: result.url ?? null, error,
      ...(status === "published" ? { published_at: now } : {}),
      ...(result.scheduledAt ? { scheduled_at: result.scheduledAt } : {}),
    });
    if (status === "published" && !claimed.is_trial) await advanceContent(ws, claimed.content_id, "published", now);
    const message = status === "failed"
      ? `${label(claimed.platform)} refused "${payload.title}": ${error}`
      : status === "scheduled"
        ? `Scheduled "${payload.title}" on ${label(claimed.platform)} for ${when(ws, result.scheduledAt ?? request.scheduledAt)}`
        : status === "published" ? `Posted "${payload.title}" on ${label(claimed.platform)}` : `Sending "${payload.title}" to ${label(claimed.platform)}`;
    if (status === "failed") await notify(ws, { dedupeKey: `post-failed:${postId}`, text: message, priority: "high" });
    await activity(ws, AGENT, message, { postId }, runId);
    return { outcome: status, message };
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError(publisher.id, "upstream", (err as Error).message);
    const idempotent = supportsIdempotency(ws);
    // 429 means the request was refused, so nothing went out. 5xx/network on a vendor without idempotency keys is
    // ambiguous: the post may exist. Never resend those automatically.
    const retry = e.code === "rate_limited" || (e.code === "upstream" && idempotent);
    if (retry) {
      await updatePost(ws, postId, { status: "queued", error: e.message });
      return { outcome: "queued", message: `${publisher.id} is busy; this post will be retried on the next run.` };
    }
    const ambiguous = e.code === "upstream";
    const message = ambiguous
      ? `We lost the answer from ${publisher.id} while sending "${payload.title}". It may have been posted: check the ${publisher.id} calendar before scheduling it again.`
      : `Couldn't post "${payload.title}" to ${label(claimed.platform)}: ${e.message}`;
    await updatePost(ws, postId, { status: "failed", error: message });
    await notify(ws, { dedupeKey: `post-failed:${postId}`, text: message, priority: "high" });
    await activity(ws, AGENT, message, { postId, code: e.code }, runId);
    return { outcome: "failed", message };
  }
}

/** ADR-13 assist: send the file and caption so the user posts natively (trending audio is app-only). */
export async function notifyAssist(ws: WorkspaceContext, post: PostRow): Promise<boolean> {
  const payload = post.payload;
  if (!payload?.request) return false;
  const media = payload.request.media[0];
  const lines = [
    `Time to post on ${label(post.platform)}: "${payload.title}"${post.scheduled_at ? ` (slot ${when(ws, post.scheduled_at)})` : ""}.`,
    "Add trending audio in the app, paste the caption below, then post.",
    "",
    post.caption ?? "",
    ...(media?.url && !media.localPath ? ["", `Video: ${media.url}`] : []),
    "",
    `When it's live, tell me the link and I'll track it (post ${post.id.slice(0, 8)}).`,
  ];
  const queued = await notify(ws, {
    dedupeKey: `assist:${post.id}`,
    text: lines.join("\n"),
    format: "plain",
    ref: `post-${post.id.slice(0, 8)}`,
    priority: "high",
    ...(media?.localPath ? { attachments: [{ localPath: media.localPath, caption: payload.title }] } : {}),
    actions: [{ id: `publishing:posted:${post.id}`, label: "I posted it", style: "primary" }],
  });
  await updatePost(ws, post.id, { payload: { ...payload, assistNotifiedAt: ws.now().toISOString() } });
  return queued;
}

export type DueSummary = { approved: number; sent: number; failed: number; assistNotified: number; refreshed: number; recovered: number; waiting: number };

/** `publishing.publish-due`: resumable sweep over every post that needs something done. */
export async function publishDue(ws: WorkspaceContext, opts: { limit?: number; runId?: string | null } = {}): Promise<DueSummary> {
  const limit = opts.limit ?? 25;
  const now = ws.now();
  const settings = publishingSettings(ws.config);
  const summary: DueSummary = { approved: 0, sent: 0, failed: 0, assistNotified: 0, refreshed: 0, recovered: 0, waiting: 0 };

  // 1. Drafts whose approval (or autonomy) now allows them.
  const drafts = await ws.sql<PostRow[]>`select * from posts where workspace_id = ${ws.id} and status = 'draft' order by scheduled_at nulls first limit ${limit}`;
  for (const d of drafts) {
    const g = await gatePost(ws, d, opts.runId);
    if (g.allowed) {
      await updatePost(ws, d.id, { status: "queued" });
      summary.approved++;
    } else if (g.status === "rejected") {
      await updatePost(ws, d.id, { status: "cancelled", error: `Rejected (${g.ref})${g.note ? `: ${g.note}` : ""}` });
    } else summary.waiting++;
  }

  // 2. Stale sends: a crash between "publishing" and the provider's answer.
  const stale = await ws.sql<PostRow[]>`
    select * from posts where workspace_id = ${ws.id} and status = 'publishing' and provider_post_id is null
       and updated_at < ${new Date(now.getTime() - STALE_SENDING_MS)}`;
  for (const p of stale) {
    if (supportsIdempotency(ws)) {
      await updatePost(ws, p.id, { status: "queued" });
    } else {
      const message = `We lost track of "${p.payload?.title ?? "a post"}" while sending it. Check your ${p.provider} calendar before scheduling it again.`;
      await updatePost(ws, p.id, { status: "failed", error: message });
      await notify(ws, { dedupeKey: `post-failed:${p.id}`, text: message, priority: "high" });
    }
    summary.recovered++;
  }

  // 3. Queued posts go to the provider.
  const queued = await ws.sql<{ id: string }[]>`select id from posts where workspace_id = ${ws.id} and status = 'queued' order by scheduled_at nulls first limit ${limit}`;
  for (const q of queued) {
    const r = await handOff(ws, q.id, opts.runId);
    if (r.outcome === "failed") summary.failed++;
    else if (r.outcome !== "queued") summary.sent++;
  }

  // 4. Assist reminders that are due.
  const assistBefore = new Date(now.getTime() + settings.instagram.assistLeadMinutes * 60_000);
  const assist = await ws.sql<PostRow[]>`
    select * from posts where workspace_id = ${ws.id} and status = 'assist'
       and (scheduled_at is null or scheduled_at <= ${assistBefore})
       and not (payload ? 'assistNotifiedAt')
     limit ${limit}`;
  for (const a of assist) if (await notifyAssist(ws, a)) summary.assistNotified++;

  // 5. Refresh posts in flight whose time has come (webhooks usually do this first).
  const inflight = await ws.sql<PostRow[]>`
    select * from posts where workspace_id = ${ws.id} and status in ('scheduled', 'publishing') and provider_post_id is not null
       and (scheduled_at is null or scheduled_at < ${new Date(now.getTime() - 2 * 60_000)})
     order by scheduled_at nulls first limit ${limit}`;
  for (const p of inflight) {
    if (!ws.providers.publisher) break;
    try {
      const res = await ws.providers.publisher.getPost(p.provider_post_id!);
      await applyResult(ws, p, res);
      summary.refreshed++;
    } catch (err) {
      ws.log.warn("publishing: status check failed", { postId: p.id, error: (err as Error).message });
    }
  }
  return summary;
}

async function applyResult(ws: WorkspaceContext, post: PostRow, res: PublishResult & { error?: string }): Promise<void> {
  const status = statusFrom(res);
  if (status === post.status && (res.url ?? null) === post.url && (res.platformPostId ?? null) === post.platform_post_id) return;
  await updatePost(ws, post.id, {
    status,
    ...(res.url ? { url: res.url } : {}),
    ...(res.platformPostId ? { platform_post_id: res.platformPostId } : {}),
    ...(status === "published" && !post.published_at ? { published_at: ws.now() } : {}),
    ...(status === "failed" ? { error: res.error ?? "The provider reported a failure." } : {}),
  });
  if (status === "published") {
    if (!post.is_trial) await advanceContent(ws, post.content_id, "published", ws.now());
    await activity(ws, AGENT, `"${post.payload?.title ?? "A post"}" is live on ${label(post.platform)}`, { postId: post.id, url: res.url });
  }
  if (status === "failed" && post.status !== "failed") {
    await notify(ws, { dedupeKey: `post-failed:${post.id}`, text: `"${post.payload?.title ?? "A post"}" failed on ${label(post.platform)}: ${res.error ?? "no reason given"}`, priority: "high" });
  }
}

/** Structural copy of the provider webhook events this module consumes (modules never import vendor packages). */
export type PublishEventLike = {
  type: string;
  providerPostId?: string;
  idempotencyKey?: string;
  platforms?: { platform?: Platform; status?: string; platformPostId?: string; url?: string; error?: string }[];
};

/** Applies a normalised `post.*` webhook event. Returns the post it touched, if any. */
export async function applyPublishEvent(ws: WorkspaceContext, event: PublishEventLike): Promise<PostRow | undefined> {
  if (!event.type.startsWith("post.") || event.type.startsWith("post.external.")) return undefined;
  let post: PostRow | undefined;
  if (event.idempotencyKey) post = await getPostByKey(ws, event.idempotencyKey);
  if (!post && event.providerPostId) {
    const rows = await ws.sql<PostRow[]>`select * from posts where workspace_id = ${ws.id} and provider_post_id = ${event.providerPostId} limit 1`;
    post = rows[0];
  }
  if (!post) return undefined;
  const entry = event.platforms?.find((p) => p.platform === post!.platform) ?? event.platforms?.[0];
  const t = event.type;
  let status: PublishResult["status"] | "cancelled" | undefined;
  if (t === "post.published" || t === "post.platform.published") status = "published";
  else if (t === "post.failed" || t === "post.platform.failed") status = "failed";
  else if (t === "post.scheduled") status = "scheduled";
  else if (t === "post.partial") status = entry?.status === "published" ? "published" : entry?.status === "failed" ? "failed" : undefined;
  else if (t === "post.cancelled") status = "cancelled";
  if (status === "cancelled") {
    await updatePost(ws, post.id, { status: "cancelled" });
    return getPost(ws, post.id);
  }
  if (t === "post.tiktok.url_resolved" && entry?.url) {
    await updatePost(ws, post.id, { url: entry.url });
    return getPost(ws, post.id);
  }
  if (t === "post.platform.deleted") {
    await updatePost(ws, post.id, { error: "Removed from the platform after it was posted." });
    return getPost(ws, post.id);
  }
  if (!status) return post;
  await applyResult(ws, post, {
    providerPostId: event.providerPostId ?? post.provider_post_id ?? "",
    status,
    ...(entry?.url ? { url: entry.url } : {}),
    ...(entry?.platformPostId ? { platformPostId: entry.platformPostId } : {}),
    ...(entry?.error ? { error: entry.error } : {}),
  });
  return getPost(ws, post.id);
}

export async function cancelPost(ws: WorkspaceContext, postId: string): Promise<{ ok: boolean; message: string }> {
  const post = await getPost(ws, postId);
  if (!post) return { ok: false, message: "No post with that id." };
  if (post.status === "published") return { ok: false, message: "That post is already live. Delete it on the platform itself." };
  if (post.status === "cancelled") return { ok: true, message: "Already cancelled." };
  if (post.provider_post_id && ["scheduled", "publishing", "queued"].includes(post.status)) {
    if (!ws.providers.publisher) return { ok: false, message: "No publisher is connected, so the scheduled post can't be cancelled from here." };
    await ws.providers.publisher.cancel(post.provider_post_id);
  }
  await updatePost(ws, postId, { status: "cancelled" });
  await ws.sql`
    update approvals set status = 'expired', decided_at = now(), decision_note = 'post cancelled'
     where workspace_id = ${ws.id} and subject_type = 'posts' and subject_id = ${postId} and status = 'pending'`;
  await activity(ws, AGENT, `Cancelled "${post.payload?.title ?? "a post"}" on ${label(post.platform)}`, { postId });
  return { ok: true, message: `Cancelled "${post.payload?.title ?? "the post"}" on ${label(post.platform)}.` };
}

/** Upcoming slots already used on a platform. */
async function takenSlots(ws: WorkspaceContext, from: Date): Promise<{ platform: Platform; scheduledAt: string }[]> {
  const rows = await ws.sql<{ platform: Platform; scheduled_at: Date }[]>`
    select platform, scheduled_at from posts
     where workspace_id = ${ws.id} and status not in ('cancelled', 'failed') and scheduled_at >= ${from}`;
  return rows.map((r) => ({ platform: r.platform, scheduledAt: new Date(r.scheduled_at).toISOString() }));
}

/** Next open cadence slot on a platform, this week or next. */
export async function nextOpenSlot(ws: WorkspaceContext, platform: Platform): Promise<string | undefined> {
  const settings = publishingSettings(ws.config);
  const cadence = settings.cadence[platform];
  if (!cadence || cadence.perWeek === 0) return undefined;
  const tz = ws.config.workspace.timezone;
  const now = ws.now();
  const taken = await takenSlots(ws, now);
  for (const weekStart of [mondayOf(localDate(now, tz)), nextMonday(now, tz), addDays(nextMonday(now, tz), 7)]) {
    const slots = planSlots(platform, cadence, { weekStart, timezone: tz, taken, now, leadMinutes: settings.leadMinutes });
    if (slots[0]) return slots[0].utc.toISOString();
  }
  return undefined;
}

export type WeekResult = { manifest: WeekManifest; table: string; dryRun: boolean; outcomes: (ScheduleOutcome & { contentId: string; platform: Platform })[]; approvalRef?: string; message: string };

/** `publishing.schedule-week`: plan next week (dry run by default), then schedule it once approved. */
export async function scheduleWeek(ws: WorkspaceContext, opts: { weekStart?: string; dryRun: boolean; runId?: string | null }): Promise<WeekResult> {
  const settings = publishingSettings(ws.config);
  const tz = ws.config.workspace.timezone;
  const now = ws.now();
  const weekStart = opts.weekStart ? mondayOf(opts.weekStart) : nextMonday(now, tz);
  const accounts = ws.providers.publisher ? (await freshAccounts(ws)).filter((a) => a.status === "connected") : [];
  const ready = await readyContent(ws);
  const posted = await platformsWithPosts(ws, ready.map((c) => c.id));
  const items: ManifestItem[] = ready.map((c) => {
    const platforms = (Object.keys(c.captions ?? {}) as Platform[]).filter((p) => !posted.get(c.id)?.has(p));
    return { contentId: c.id, title: c.title, platforms, version: c.version };
  }).filter((i) => i.platforms.length > 0);
  // Without a publisher, every platform is planned as assist against a placeholder account.
  const planAccounts = ws.providers.publisher
    ? accounts.map((a) => ({ platform: a.platform, providerAccountId: a.providerAccountId, handle: a.handle }))
    : ws.config.platforms.map((p) => ({ platform: p, providerAccountId: "", handle: "you" }));
  const manifest = buildWeekManifest({
    weekStart, timezone: tz, cadence: settings.cadence, accounts: planAccounts,
    supportedPlatforms: capabilities(ws).platforms, enabledPlatforms: ws.config.platforms,
    items, taken: await takenSlots(ws, zonedStart(weekStart, tz)), now, leadMinutes: settings.leadMinutes,
    instagramAutopost: settings.instagram.autopost && Boolean(ws.providers.publisher),
  });
  if (!ws.providers.publisher) for (const e of manifest.entries) e.mode = "assist";
  const table = manifestTable(manifest);
  if (opts.dryRun) {
    return { manifest, table, dryRun: true, outcomes: [], message: `Week of ${weekStart}: ${manifest.entries.length} post${manifest.entries.length === 1 ? "" : "s"} planned, ${manifest.openSlots.length} open slot${manifest.openSlots.length === 1 ? "" : "s"}. Dry run: nothing was scheduled.` };
  }
  const weekPlanId = uuidFrom(`${ws.id}:week:${weekStart}`);
  const planGate = manifest.entries.some((e) => e.mode === "auto")
    ? await gate(ws, { agent: AGENT, kind: "campaign", subjectType: "week_plan", subjectId: weekPlanId, isKey: false, runId: opts.runId ?? null, summary: `Posting plan for the week of ${weekStart} (${manifest.entries.length} posts)`, preview: { weekStart, table } })
    : undefined;
  const outcomes: WeekResult["outcomes"] = [];
  for (const e of manifest.entries) {
    const o = await schedulePost(ws, { contentId: e.contentId, platform: e.platform, scheduledAt: e.scheduledAt, dryRun: false, mode: e.mode, weekPlanId, runId: opts.runId ?? null });
    outcomes.push({ ...o, contentId: e.contentId, platform: e.platform });
  }
  const counts = outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.outcome]: (acc[o.outcome] ?? 0) + 1 }), {});
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`);
  const ref = planGate && !planGate.allowed ? planGate.ref : undefined;
  return {
    manifest, table, dryRun: false, outcomes, ...(ref ? { approvalRef: ref } : {}),
    message: `Week of ${weekStart}: ${parts.join(", ") || "nothing to schedule"}.${ref ? ` Approve ${ref} to send the plan.` : ""}`,
  };
}

function zonedStart(weekStart: string, tz: string): Date {
  return zonedToUtc(weekStart, "00:00", tz);
}

export type CrossPostInput = {
  /** An Instagram post row to copy. */
  sourcePostId?: string;
  /** Or a piece of content whose Instagram post (or render) is copied. */
  contentId?: string;
  /** Backfill: the newest N Instagram posts that haven't been cross-posted yet. */
  backfill?: number;
  platforms?: Platform[];
  scheduledAt?: string;
  dryRun: boolean;
  runId?: string | null;
};

/** `publishing.cross-post`: queue a reel already on Instagram to the other platforms, swapping keyword CTAs for a link. */
export async function crossPost(ws: WorkspaceContext, input: CrossPostInput): Promise<{ outcomes: (ScheduleOutcome & { contentId: string; platform: Platform })[]; message: string }> {
  const settings = publishingSettings(ws.config);
  const targets = (input.platforms ?? settings.crossPost.platforms).filter((p) => p !== "instagram" && ws.config.platforms.includes(p));
  const sources: { contentId: string; post?: PostRow }[] = [];
  if (input.sourcePostId) {
    const p = await getPost(ws, input.sourcePostId);
    if (!p || !p.content_id) return { outcomes: [], message: "That post isn't linked to a piece of content, so there's nothing to copy." };
    sources.push({ contentId: p.content_id, post: p });
  } else if (input.contentId) {
    const [p] = await ws.sql<PostRow[]>`select * from posts where workspace_id = ${ws.id} and content_id = ${input.contentId} and platform = 'instagram' and status not in ('cancelled', 'failed') order by created_at desc limit 1`;
    sources.push({ contentId: input.contentId, ...(p ? { post: p } : {}) });
  } else if (input.backfill) {
    const rows = await ws.sql<PostRow[]>`
      select p.* from posts p
       where p.workspace_id = ${ws.id} and p.platform = 'instagram' and p.status = 'published' and p.content_id is not null and not p.is_trial
         and exists (
           select 1 from unnest(${targets}::text[]) t(platform)
            where not exists (select 1 from posts q where q.workspace_id = p.workspace_id and q.content_id = p.content_id and q.platform = t.platform and q.status not in ('cancelled', 'failed'))
         )
       order by p.published_at desc nulls last
       limit ${input.backfill}`;
    for (const r of rows) sources.push({ contentId: r.content_id!, post: r });
  } else {
    return { outcomes: [], message: "Say which post to cross-post, or how many recent Instagram posts to backfill." };
  }

  const outcomes: (ScheduleOutcome & { contentId: string; platform: Platform })[] = [];
  for (const src of sources) {
    const content = await loadContent(ws, src.contentId);
    if (!content) continue;
    const media = src.post?.payload?.request.media[0] ?? content.media ?? undefined;
    const postNumber = content.postNumber ?? (input.dryRun ? undefined : await ensurePostNumber(ws, content.id));
    for (const platform of targets) {
      const base = captionFor(content.captions, platform)?.caption ?? src.post?.caption ?? "";
      let caption = base;
      if (content.keyword && postNumber) {
        const t = await trackingFor(ws, { platform, keyword: content.keyword, postNumber, leadMagnetUrl: content.leadMagnetUrl, label: `${content.title} (${platform})`, createShort: !input.dryRun });
        caption = swapKeywordCta({ caption: base, keyword: content.keyword, platform, ...(t.shortLink ?? t.trackedUrl ? { link: (t.shortLink ?? t.trackedUrl)! } : {}), linkLine: settings.crossPost.linkLine, linkInBioLine: settings.crossPost.linkInBioLine }).caption;
      } else if (content.keyword) {
        caption = swapKeywordCta({ caption: base, keyword: content.keyword, platform, linkLine: settings.crossPost.linkLine, linkInBioLine: settings.crossPost.linkInBioLine }).caption;
      }
      const scheduledAt = input.scheduledAt ?? (await nextOpenSlot(ws, platform));
      const o = await schedulePost(ws, {
        contentId: content.id, platform, dryRun: input.dryRun, captionOverride: caption, mode: "auto",
        ...(scheduledAt ? { scheduledAt } : {}),
        ...(media ? { media } : {}),
        ...(src.post ? { crossPostOf: src.post.id } : {}),
        ...(captionFor(content.captions, platform)?.options ? { options: captionFor(content.captions, platform)!.options } : platform === "youtube" ? { options: { youtube: { title: content.title.slice(0, 99), privacy: "public", madeForKids: false, shorts: true } } } : platform === "tiktok" ? { options: { tiktok: { privacy: "public", aiGenerated: false } } } : {}),
        runId: input.runId ?? null,
      });
      outcomes.push({ ...o, contentId: content.id, platform });
    }
  }
  const ok = outcomes.filter((o) => o.outcome !== "invalid" && o.outcome !== "failed").length;
  return { outcomes, message: `${input.dryRun ? "Dry run: " : ""}${ok} of ${outcomes.length} cross-post${outcomes.length === 1 ? "" : "s"} ${input.dryRun ? "would be queued" : "queued"}.` };
}

export { describeCheck };
