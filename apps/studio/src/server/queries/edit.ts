import "server-only";
import { workspace } from "@/server/workspace";
import { getEditQueue, describeReleaseOutcomes, type EditRowView } from "./edits";
import { getLinkableScripts } from "./film";
import { getUploads, productionReady, type UploadView } from "./production";

/**
 * Everything the Edit page shows, top to bottom: takes that need a script decision, videos being edited, finished
 * videos waiting for the owner (with versions, captions, posting slots and checks in plain words), cut lists to review
 * when that setting is on, and the last few approved videos with where they went.
 *
 * Ids the page acts on: `approvalId` (pending final-video approval: approve / request changes), `editId` + `ref`
 * (the edit: retry / stop), `releaseId` (production_releases row once approved: schedule / unready), `assetId`
 * (the finished video file: play and download through /api/media/<assetId>).
 */

export type Slot = { platform: string; scheduledAt: string | null; mode: "auto" | "assist" };
export type QcLine = { label: string; status: "pass" | "warn" | "fail"; detail: string | null };

export type ReviewVideo = {
  approvalId: string;
  editId: string;
  ref: string;
  contentId: string | null;
  title: string;
  version: number;
  /** The finished video (latest version). */
  assetId: string | null;
  durationS: number | null;
  versions: { version: number; assetId: string; durationS: number | null }[];
  /** What the owner asked for last time, when this is version 2 or later. */
  changesAsked: string[];
  qc: { ok: boolean | null; summary: string; lines: QcLine[] };
  captions: { platform: string; text: string }[];
  /** Where it would post: the planned slot per platform (null time = next open slot). */
  slots: Slot[];
  requestedAt: string;
};

export type CutReview = { approvalId: string; editId: string; ref: string; title: string; summary: string; flags: string[]; requestedAt: string };

export type EditingRow = {
  editId: string;
  ref: string;
  title: string;
  version: number;
  coverId: string | null;
  /** Plain stage: "Up next", "Cutting", "Adding captions", "Final checks", "Making version 3". */
  stage: string;
  detail: string | null;
  step: number;
  etaS: number | null;
  state: "waiting" | "working" | "failed";
  error: string | null;
  revising: boolean;
};

export type DoneVideo = {
  editId: string;
  ref: string;
  title: string;
  version: number;
  assetId: string | null;
  coverId: string | null;
  releaseId: string | null;
  /** ready | approved | scheduling | scheduled | partial | failed | null (approved before releases existed). */
  releaseStatus: string | null;
  outcome: string;
  downloaded: boolean;
  at: string;
};

export type TakeScript = { id: string; title: string; status: string };

export type EditPageData = {
  tz: string;
  productionReady: boolean;
  reviewCuts: boolean;
  workerStale: boolean;
  /** Takes that still need a decision (matching, suggested, unmatched, failed) plus extra takes of scripts in the edit. */
  takes: UploadView[];
  scripts: TakeScript[];
  editing: EditingRow[];
  review: ReviewVideo[];
  cuts: CutReview[];
  done: DoneVideo[];
  publisherAutopilot: boolean;
  instagramAutopost: boolean;
};

const PLATFORM_ORDER = ["instagram", "tiktok", "youtube", "linkedin", "facebook", "x", "threads"];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function captionsFrom(raw: unknown): { platform: string; text: string }[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, Record<string, unknown>>)
    .map(([platform, c]) => {
      const text = str(c?.caption) ?? str(c?.text) ?? [str(c?.title), str(c?.description)].filter(Boolean).join("\n\n");
      const tags = Array.isArray(c?.hashtags) ? (c.hashtags as unknown[]).filter((h): h is string => typeof h === "string") : [];
      return { platform, text: tags.length && text ? `${text}\n\n${tags.join(" ")}` : text };
    })
    .filter((c) => c.text && PLATFORM_ORDER.includes(c.platform))
    .sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
}

/** QC in plain words, from either the full report ({passed, summary, checks}) or the short one ({ok, issues, …}). */
export function plainQc(raw: unknown): ReviewVideo["qc"] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const lines: QcLine[] = [];
  if (Array.isArray(r.checks)) {
    for (const c of r.checks as Record<string, unknown>[]) {
      const status = c.status === "fail" ? "fail" : c.status === "warn" ? "warn" : c.status === "skip" ? null : "pass";
      if (!status) continue;
      lines.push({ label: str(c.label) ?? str(c.id) ?? "Check", status, detail: status === "pass" ? null : str(c.detail) });
    }
  } else {
    const lufs = num(r.loudness_lufs);
    if (lufs !== null) lines.push(lufs >= -17 && lufs <= -11 ? { label: "Sound level is right for phones", status: "pass", detail: null } : { label: lufs < -17 ? "Sound is a little quiet" : "Sound is a little loud", status: "warn", detail: null });
    const pause = num(r.max_pause_s);
    if (pause !== null) lines.push(pause <= 0.6 ? { label: "No dead air", status: "pass", detail: null } : { label: `Has a ${pause.toFixed(1)}s pause`, status: "warn", detail: null });
    if (num(r.black_frames) === 0 && (num(r.freezes) ?? 0) === 0) lines.push({ label: "No frozen or black frames", status: "pass", detail: null });
    if (r.caption_safe_zone === "pass") lines.push({ label: "Captions stay clear of the app buttons", status: "pass", detail: null });
    else if (typeof r.caption_safe_zone === "string") lines.push({ label: "Captions may sit under the app buttons", status: "warn", detail: null });
    for (const i of Array.isArray(r.issues) ? (r.issues as unknown[]) : []) {
      const text = typeof i === "string" ? i : str((i as Record<string, unknown>)?.detail) ?? str((i as Record<string, unknown>)?.message);
      if (text) lines.push({ label: text, status: "warn", detail: null });
    }
  }
  const problems = lines.filter((l) => l.status !== "pass");
  const ok = typeof r.passed === "boolean" ? r.passed && !problems.some((p) => p.status === "fail") : typeof r.ok === "boolean" ? r.ok && !problems.length : lines.length ? !problems.length : null;
  const summary =
    ok === null
      ? "Not checked yet."
      : problems.length
        ? `${problems.length === 1 ? "One thing" : `${problems.length} things`} to look at: ${problems.map((p) => (p.detail ? `${p.label.toLowerCase()} (${p.detail})` : p.label.toLowerCase())).join("; ")}.`
        : lines.length
          ? `Looks clean. ${lines.slice(0, 3).map((l, i) => (i ? l.label.toLowerCase() : l.label)).join(", ")}.`
          : "Passed the quality checks.";
  return { ok, summary, lines };
}

function plainStage(row: EditRowView): Pick<EditingRow, "stage" | "detail" | "step" | "revising"> {
  const revising = /^Editing v\d+/.test(row.label) || row.detail === "Applying your notes";
  if (revising) return { stage: `Making version ${row.version + 1}`, detail: "Working in your notes", step: 2, revising };
  switch (row.status) {
    case "queued":
      return { stage: "Up next", detail: row.queuedAhead ? `${row.queuedAhead} ahead of it` : "Starts as soon as your editor is free", step: 0, revising };
    case "prepping":
    case "review":
      return { stage: "Cutting", detail: "Trimming pauses and retakes", step: 1, revising };
    case "planning":
      return { stage: "Cutting", detail: "Planning the edit", step: 1, revising };
    case "rendering":
      return { stage: "Adding captions", detail: "Captions, cuts and sound", step: 2, revising };
    case "qc":
      return { stage: "Final checks", detail: "Sound, pauses, framing and captions", step: 3, revising };
    default:
      return { stage: row.label, detail: row.detail, step: Math.min(3, Math.max(0, row.stage - 1)), revising };
  }
}

function plainStopped(row: EditRowView): string {
  if (row.status === "rendering" || row.stage === 3) return "Stopped while adding captions";
  if (row.status === "qc" || row.stage === 4) return "Stopped during final checks";
  if (row.stage === 0) return "Stopped before it started";
  return "Stopped while cutting";
}

export async function getEditPage(): Promise<EditPageData> {
  const ws = workspace();
  const tz = ws.config.workspace.timezone;
  const ready = await productionReady().catch(() => false);
  const [queue, uploads, scripts, review, cuts] = await Promise.all([
    getEditQueue(),
    ready ? getUploads({ days: 14, limit: 80 }) : Promise.resolve([] as UploadView[]),
    getLinkableScripts().catch(() => [] as TakeScript[]),
    reviewVideos(ready),
    cutReviews(),
  ]);

  const editing: EditingRow[] = queue.rows
    .filter((r) => r.status !== "approved" && (r.state === "working" || r.state === "waiting" || r.state === "failed"))
    .map((r) => {
      const failed = r.state === "failed";
      const s = plainStage(r);
      return {
        editId: r.id,
        ref: r.ref,
        title: r.title,
        version: r.version,
        coverId: r.coverId,
        ...s,
        stage: failed ? plainStopped(r) : s.stage,
        detail: failed ? null : s.detail,
        etaS: failed ? null : r.etaS,
        state: failed ? "failed" : r.state === "waiting" ? "waiting" : "working",
        error: failed ? r.error ?? "This step stopped." : null,
      };
    });

  // Takes: anything still waiting on a script decision, plus extra takes of a script whose edit can still switch.
  const takes = uploads.filter((u) => {
    if (u.status !== "linked") return true;
    if (u.role !== "take") return false;
    // The newest edit of the same script decides: an extra take can still swap in before the edit gets far.
    const s = queue.rows.filter((r) => r.contentId === u.contentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.status;
    return !s || ["queued", "prepping", "planning", "failed", "cancelled"].includes(s);
  });

  return {
    tz,
    productionReady: ready,
    reviewCuts: queue.reviewCuts,
    workerStale: !queue.workerSeen || Date.now() - Date.parse(queue.workerSeen) > 2 * 60_000,
    takes,
    scripts,
    editing,
    review,
    cuts: queue.reviewCuts ? cuts : [],
    done: await recentlyDone(queue.rows, ready, tz),
    publisherAutopilot: ws.config.agents.publisher?.autonomy === "autopilot",
    instagramAutopost: ((ws.config.modules.publishing?.settings ?? {}) as { instagram?: { autopost?: boolean } }).instagram?.autopost === true,
  };
}

type ReviewRow = {
  approval_id: string; requested_at: Date; edit_id: string; ref: string; version: number; content_id: string | null; output_asset_id: string | null;
  notes: unknown; qc_report: unknown; title: string | null; duration_s: string | null; captions: unknown;
};

async function reviewVideos(ready: boolean): Promise<ReviewVideo[]> {
  const ws = workspace();
  const rows = await ws.sql<ReviewRow[]>`
    select a.id as approval_id, a.requested_at, e.id as edit_id, e.ref, e.version, e.content_id, e.output_asset_id, e.notes, e.qc_report,
           c.title, m.duration_s::text as duration_s,
           (select s.captions from scripts s where s.workspace_id = e.workspace_id and s.content_id = e.content_id and s.status <> 'rejected'
             order by (s.status = 'approved') desc, s.version desc limit 1) as captions
      from approvals a
      join edit_jobs e on e.id = a.subject_id and e.workspace_id = a.workspace_id
      left join content c on c.id = e.content_id
      left join media_assets m on m.id = e.output_asset_id
     where a.workspace_id = ${ws.id} and a.status = 'pending' and a.kind = 'edit' and a.subject_type in ('edit_render', 'edit_job')
     order by a.requested_at asc
     limit 30`;
  if (!rows.length) return [];
  const refs = rows.map((r) => r.ref);
  const [renders, releases] = await Promise.all([
    // Renders carry their edit in provenance; older ones only in the path (media/renders/<edit>/v2.mp4).
    ws.sql<{ id: string; ref: string | null; version: string | null; duration_s: string | null }[]>`
      select distinct on (x.ref, x.version) x.id, x.ref, x.version, x.duration_s from (
        select id, created_at, duration_s::text as duration_s,
               coalesce(provenance->>'ref', substring(uri from 'renders/([a-z]+-[0-9]+)/')) as ref,
               coalesce(provenance->>'version', substring(uri from '/v([0-9]+)[.][a-z0-9]+$'), '1') as version
          from media_assets
         where workspace_id = ${ws.id} and kind = 'render'
      ) x
       where x.ref = any(${refs})
       order by x.ref, x.version, x.created_at desc`,
    ready
      ? ws.sql<{ edit_job_id: string; version: number; slots: Slot[]; captions: Record<string, string> }[]>`
          select edit_job_id, version, slots, captions from production_releases where workspace_id = ${ws.id} and edit_job_id = any(${rows.map((r) => r.edit_id)})`
      : Promise.resolve([]),
  ]);
  const enabled = ws.config.platforms.filter((p) => PLATFORM_ORDER.includes(p));
  const igMode = ((ws.config.modules.publishing?.settings ?? {}) as { instagram?: { autopost?: boolean } }).instagram?.autopost === true ? "auto" : "assist";

  return rows.map((r) => {
    const versions = renders
      .filter((v) => v.ref === r.ref)
      .map((v) => ({ version: Number(v.version ?? 1), assetId: v.id, durationS: num(v.duration_s) }))
      .filter((v) => v.version <= r.version);
    if (r.output_asset_id && !versions.some((v) => v.assetId === r.output_asset_id)) {
      const i = versions.findIndex((v) => v.version === r.version);
      const latest = { version: r.version, assetId: r.output_asset_id, durationS: num(r.duration_s) };
      if (i >= 0) versions[i] = latest;
      else versions.push(latest);
    }
    versions.sort((a, b) => a.version - b.version);

    const rel = releases.find((x) => x.edit_job_id === r.edit_id && x.version === r.version);
    const captions = captionsFrom(r.captions).map((c) => ({ ...c, text: rel?.captions?.[c.platform]?.trim() || c.text }));
    let slots: Slot[] = rel?.slots?.length ? [...rel.slots] : [];
    if (!slots.length) {
      const withCaption = enabled.filter((p) => captions.some((c) => c.platform === p));
      slots = (withCaption.length ? withCaption : enabled).map((platform) => ({ platform, scheduledAt: null, mode: platform === "instagram" ? igMode : "auto" }));
    }
    slots.sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));

    const notes = (Array.isArray(r.notes) ? (r.notes as Record<string, unknown>[]) : [])
      .map((n) => ({ v: num(n?.version) ?? num(n?.v), text: str(n?.text) }))
      .filter((n): n is { v: number | null; text: string } => Boolean(n.text));
    const lastAsk = r.version > 1 ? notes.filter((n) => n.v === null || n.v === r.version - 1) : [];
    const changesAsked = [...new Set(lastAsk.flatMap((n) => n.text.split(/\n+/)).map((s) => s.trim()).filter(Boolean))].slice(0, 8);

    return {
      approvalId: r.approval_id,
      editId: r.edit_id,
      ref: r.ref,
      contentId: r.content_id,
      title: r.title ?? "Untitled video",
      version: r.version,
      assetId: r.output_asset_id,
      durationS: num(r.duration_s),
      versions,
      changesAsked,
      qc: plainQc(r.qc_report),
      captions,
      slots,
      requestedAt: r.requested_at.toISOString(),
    };
  });
}

async function cutReviews(): Promise<CutReview[]> {
  const ws = workspace();
  const rows = await ws.sql<{ id: string; summary: string; preview: Record<string, unknown> | null; requested_at: Date; edit_id: string; ref: string; title: string | null }[]>`
    select a.id, a.summary, a.preview, a.requested_at, e.id as edit_id, e.ref, c.title
      from approvals a
      join edit_jobs e on e.id = a.subject_id and e.workspace_id = a.workspace_id
      left join content c on c.id = e.content_id
     where a.workspace_id = ${ws.id} and a.status = 'pending' and a.kind = 'edit' and a.subject_type = 'edit_map'
     order by a.requested_at asc limit 20`;
  return rows.map((r) => ({
    approvalId: r.id,
    editId: r.edit_id,
    ref: r.ref,
    title: r.title ?? "Untitled video",
    summary: r.summary.replace(/^rf-\d+\s*/i, "").replace(/^cut list:\s*/i, "").replace(/^./, (c) => c.toUpperCase()),
    flags: Array.isArray(r.preview?.flags) ? (r.preview!.flags as unknown[]).filter((f): f is string => typeof f === "string").slice(0, 6) : [],
    requestedAt: r.requested_at.toISOString(),
  }));
}

const PLATFORM_NAME: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", x: "X", threads: "Threads" };

function firstProblem(outcomes: { outcome: string; message: string }[]): string | null {
  const bad = outcomes.find((o) => ["invalid", "failed", "rejected"].includes(o.outcome));
  return bad?.message.split("\n")[0]?.replace(/^Fix: /, "").replace(/\.$/, "") ?? null;
}

/** "Scheduling for Tue 9:00 AM on TikTok, YouTube" or "Scheduling at the next open slots". */
function schedulingLine(slots: Slot[], tz: string): string {
  const names = slots.map((s) => PLATFORM_NAME[s.platform] ?? s.platform).join(", ");
  const timed = slots.find((s) => s.scheduledAt);
  if (!timed) return names ? `Scheduling at the next open slot on ${names}` : "Scheduling at the next open slots";
  const when = new Date(timed.scheduledAt!).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
  return `Scheduling for ${when} on ${names}`;
}

async function recentlyDone(rows: EditRowView[], ready: boolean, tz: string): Promise<DoneVideo[]> {
  const ws = workspace();
  const approved = await ws.sql<{ id: string; ref: string; version: number; title: string | null; output_asset_id: string | null; updated_at: Date; cover_id: string | null }[]>`
    select e.id, e.ref, e.version, c.title, e.output_asset_id, e.updated_at,
           (select t.id from media_assets t where t.workspace_id = e.workspace_id and t.kind = 'thumbnail' and t.content_id = e.content_id order by t.created_at desc limit 1) as cover_id
      from edit_jobs e left join content c on c.id = e.content_id
     where e.workspace_id = ${ws.id}
       and (e.status = 'approved'
            ${ready ? ws.sql`or (e.status not in ('cancelled', 'failed') and exists (select 1 from production_releases r where r.workspace_id = e.workspace_id and r.edit_job_id = e.id and r.version = e.version and r.status <> 'proposed'))` : ws.sql``})
     order by ${ready ? ws.sql`greatest(e.updated_at, coalesce((select max(r.updated_at) from production_releases r where r.workspace_id = e.workspace_id and r.edit_job_id = e.id), e.updated_at))` : ws.sql`e.updated_at`} desc limit 6`;
  if (!approved.length) return [];
  const ids = approved.map((a) => a.id);
  const [releases, downloads] = await Promise.all([
    ready
      ? ws.sql<{ id: string; edit_job_id: string; version: number; status: string; slots: Slot[]; outcomes: { platform: string; outcome: string; scheduledAt?: string | null; message: string }[]; approved_at: Date | null; updated_at: Date }[]>`
          select id, edit_job_id, version, status, slots, outcomes, approved_at, updated_at from production_releases where workspace_id = ${ws.id} and edit_job_id = any(${ids})`
      : Promise.resolve([]),
    ws.sql<{ edit_id: string }[]>`
      select distinct data->>'editId' as edit_id from agent_events
       where workspace_id = ${ws.id} and agent = 'user:studio' and data->>'kind' = 'edit.download' and data->>'editId' = any(${ids})`,
  ]);
  const dl = new Set(downloads.map((d) => d.edit_id));
  const queueRow = new Map(rows.map((r) => [r.id, r]));
  const out = approved.map((a) => {
    const rel = releases.find((r) => r.edit_job_id === a.id && r.version === a.version) ?? null;
    const status = rel?.status ?? null;
    const outcome =
      status === "ready"
        ? "Ready to post"
        : status === "scheduled" || status === "partial"
          ? (describeReleaseOutcomes(rel!.outcomes, tz) ?? "Scheduled").split(". Not scheduled")[0]!
          : status === "failed"
            ? `Couldn't schedule it${firstProblem(rel!.outcomes) ? `: ${firstProblem(rel!.outcomes)}` : ""}`
            : status === "approved" || status === "scheduling"
              ? schedulingLine(rel!.slots, tz)
              : queueRow.get(a.id)?.release?.summary ?? "Approved";
    return {
      editId: a.id,
      ref: a.ref,
      title: a.title ?? "Untitled video",
      version: a.version,
      assetId: a.output_asset_id,
      coverId: a.cover_id,
      releaseId: rel?.id ?? null,
      releaseStatus: status,
      outcome,
      downloaded: dl.has(a.id),
      at: (rel?.approved_at ?? rel?.updated_at ?? a.updated_at).toISOString(),
    };
  });
  return out.sort((x, y) => y.at.localeCompare(x.at));
}
