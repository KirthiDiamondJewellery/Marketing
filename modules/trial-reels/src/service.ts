import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { compact, type Actor, type JobContext, type WorkspaceContext } from "@attentionos/core";
import { requestApproval } from "@attentionos/db";
import { mediaPy, MediaPyError } from "@attentionos/media";
import { renderClean } from "@attentionos/module-editing";
import {
  activity, cancelPost, freshAccounts, getPost, getTrialProof, latestApproval, notify, publishingSettings, schedulePost, type ScheduleOutcome,
} from "@attentionos/module-publishing";
import { DAY_MS, fitUnderCap, LAYOUTS, localDate, slots } from "./plan.ts";
import {
  claimLedger, getBatch, ledger, postingPlan, settleLedger, updateBatch, type BatchManifest, type BatchRow, type BatchSource, type BatchStatus,
  type BatchVariant, type BatchVerify, type PlannedPost,
} from "./repo.ts";
import { graduationStrategy, trialReelsSettings } from "./settings.ts";

/**
 * Trial reels end to end:
 *   make:     clean video (an approved edit rendered without captions/title, or an uploaded clean reel) → word timings
 *             (the workspace's speech-to-text) → media-py `trial-render` → `trial-verify` → media assets + preview.
 *   schedule: verify still holds → the owner's OK (an approval a person decided) → risk notice → publisher can post
 *             trial reels → connected Instagram account → proof lock → rolling 24h cap → ledger → publishing.
 * Posts go out as Instagram trial reels only (never the main grid); graduation stays MANUAL unless the owner turned
 * on automatic.
 */

export const SUBJECT = "trial_reel_batch";
export const JOB_IDS = { make: "trial-reels.make", schedule: "trial-reels.schedule", cancel: "trial-reels.cancel" } as const;
const AGENT = "publisher" as const;
const IN_FLIGHT: BatchStatus[] = ["scheduling", "proving", "scheduled", "partial"];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function workDirFor(ws: WorkspaceContext, batch: Pick<BatchRow, "post_date" | "ref">): string {
  return join(ws.paths.media, "trial-reels", batch.post_date, batch.ref);
}

function problem(err: unknown): string {
  if (err instanceof MediaPyError) return err.fix ? `${err.message} ${err.fix}` : err.message;
  const e = err as { message?: string; hint?: string };
  return e?.hint ? `${e.message} ${e.hint}` : e?.message ?? String(err);
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function insertAsset(ws: WorkspaceContext, a: { kind: string; uri: string; durationS?: number | null; sha256?: string | null; provenance: Record<string, unknown> }): Promise<string> {
  const [row] = await ws.sql<{ id: string }[]>`
    insert into media_assets (workspace_id, content_id, kind, uri, duration_s, width, height, sha256, provenance, license)
    values (${ws.id}, null, ${a.kind}, ${a.uri}, ${a.durationS ?? null}, ${a.kind === "render" ? 1080 : null}, ${a.kind === "render" ? 1920 : null},
            ${a.sha256 ?? null}, ${ws.sql.json(a.provenance as never)}, 'own footage')
    returning id`;
  return row!.id;
}

// ---------------------------------------------------------------------------------------------------------------
// make: render + verify
// ---------------------------------------------------------------------------------------------------------------

type RenderManifest = {
  variants: (BatchVariant & { sourceDuration: number; renderS?: number })[];
  timings?: Record<string, number>;
  partial?: boolean;
};
type VerifyReport = BatchVerify & { preview: string | null; posters: Record<string, string>; partial?: boolean; clean?: number };

async function sourcePath(ws: WorkspaceContext, s: BatchSource, ctx: JobContext<unknown>, say: (m: string) => Promise<void>): Promise<string> {
  if (s.kind === "edit") {
    const clean = await renderClean(ws, s.editRef!, { signal: ctx.signal, onProgress: (m) => void say(m).catch(() => {}) });
    return clean.path;
  }
  const [a] = await ws.sql<{ uri: string }[]>`select uri from media_assets where workspace_id = ${ws.id} and id = ${s.assetId}`;
  if (!a) throw new Error(`The clean reel “${s.name}” is gone. Upload it again.`);
  const path = isAbsolute(a.uri) ? a.uri : resolve(ws.paths.root, a.uri);
  if (!existsSync(path)) throw new Error(`The file for “${s.name}” is missing (${a.uri}).`);
  return path;
}

/** `trial-reels.make`: renders and verifies a batch. Never runs on a batch that already has scheduled posts. */
export async function makeBatch(ctx: JobContext<{ batchId: string }>): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const batch = await getBatch(ws, ctx.input.batchId);
  if (!batch) return { skipped: "That batch is gone." };
  if (IN_FLIGHT.includes(batch.status) || batch.status === "cancelled") {
    return { skipped: `${batch.ref} is ${batch.status}; rendering it again could post the same reels twice. Make a new batch for another day.` };
  }
  const settings = trialReelsSettings(ws.config);
  const work = workDirFor(ws, batch);
  const say = async (m: string) => {
    await updateBatch(ws, batch.id, { progress: m });
    await ctx.progress(m);
  };
  await updateBatch(ws, batch.id, { status: "rendering", error: null, work_dir: work, manifest: null, verify: null, preview_asset_id: null, progress: "Getting the clean videos ready" });
  const started = Date.now();
  try {
    const reels: Record<string, unknown>[] = [];
    const words: Record<string, { text: string; start: number; end: number }[]> = {};
    for (const s of batch.sources) {
      const path = await sourcePath(ws, s, ctx, say);
      if (ws.providers.asr) {
        await say(`Listening to “${s.name}” for the captions`);
        const t = await ws.providers.asr.transcribe(path);
        words[s.slug] = t.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
      }
      const layout = LAYOUTS[s.layout] ?? LAYOUTS["talking-head"];
      reels.push(compact({
        slug: s.slug, file: path, titles: s.titles, titleX: layout.titleX, titleY: layout.titleY, titleSeconds: layout.titleSeconds ?? undefined,
        captionY: layout.captionY, cta: s.cta ? { text: s.cta.text } : undefined, captionLine: s.captionLine ?? undefined, hashtags: s.hashtags,
      }));
    }
    await say(`Rendering ${plural(batch.total, "trial reel")}`);
    const manifest = await mediaPy<RenderManifest>(
      "trial-render",
      { date: batch.post_date, total: batch.total, reels, speeds: settings.speeds, workDir: work, words, fetchFonts: true },
      { signal: ctx.signal, onProgress: (m) => void say(m).catch(() => {}) },
    );
    await say("Checking every variation: format, length, captions, title and end ask");
    const verify = await mediaPy<VerifyReport>("trial-verify", { workDir: work }, { signal: ctx.signal, onProgress: (m) => void say(m).catch(() => {}) });

    const variants: BatchVariant[] = [];
    for (const v of manifest.variants) {
      const durationS = Math.round((v.sourceDuration / v.speed) * 1000) / 1000;
      const sha = verify.files[v.id] ?? null;
      const assetId = await insertAsset(ws, { kind: "render", uri: v.file, durationS, sha256: sha, provenance: { source: "trial-reels", batch: batch.ref, variant: v.id, speed: v.speed, grade: v.grade } });
      const poster = verify.posters?.[v.id];
      const posterId = poster ? await insertAsset(ws, { kind: "image", uri: poster, provenance: { source: "trial-reels", batch: batch.ref, variant: v.id, role: "poster" } }) : null;
      variants.push({
        id: v.id, reel: v.reel, index: v.index, speed: v.speed, grade: v.grade, captionStyle: v.captionStyle, titleStyle: v.titleStyle, ctaStyle: v.ctaStyle,
        title: v.title, postCaption: v.postCaption, file: v.file, ...(sha ? { sha256: sha } : {}), durationS, assetId, posterId,
      });
    }
    const previewId = verify.preview ? await insertAsset(ws, { kind: "image", uri: verify.preview, provenance: { source: "trial-reels", batch: batch.ref, role: "preview" } }) : null;
    const timings = { ...manifest.timings, wallS: Math.round((Date.now() - started) / 100) / 10 };
    const stored: BatchManifest = { variants, timings, partial: Boolean(manifest.partial) };
    const verdict: BatchVerify = { ok: verify.ok, count: verify.count, failures: verify.failures, files: verify.files };
    if (!verify.ok) {
      const why = verify.failures.slice(0, 3).join("; ");
      await updateBatch(ws, batch.id, { status: "failed", manifest: stored, verify: verdict, preview_asset_id: previewId, progress: null, error: `The check found problems, so nothing can be scheduled: ${why}` });
      await activity(ws, AGENT, `Trial reels for ${batch.post_date} didn't pass the check (${batch.ref}): ${why}`, { batch: batch.ref }, ctx.runId);
      return { ref: batch.ref, ok: false, failures: verify.failures };
    }
    await updateBatch(ws, batch.id, { status: "ready", manifest: stored, verify: verdict, preview_asset_id: previewId, progress: null, error: null });
    const names = batch.sources.map((s) => `“${s.name}”`).join(", ");
    const message = `${plural(variants.length, "trial reel")} of ${names} are ready to check for ${batch.post_date}. Nothing is scheduled until you OK them.`;
    await activity(ws, AGENT, message, { batch: batch.ref, previewAssetId: previewId }, ctx.runId);
    await notify(ws, {
      dedupeKey: `trial-reels:${batch.ref}:ready`, ref: batch.ref, text: `${message} Open Studio to look them over, then press Schedule.`,
      ...(verify.preview ? { attachments: [{ localPath: verify.preview, caption: `${batch.ref} preview` }] } : {}),
    });
    return { ref: batch.ref, ok: true, variants: variants.length, preview: verify.preview, timings };
  } catch (err) {
    const message = problem(err);
    await updateBatch(ws, batch.id, { status: "failed", progress: null, error: message });
    await activity(ws, AGENT, `Couldn't make the trial reels (${batch.ref}): ${message}`, { batch: batch.ref }, ctx.runId);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------------------------------------------

export type ScheduleBatchResult = {
  ok: boolean;
  message: string;
  status?: BatchStatus;
  approvalRef?: string;
  plan?: { variantId: string; at: string | null; title: string; caption: string }[];
  sent?: number;
  proving?: boolean;
};

const viewPlan = (plan: PlannedPost[]) => plan.map((p) => ({ variantId: p.variantId, at: p.at ? p.at.toISOString() : null, title: p.title, caption: p.postCaption }));

/** Every rendered file must be byte-for-byte the one that passed the check. */
async function stillVerified(batch: BatchRow): Promise<string | null> {
  const v = batch.verify;
  const variants = batch.manifest?.variants ?? [];
  if (!v?.ok || !variants.length) return "These trial reels didn't pass the check. Make them again.";
  if (batch.manifest?.partial || v.count !== variants.length) return "Only part of the day was rendered. Make the full batch first.";
  for (const variant of variants) {
    if (!existsSync(variant.file)) return `${variant.id} is missing from disk. Make the batch again.`;
    if ((await sha256File(variant.file)) !== v.files[variant.id]) return `${variant.id} changed after it was checked. Make the batch again.`;
  }
  return null;
}

/** Content rows for uploaded clean reels (posts belong to a piece of content). Created once, when first scheduled. */
async function ensureContent(ws: WorkspaceContext, batch: BatchRow, actor: string): Promise<BatchSource[]> {
  let changed = false;
  const sources: BatchSource[] = [];
  for (const s of batch.sources) {
    if (s.contentId) {
      sources.push(s);
      continue;
    }
    const [c] = await ws.sql<{ id: string }[]>`
      insert into content (workspace_id, title, status, kind, source_refs, created_by)
      values (${ws.id}, ${s.titles[0] ?? s.name}, 'scheduled', 'reel', ${ws.sql.json([{ type: "manual", id: s.assetId, url: null }] as never)}, ${actor})
      returning id`;
    sources.push({ ...s, contentId: c!.id });
    changed = true;
  }
  if (changed) await ws.sql`update trial_reel_batches set sources = ${ws.sql.json(sources as never)}, updated_at = now() where workspace_id = ${ws.id} and id = ${batch.id}`;
  return sources;
}

/** Times of the account's other posts (not this batch's), for the rolling cap. */
async function otherPostTimes(ws: WorkspaceContext, accountId: string, batchId: string, around: Date[]): Promise<Date[]> {
  if (!around.length) return [];
  const from = new Date(Math.min(...around.map((d) => d.getTime())) - DAY_MS);
  const to = new Date(Math.max(...around.map((d) => d.getTime())) + DAY_MS);
  const rows = await ws.sql<{ at: Date }[]>`
    select coalesce(p.scheduled_at, p.published_at, p.created_at) as at from posts p
     where p.workspace_id = ${ws.id} and p.social_account_id = ${accountId} and p.status not in ('cancelled', 'failed')
       and coalesce(p.scheduled_at, p.published_at, p.created_at) between ${from} and ${to}
       and not exists (select 1 from trial_reel_posts l where l.workspace_id = p.workspace_id and l.batch_id = ${batchId} and l.post_id = p.id)`;
  return rows.map((r) => new Date(r.at));
}

/**
 * `trial-reels.schedule`. Dry run: returns the plan and sends nothing. Otherwise needs a person's approval of the
 * batch (asked for here when missing, so an agent can start it but never finish it alone), then sends what isn't in
 * the ledger yet. Until the account's first trial reel has been checked by a person, only ONE goes out, right away.
 */
export async function scheduleBatch(
  ws: WorkspaceContext,
  input: { batchId: string; dryRun: boolean; runId?: string | null; actor?: Actor | string },
): Promise<ScheduleBatchResult> {
  const res = await scheduleBatchSteps(ws, input);
  if (!input.dryRun) {
    // Whatever happened, Studio stops showing "Scheduling" and shows why when it didn't go out.
    await ws.sql`update trial_reel_batches set progress = null, error = ${res.ok || res.proving || res.approvalRef ? null : res.message}, updated_at = now()
                  where workspace_id = ${ws.id} and id::text = ${input.batchId}`;
  }
  return res;
}

async function scheduleBatchSteps(
  ws: WorkspaceContext,
  input: { batchId: string; dryRun: boolean; runId?: string | null; actor?: Actor | string },
): Promise<ScheduleBatchResult> {
  const batch = await getBatch(ws, input.batchId);
  if (!batch) return { ok: false, message: "That trial-reel batch doesn't exist." };
  if (batch.status === "queued" || batch.status === "rendering") return { ok: false, message: `${batch.ref} is still being made.`, status: batch.status };
  if (batch.status === "cancelled") return { ok: false, message: `${batch.ref} was cancelled.`, status: batch.status };
  const unverified = await stillVerified(batch);
  if (unverified) return { ok: false, message: unverified, status: batch.status };

  const settings = trialReelsSettings(ws.config);
  const tz = ws.config.workspace.timezone;
  const lead = publishingSettings(ws.config).leadMinutes;
  // What stops a real run. A dry run still shows the day's plan and lists these.
  const blockers: string[] = [];
  if (!ws.config.acknowledgements.trialReelsRisk) blockers.push("Trial reels need the platform-risk notice accepted first (Settings → Notices → Trial reels, or acknowledgements.trialReelsRisk in your config).");
  const publisher = ws.providers.publisher;
  if (!publisher) blockers.push("No publisher is connected, so trial reels can't be scheduled. Connect Zernio in Settings.");
  else if (!publisher.capabilities().instagramTrialReels) blockers.push(`${publisher.id} can't post Instagram trial reels.`);
  const account = publisher ? (await freshAccounts(ws)).find((a) => a.platform === "instagram" && a.status === "connected") : undefined;
  if (publisher && !account) blockers.push("No connected Instagram account. Reconnect it in your publisher.");
  if (blockers.length && !input.dryRun) return { ok: false, message: blockers[0]!, status: batch.status };

  const proof = account ? await getTrialProof(ws, account.providerAccountId) : undefined;
  const led = await ledger(ws, batch.id);
  const postedNow = new Set(led.filter((l) => l.scheduled_at === null).map((l) => l.variant_id));
  const variants = batch.manifest!.variants;
  // Without an account to check (dry run only), show the full day.
  const proven = Boolean(proof) || !account;

  let plan: PlannedPost[];
  if (!proven) {
    if (postedNow.size) {
      const first = led.find((l) => l.scheduled_at === null)!;
      return {
        ok: false, status: "proving", proving: true,
        message: `The first trial reel (${first.variant_id}) went out to check that trial reels stay off your grid. Look at your profile: when it's live and NOT on your grid, confirm it in Studio (Calendar → that post → “It stayed off my grid”). Then schedule the rest.`,
      };
    }
    plan = postingPlan(batch, { window: settings.window, timezone: tz, count: 1 }).map((p) => ({ ...p, at: null }));
  } else {
    const wanted = variants.length - postedNow.size;
    const slotsFor = (n: number) => slots(batch.post_date, n, settings.window, tz);
    const existing = account ? await otherPostTimes(ws, account.id, batch.id, slotsFor(wanted)) : [];
    const count = fitUnderCap({ wanted, existing, cap: settings.dailyCap, slotsFor });
    if (count === 0) return { ok: false, message: `The 24-hour cap of ${settings.dailyCap} posts on @${account?.handle ?? "your account"} is already reached around ${batch.post_date}. Pick another day.`, status: batch.status };
    plan = postingPlan(batch, { window: settings.window, timezone: tz, postedNow, count });
    const moved = led.filter((l) => l.scheduled_at && plan.find((p) => p.variantId === l.variant_id)?.at?.getTime() !== new Date(l.scheduled_at).getTime());
    if (moved.length) return { ok: false, message: `${plural(moved.length, "trial reel is", "trial reels are")} already scheduled at other times (${moved[0]!.variant_id} first). Change the settings back, or cancel the batch and make a new one.`, status: batch.status };
    const done = new Set(led.map((l) => l.variant_id));
    const missed = plan.filter((p) => !done.has(p.variantId) && p.at && p.at.getTime() < ws.now().getTime() + Math.max(lead, 10) * 60_000);
    if (missed.length) return { ok: false, message: `${plural(missed.length, "slot")} on ${batch.post_date} ${missed.length === 1 ? "has" : "have"} already passed (${missed[0]!.variantId} first). Make the batch for a later day.`, status: batch.status };
    if (count < wanted) plan = plan.slice(0, count);
  }

  const capped = proven && plan.length < variants.length - postedNow.size;
  const summary = proven
    ? `${plural(plan.length, "trial reel")} on ${batch.post_date}, ${settings.window.start}–${settings.window.end} ${tz.replace(/_/g, " ")}${capped ? ` (the 24-hour cap leaves room for ${plan.length})` : ""}, Instagram trial only, graduation ${graduationStrategy(settings) === "MANUAL" ? "manual" : "automatic"}`
    : "1 trial reel right away, to check once that trial reels stay off your grid";
  if (input.dryRun) {
    const before = blockers.length ? ` Before it can be scheduled: ${blockers.join(" ")}` : "";
    return { ok: true, message: `Dry run: ${summary}. Nothing was sent.${before}`, status: batch.status, plan: viewPlan(plan) };
  }

  // The owner's OK: an approval of this batch decided by a person.
  const decided = await latestApproval(ws, SUBJECT, batch.id);
  const personApproved = decided?.status === "approved" && decided.decided_by && !decided.decided_by.startsWith("agent:");
  if (decided?.status === "rejected") return { ok: false, message: `You turned these trial reels down (${decided.ref}). Make a new batch.`, status: batch.status, approvalRef: decided.ref };
  if (!personApproved) {
    const { approval } = await requestApproval(ws.sql, ws.id, {
      kind: "post", subjectType: SUBJECT, subjectId: batch.id, agent: AGENT, runId: input.runId ?? null,
      summary: `Schedule ${summary}`,
      preview: { batch: batch.ref, date: batch.post_date, previewAssetId: batch.preview_asset_id, posts: viewPlan(plan).slice(0, 12) },
    });
    await updateBatch(ws, batch.id, { approval_ref: approval.ref });
    return { ok: false, message: `Waiting for your OK (${approval.ref}). Look at the preview in Studio first; nothing is scheduled until you approve.`, status: batch.status, approvalRef: approval.ref };
  }

  // Ready to send.
  await updateBatch(ws, batch.id, { status: "scheduling", approval_ref: decided!.ref, confirmed_by: decided!.decided_by, confirmed_at: decided!.decided_at, error: null });
  // A variation whose post was clearly refused (never reached the publisher) may be tried again.
  await ws.sql`
    delete from trial_reel_posts l
     where l.workspace_id = ${ws.id} and l.batch_id = ${batch.id} and l.status = 'failed'
       and (l.post_id is null or exists (select 1 from posts p where p.id = l.post_id and p.provider_post_id is null and p.status in ('failed', 'cancelled', 'draft')))`;
  const sources = await ensureContent(ws, batch, input.actor ?? "system");
  const byReel = new Map(sources.map((s) => [s.slug, s]));
  const byId = new Map(variants.map((v) => [v.id, v]));
  const graduation = graduationStrategy(settings);
  const outcomes: { variantId: string; outcome: ScheduleOutcome["outcome"]; postId?: string; at: string | null; message: string }[] = [];
  let stopped: string | null = null;
  for (const item of plan) {
    const v = byId.get(item.variantId)!;
    const source = byReel.get(v.reel)!;
    if (!(await claimLedger(ws, { batchId: batch.id, variantId: v.id, scheduledAt: item.at, caption: v.postCaption }))) continue;
    const [main] = await ws.sql<{ id: string }[]>`
      select id from posts where workspace_id = ${ws.id} and content_id = ${source.contentId} and platform = 'instagram' and not is_trial order by created_at limit 1`;
    let o: ScheduleOutcome;
    try {
      o = await schedulePost(ws, {
        contentId: source.contentId!, platform: "instagram", dryRun: false, mode: "auto",
        ...(item.at ? { scheduledAt: item.at.toISOString() } : {}),
        captionOverride: v.postCaption,
        media: { kind: "video", localPath: v.file, mimeType: "video/mp4", ...(v.durationS ? { durationS: v.durationS } : {}) },
        idempotencySuffix: `trial-${batch.post_date}-${v.id}`,
        trial: { variation: v.index, seed: `${batch.post_date}:${v.reel}`, variantOf: main?.id ?? null, graduation },
        planApproval: { subjectType: SUBJECT, subjectId: batch.id },
        runId: input.runId ?? null,
      });
    } catch (err) {
      // Unknown whether it reached the publisher: leave the ledger row as "sending" so it's never resent blindly.
      stopped = `Lost track of ${v.id} while sending it: ${problem(err)} Check your publisher's calendar before trying again.`;
      break;
    }
    const good = ["scheduled", "published", "publishing", "queued", "already_exists"].includes(o.outcome);
    await settleLedger(ws, batch.id, v.id, { status: o.outcome === "published" ? "published" : good ? "scheduled" : "failed", postId: o.postId ?? null, message: o.message.split("\n")[0] ?? null });
    outcomes.push({ variantId: v.id, outcome: o.outcome, ...(o.postId ? { postId: o.postId } : {}), at: item.at?.toISOString() ?? null, message: o.message });
    if (!good) {
      stopped = `${v.id}: ${o.message.split("\n")[0]}`;
      break;
    }
  }

  const after = await ledger(ws, batch.id);
  const live = after.filter((l) => l.status === "scheduled" || l.status === "published").length;
  const status: BatchStatus = !proof ? (live ? "proving" : "ready") : live >= variants.length ? "scheduled" : live ? "partial" : "ready";
  const sent = outcomes.filter((o) => ["scheduled", "published", "publishing", "queued"].includes(o.outcome)).length;
  const message = stopped
    ? `Stopped after ${plural(sent, "trial reel")}: ${stopped}`
    : !proof
      ? `Posted 1 trial reel right away to check that trial reels stay off your grid. When it's live, look at your profile; if it's NOT on your grid, confirm it in Studio (Calendar → that post → “It stayed off my grid”), then schedule the rest.`
      : `Scheduled ${plural(sent, "trial reel")} on Instagram for ${batch.post_date} (trial only, never on your grid).`;
  await updateBatch(ws, batch.id, { status, outcome: { at: ws.now().toISOString(), sent, stopped, outcomes } });
  await activity(ws, AGENT, message, { batch: batch.ref, sent }, input.runId ?? null);
  if (stopped) await notify(ws, { dedupeKey: `trial-reels:${batch.ref}:stopped:${after.length}`, ref: batch.ref, text: message, priority: "high" });
  return { ok: !stopped, message, status, sent, proving: !proof, plan: viewPlan(plan), approvalRef: decided!.ref };
}

// ---------------------------------------------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------------------------------------------

/** Cancels a batch's trial reels that aren't live yet (also with the publisher). `postIds` limits it to some posts. */
export async function cancelBatch(ws: WorkspaceContext, input: { batchId?: string; postIds?: string[] }): Promise<{ ok: boolean; message: string; cancelled: number }> {
  const rows = await ws.sql<{ batch_id: string; variant_id: string; post_id: string | null; status: string; ref: string }[]>`
    select l.batch_id, l.variant_id, l.post_id, l.status, b.ref from trial_reel_posts l join trial_reel_batches b on b.id = l.batch_id
     where l.workspace_id = ${ws.id}
       ${input.batchId ? ws.sql`and (b.id::text = ${input.batchId} or b.ref = ${input.batchId.toLowerCase()})` : ws.sql``}
       ${input.postIds?.length ? ws.sql`and l.post_id = any(${input.postIds}::uuid[])` : ws.sql``}`;
  if (!input.batchId && !input.postIds?.length) return { ok: false, message: "Say which batch or posts to cancel.", cancelled: 0 };
  let cancelled = 0;
  const problems: string[] = [];
  for (const r of rows) {
    if (!r.post_id || r.status === "cancelled") continue;
    const post = await getPost(ws, r.post_id);
    if (!post || post.status === "cancelled") {
      await settleLedger(ws, r.batch_id, r.variant_id, { status: "cancelled" });
      continue;
    }
    if (post.status === "published") {
      problems.push(`${r.variant_id} is already live (delete it on Instagram)`);
      continue;
    }
    const res = await cancelPost(ws, r.post_id).catch((e: unknown) => ({ ok: false, message: problem(e) }));
    if (res.ok) {
      cancelled++;
      await settleLedger(ws, r.batch_id, r.variant_id, { status: "cancelled", message: "cancelled" });
    } else problems.push(`${r.variant_id}: ${res.message}`);
  }
  for (const id of new Set(rows.map((r) => r.batch_id))) {
    const left = await ws.sql<{ n: number }[]>`select count(*)::int as n from trial_reel_posts where workspace_id = ${ws.id} and batch_id = ${id} and status in ('sending', 'scheduled', 'published')`;
    if (!left[0]?.n) await ws.sql`update trial_reel_batches set status = 'cancelled', updated_at = now() where workspace_id = ${ws.id} and id = ${id}`;
  }
  if (input.batchId && !rows.length) {
    const b = await getBatch(ws, input.batchId);
    if (b && !IN_FLIGHT.includes(b.status)) {
      await updateBatch(ws, b.id, { status: "cancelled" });
      return { ok: true, message: `Cancelled ${b.ref}; nothing had been scheduled.`, cancelled: 0 };
    }
  }
  const message = `Cancelled ${plural(cancelled, "trial reel")}.${problems.length ? ` Not cancelled: ${problems.slice(0, 3).join("; ")}.` : ""}`;
  if (cancelled) await activity(ws, AGENT, message, { postIds: input.postIds ?? null, batch: input.batchId ?? null });
  return { ok: problems.length === 0, message, cancelled };
}

// ---------------------------------------------------------------------------------------------------------------
// a plain view of a batch (tool output)
// ---------------------------------------------------------------------------------------------------------------

export async function batchView(ws: WorkspaceContext, batch: BatchRow): Promise<Record<string, unknown>> {
  const settings = trialReelsSettings(ws.config);
  const tz = ws.config.workspace.timezone;
  const led = await ledger(ws, batch.id);
  const plan = batch.manifest ? postingPlan(batch, { window: settings.window, timezone: tz }) : [];
  const fmt = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d) : "right away");
  const previewPath = batch.preview_asset_id ? (await ws.sql<{ uri: string }[]>`select uri from media_assets where workspace_id = ${ws.id} and id = ${batch.preview_asset_id}`)[0]?.uri : undefined;
  return compact({
    ref: batch.ref,
    day: batch.post_date,
    status: batch.status,
    progress: batch.progress ?? undefined,
    problem: batch.error ?? undefined,
    reels: batch.sources.map((s) => ({ name: s.name, source: s.editRef ?? "uploaded clean reel", titles: s.titles, captionLine: s.captionLine, hashtags: s.hashtags, layout: s.layout, cta: s.cta?.text })),
    previewImage: previewPath,
    checks: batch.verify ? (batch.verify.ok ? `Passed for all ${batch.verify.count}` : batch.verify.failures.slice(0, 8)) : undefined,
    plan: plan.map((p) => ({ variation: p.variantId, at: fmt(p.at), title: p.title || "(no title)", caption: p.postCaption })),
    posted: led.length ? led.map((l) => ({ variation: l.variant_id, status: l.status, at: l.scheduled_at ? fmt(new Date(l.scheduled_at)) : "right away", postId: l.post_id ?? undefined })) : undefined,
    approval: batch.approval_ref ?? undefined,
    timings: batch.manifest?.timings,
    today: localDate(ws.now(), tz),
  });
}
