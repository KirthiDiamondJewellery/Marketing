import { existsSync } from "node:fs";
import { agentSettings, PLATFORMS, type JobContext, type Platform, type PlatformOptions, type WorkspaceContext } from "@attentionos/core";
import { recordAgentEvent } from "@attentionos/db";
import { addDays, localDate, mondayOf, nextMonday, planSlots, publishingSettings, schedulePost, type ScheduleOutcome } from "@attentionos/module-publishing";
import { getRelease, kickAdvance, updateRelease, upsertRelease, type ReleaseOutcome, type ReleaseRow, type ReleaseSlot } from "./repo.ts";

/**
 * Releases: what happens to a finished video. Proposed post slots are shown on the approval card; approving the
 * video (a person, or the Art Director on autopilot) schedules one post per platform through the publishing module,
 * which validates every payload, keeps Instagram main feed on "assist" unless autopost is on, adds the tracked
 * utm_content and applies the Publisher's own approval gate.
 */

const LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", x: "X", threads: "Threads" };
export const platformLabel = (p: string) => LABEL[p] ?? p;

type EditForRelease = { id: string; ref: string; version: number; content_id: string | null; status: string; output_asset_id: string | null };

/** Platforms a video goes to: the workspace's platforms that have a caption (or an override), else all of them. */
export async function releasePlatforms(ws: WorkspaceContext, contentId: string | null, overrides: Record<string, string> = {}): Promise<Platform[]> {
  const enabled = ws.config.platforms.filter((p) => (PLATFORMS as readonly string[]).includes(p)) as Platform[];
  let cadence: Partial<Record<Platform, { perWeek: number }>> = {};
  try {
    cadence = publishingSettings(ws.config).cadence;
  } catch {
    // invalid publishing settings show up in doctor; plan every enabled platform
  }
  const live = enabled.filter((p) => (cadence[p]?.perWeek ?? 1) > 0);
  if (!contentId) return live;
  const [s] = await ws.sql<{ captions: Record<string, unknown> | null }[]>`
    select captions from scripts where workspace_id = ${ws.id} and content_id = ${contentId} and status <> 'rejected'
     order by (status = 'approved') desc, version desc limit 1`;
  const withCaption = live.filter((p) => (s?.captions && s.captions[p]) || overrides[p]?.trim());
  return withCaption.length ? withCaption : live;
}

function modeFor(ws: WorkspaceContext, platform: Platform): "auto" | "assist" {
  if (!ws.providers.publisher) return "assist";
  try {
    return platform === "instagram" && !publishingSettings(ws.config).instagram.autopost ? "assist" : "auto";
  } catch {
    return platform === "instagram" ? "assist" : "auto";
  }
}

/** Next open cadence slot per platform, skipping slots already taken by posts and by other videos' proposals. */
export async function proposeSlots(ws: WorkspaceContext, platforms: Platform[], excludeEditJobId?: string): Promise<ReleaseSlot[]> {
  let settings;
  try {
    settings = publishingSettings(ws.config);
  } catch {
    return platforms.map((platform) => ({ platform, scheduledAt: null, mode: modeFor(ws, platform) }));
  }
  const tz = ws.config.workspace.timezone;
  const now = ws.now();
  const posts = await ws.sql<{ platform: string; scheduled_at: Date }[]>`
    select platform, scheduled_at from posts where workspace_id = ${ws.id} and status not in ('cancelled', 'failed') and scheduled_at >= ${now}`;
  const proposals = await ws.sql<{ slots: ReleaseSlot[] }[]>`
    select slots from production_releases
     where workspace_id = ${ws.id} and status in ('proposed', 'approved', 'scheduling')
       and edit_job_id is distinct from ${excludeEditJobId ?? null}
       and updated_at > now() - interval '21 days'`;
  const taken = [
    ...posts.map((p) => ({ platform: p.platform as Platform, scheduledAt: new Date(p.scheduled_at).toISOString() })),
    ...proposals.flatMap((r) => (r.slots ?? []).filter((s) => s.scheduledAt).map((s) => ({ platform: s.platform as Platform, scheduledAt: s.scheduledAt! }))),
  ];
  const out: ReleaseSlot[] = [];
  for (const platform of platforms) {
    const cadence = settings.cadence[platform];
    let at: string | null = null;
    if (cadence && cadence.perWeek > 0) {
      for (const weekStart of [mondayOf(localDate(now, tz)), nextMonday(now, tz), addDays(nextMonday(now, tz), 7)]) {
        const slots = planSlots(platform, cadence, { weekStart, timezone: tz, taken, now, leadMinutes: settings.leadMinutes });
        if (slots[0]) {
          at = slots[0].utc.toISOString();
          break;
        }
      }
    }
    out.push({ platform, scheduledAt: at, mode: modeFor(ws, platform) });
  }
  return out;
}

/** Makes sure a version waiting for approval has its proposed slots (shown on the approval card). */
export async function ensureProposal(ws: WorkspaceContext, edit: EditForRelease, approvalRef: string | null): Promise<ReleaseRow> {
  const existing = await getRelease(ws, edit.id, edit.version);
  if (existing && existing.slots.length) {
    if (approvalRef && existing.approval_ref !== approvalRef) return upsertRelease(ws, { editJobId: edit.id, contentId: edit.content_id, version: edit.version, approvalRef });
    return existing;
  }
  const platforms = await releasePlatforms(ws, edit.content_id, existing?.captions ?? {});
  const slots = await proposeSlots(ws, platforms, edit.id);
  return upsertRelease(ws, { editJobId: edit.id, contentId: edit.content_id, version: edit.version, approvalRef, slots });
}

type RawCaption = { caption?: string; text?: string; description?: string; title?: string; hashtags?: string[] };

/** Caption text plus hashtags, the way the approval card shows it. */
function composeRaw(c: RawCaption | undefined): string | null {
  if (!c) return null;
  const text = (c.caption ?? c.text ?? c.description ?? c.title ?? "").trim();
  if (!text) return null;
  const tags = (c.hashtags ?? []).filter((h) => typeof h === "string" && h.trim());
  return tags.length ? `${text}\n\n${tags.join(" ")}` : text;
}

function overrideOptions(platform: Platform, title: string): PlatformOptions {
  if (platform === "tiktok") return { tiktok: { privacy: "public", aiGenerated: false } };
  if (platform === "youtube") return { youtube: { title: title.slice(0, 100), privacy: "public", madeForKids: false, shorts: true } };
  return {};
}

type ApprovalLite = { ref: string; status: string; decided_by: string | null; decision_note: string | null };

/**
 * The rule for scheduling a finished video, in code: its latest final-video approval is approved, by a person, or
 * by the system only while the Art Director is on autopilot. Nothing else schedules.
 */
export function mayRelease(ws: Pick<WorkspaceContext, "config">, approval: ApprovalLite | undefined): { ok: true; by: string } | { ok: false; why: string } {
  if (!approval) return { ok: false, why: "This video hasn't been sent for approval yet." };
  if (approval.status !== "approved") return { ok: false, why: `This video's approval is ${approval.status}, not approved.` };
  const by = approval.decided_by ?? "";
  if (by.startsWith("user:")) return { ok: true, by };
  if (by === "system" && agentSettings(ws.config, "art_director").autonomy === "autopilot") return { ok: true, by: "autopilot" };
  return { ok: false, why: "Only a person approves videos, unless the Art Director is on autopilot." };
}

export async function latestRenderApproval(ws: Pick<WorkspaceContext, "id" | "sql">, editJobId: string): Promise<(ApprovalLite & { id: string; requested_at: Date }) | undefined> {
  const [a] = await ws.sql<(ApprovalLite & { id: string; requested_at: Date })[]>`
    select id, ref, status, decided_by, decision_note, requested_at from approvals
     where workspace_id = ${ws.id} and kind = 'edit' and subject_type = 'edit_render' and subject_id = ${editJobId}
     order by requested_at desc limit 1`;
  return a;
}

function whenLocal(ws: WorkspaceContext, iso: string): string {
  const d = new Date(iso);
  const tz = ws.config.workspace.timezone;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} ${time}`;
}

/** "Scheduled for Thu 9:00 AM on Instagram (you post it), TikTok". */
export function describeOutcomes(ws: WorkspaceContext, outcomes: ReleaseOutcome[]): string {
  const ok = outcomes.filter((o) => ["scheduled", "assist", "queued", "publishing", "published", "already_exists", "awaiting_approval"].includes(o.outcome));
  const byTime = new Map<string, string[]>();
  for (const o of ok) {
    const key = o.scheduledAt ? whenLocal(ws, o.scheduledAt) : "now";
    const name = `${platformLabel(o.platform)}${o.outcome === "assist" ? " (you post it)" : o.outcome === "awaiting_approval" ? " (waiting for your OK)" : ""}`;
    byTime.set(key, [...(byTime.get(key) ?? []), name]);
  }
  const parts = [...byTime].map(([when, names]) => `${when === "now" ? "now" : `for ${when}`} on ${names.join(", ")}`);
  const failed = outcomes.filter((o) => !ok.includes(o));
  const head = parts.length ? `Scheduled ${parts.join("; ")}` : "Nothing was scheduled";
  return failed.length ? `${head}. Not scheduled: ${failed.map((f) => `${platformLabel(f.platform)} (${f.message.split("\n")[0]})`).join("; ")}` : head;
}

/**
 * `production.schedule-approved`: schedules an approved video on every planned platform. Safe to re-run: posts are
 * keyed by content, platform and script version, so nothing is posted twice.
 */
export async function runScheduleApproved(ctx: JobContext<{ ref: string; version?: number }>): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const [edit] = await ws.sql<(EditForRelease & { title: string | null; uri: string | null; duration_s: string | null })[]>`
    select e.id, e.ref, e.version, e.content_id, e.status, e.output_asset_id, c.title, m.uri, m.duration_s::text
      from edit_jobs e left join content c on c.id = e.content_id left join media_assets m on m.id = e.output_asset_id
     where e.workspace_id = ${ws.id} and e.ref = ${ctx.input.ref.toLowerCase()}`;
  if (!edit) return { skipped: `no edit called ${ctx.input.ref}` };
  if (ctx.input.version && ctx.input.version !== edit.version) return { skipped: `v${ctx.input.version} was replaced by v${edit.version}` };
  const approval = await latestRenderApproval(ws, edit.id);
  const may = mayRelease(ws, approval);
  if (!may.ok) return { ref: edit.ref, scheduled: false, why: may.why };
  if (!edit.content_id) return { ref: edit.ref, scheduled: false, why: "This video isn't filed under a piece of content." };
  if (!edit.uri || !existsSync(edit.uri)) return { ref: edit.ref, scheduled: false, why: "The finished video file is missing." };

  let release = await ensureProposal(ws, edit, approval?.ref ?? null);
  if (release.status === "scheduled") return { ref: edit.ref, version: edit.version, already: true, outcomes: release.outcomes };
  await updateRelease(ws, release.id, { status: "scheduling", ...(release.approved_by ? {} : { approved_by: may.by, approved_at: new Date() }) });
  // Slots may have been taken since they were proposed: re-plan any that are gone or in the past.
  const soon = ws.now().getTime() + 10 * 60_000;
  if (release.slots.some((s) => !s.scheduledAt || Date.parse(s.scheduledAt) < soon)) {
    const fresh = await proposeSlots(ws, release.slots.map((s) => s.platform as Platform), edit.id);
    release = { ...release, slots: release.slots.map((s) => (s.scheduledAt && Date.parse(s.scheduledAt) >= soon ? s : fresh.find((f) => f.platform === s.platform) ?? s)) };
    await updateRelease(ws, release.id, { slots: release.slots });
  }

  const outcomes: ReleaseOutcome[] = [];
  const [script] = await ws.sql<{ captions: Record<string, RawCaption> | null }[]>`
    select captions from scripts where workspace_id = ${ws.id} and content_id = ${edit.content_id} and status <> 'rejected'
     order by (status = 'approved') desc, version desc limit 1`;
  for (const slot of release.slots) {
    const platform = slot.platform as Platform;
    const override = release.captions[platform]?.trim();
    let o: ScheduleOutcome;
    try {
      o = await schedulePost(ws, {
        contentId: edit.content_id,
        platform,
        ...(slot.scheduledAt ? { scheduledAt: slot.scheduledAt } : {}),
        dryRun: false,
        // An edited caption replaces the composed one; keep the platform options the captions package would set.
        ...(override ? { captionOverride: override, options: overrideOptions(platform, script?.captions?.youtube?.title ?? edit.title ?? edit.ref) } : {}),
        media: { kind: "video", localPath: edit.uri, mimeType: "video/mp4", ...(edit.duration_s ? { durationS: Number(edit.duration_s) } : {}) },
        ...(release.plan_id ? { weekPlanId: release.plan_id } : {}),
        runId: ctx.runId,
      });
      // A captions package the publishing schema can't read (older or hand-written ones) still has the words the
      // owner saw on the approval card: post exactly those, still through every payload check.
      const raw = composeRaw(script?.captions?.[platform]);
      if (!override && o.outcome === "invalid" && o.check.errors.some((e) => e.code === "publishing.caption_missing") && raw) {
        o = await schedulePost(ws, {
          contentId: edit.content_id,
          platform,
          ...(slot.scheduledAt ? { scheduledAt: slot.scheduledAt } : {}),
          dryRun: false,
          captionOverride: raw,
          options: overrideOptions(platform, script?.captions?.youtube?.title ?? edit.title ?? edit.ref),
          media: { kind: "video", localPath: edit.uri, mimeType: "video/mp4", ...(edit.duration_s ? { durationS: Number(edit.duration_s) } : {}) },
          ...(release.plan_id ? { weekPlanId: release.plan_id } : {}),
          runId: ctx.runId,
        });
      }
    } catch (err) {
      o = { outcome: "failed", message: (err as Error).message, check: { ok: false, errors: [], warnings: [] } };
    }
    outcomes.push({ platform, outcome: o.outcome, message: o.message, scheduledAt: o.preview?.scheduledAt ?? slot.scheduledAt, mode: o.preview?.mode ?? slot.mode, ...(o.postId ? { postId: o.postId } : {}) });
  }
  const good = outcomes.filter((o) => !["invalid", "failed", "rejected"].includes(o.outcome)).length;
  const status = good === outcomes.length ? "scheduled" : good ? "partial" : "failed";
  await updateRelease(ws, release.id, { status, outcomes });
  const line = describeOutcomes(ws, outcomes);
  await recordAgentEvent(ws.sql, {
    workspaceId: ws.id,
    agent: "publisher",
    kind: "progress",
    runId: ctx.runId,
    message: `“${edit.title ?? edit.ref}”: ${line.charAt(0).toLowerCase()}${line.slice(1)}`,
    data: { ref: edit.ref, version: edit.version, outcomes, approvedBy: may.by },
  });
  await kickAdvance(ws, 2);
  return { ref: edit.ref, version: edit.version, status, outcomes, summary: line };
}
