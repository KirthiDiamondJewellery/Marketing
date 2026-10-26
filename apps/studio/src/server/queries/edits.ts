import "server-only";
import { workspace } from "@/server/workspace";
import { productionReady } from "./production";

/**
 * The edit queue: one row per video with where it is in Uploaded → Prepping → Planning → Rendering → Checking →
 * Ready for you, the agent's latest progress line, an ETA from this workspace's own run history, and what the owner
 * can do (retry, stop, review).
 */

export const STAGES = ["Uploaded", "Prepping", "Planning", "Rendering", "Checking", "Ready for you"] as const;

export type EditRowView = {
  id: string;
  ref: string;
  title: string;
  contentId: string | null;
  version: number;
  status: string;
  /** 0..5 into STAGES; 6 = approved (past "Ready for you"). */
  stage: number;
  state: "waiting" | "working" | "needs_you" | "failed" | "stopped" | "done";
  label: string;
  detail: string | null;
  progress: string | null;
  etaS: number | null;
  queuedAhead: number | null;
  error: string | null;
  filmBy: string | null;
  format: string | null;
  coverId: string | null;
  sourceAssetId: string | null;
  outputAssetId: string | null;
  durationS: number | null;
  approvalRef: string | null;
  release: { status: string; summary: string | null } | null;
  uploadId: string | null;
  fileName: string | null;
  updatedAt: string;
  createdAt: string;
};

export type EditQueue = { rows: EditRowView[]; reviewCuts: boolean; ready: boolean; tz: string; workerSeen: string | null };

const DEFAULT_S: Record<string, (d: number) => number> = {
  "editing.prep": (d) => 40 + d * 0.8,
  "editing.plan": () => 150,
  "editing.render": (d) => 45 + d * 2.5,
  "editing.revise": () => 120,
};

type Row = {
  id: string; ref: string; title: string | null; content_id: string | null; version: number; status: string; format: string | null;
  film_by: Date | null; output_asset_id: string | null; source_asset_id: string | null; duration_s: string | null; updated_at: Date; created_at: Date;
  upload_id: string | null; file_name: string | null; upload_error: string | null; cover_id: string | null; edit_map_status: string | null;
};

export async function getEditQueue(): Promise<EditQueue> {
  const ws = workspace();
  const ready = await productionReady().catch(() => false);
  const tz = ws.config.workspace.timezone;
  const rows = await ws.sql<Row[]>`
    select e.id, e.ref, c.title, e.content_id, e.version, e.status, e.format, c.film_by, e.output_asset_id, e.source_asset_id,
           coalesce(src.duration_s, out.duration_s)::text as duration_s, e.updated_at, e.created_at, e.edit_map->>'status' as edit_map_status,
           ${ready ? ws.sql`u.id` : ws.sql`null::uuid`} as upload_id,
           ${ready ? ws.sql`u.file_name` : ws.sql`null::text`} as file_name,
           ${ready ? ws.sql`u.error` : ws.sql`null::text`} as upload_error,
           ${ready ? ws.sql`(select t.id from media_assets t where t.workspace_id = e.workspace_id and t.kind = 'thumbnail' and t.provenance->>'uploadId' = u.id::text limit 1)` : ws.sql`null::uuid`} as cover_id
      from edit_jobs e
      left join content c on c.id = e.content_id
      left join media_assets src on src.id = e.source_asset_id
      left join media_assets out on out.id = e.output_asset_id
      ${ready ? ws.sql`left join production_uploads u on u.edit_job_id = e.id and u.workspace_id = e.workspace_id` : ws.sql``}
     where e.workspace_id = ${ws.id}
       and (e.status not in ('approved', 'cancelled') or e.updated_at > now() - interval '3 days')
     order by e.created_at desc
     limit 60`;
  if (!rows.length) return { rows: [], reviewCuts: await reviewCutsSetting(), ready, tz, workerSeen: await workerSeen() };

  const refs = rows.map((r) => r.ref);
  const ids = rows.map((r) => r.id);
  const [runs, approvals, releases, history, events] = await Promise.all([
    ws.sql<{ id: string; ref: string; job_id: string; status: string; error: string | null; run_after: Date; started_at: Date | null; created_at: Date }[]>`
      select id, input->>'ref' as ref, job_id, status, error, run_after, started_at, created_at from agent_runs
       where workspace_id = ${ws.id} and job_id like 'editing.%' and input->>'ref' = any(${refs})
       order by created_at desc`,
    ws.sql<{ subject_id: string; ref: string; subject_type: string; status: string; requested_at: Date }[]>`
      select subject_id, ref, subject_type, status, requested_at from approvals
       where workspace_id = ${ws.id} and kind = 'edit' and subject_id = any(${ids})
       order by requested_at desc`,
    ready
      ? ws.sql<{ edit_job_id: string; version: number; status: string; outcomes: { platform: string; outcome: string; scheduledAt?: string | null; message: string }[] }[]>`
          select edit_job_id, version, status, outcomes from production_releases where workspace_id = ${ws.id} and edit_job_id = any(${ids})`
      : Promise.resolve([]),
    ws.sql<{ job_id: string; s: number }[]>`
      select job_id, avg(extract(epoch from finished_at - started_at))::float as s from agent_runs
       where workspace_id = ${ws.id} and job_id in ('editing.prep', 'editing.plan', 'editing.render', 'editing.revise') and status in ('succeeded', 'waiting_approval')
         and started_at is not null and finished_at is not null and created_at > now() - interval '30 days'
       group by job_id`,
    ws.sql<{ run_id: string; message: string }[]>`
      select distinct on (ev.run_id) ev.run_id, ev.message from agent_events ev
       where ev.workspace_id = ${ws.id} and ev.kind = 'progress' and ev.ts > now() - interval '1 day'
         and ev.run_id in (select id from agent_runs where workspace_id = ${ws.id} and job_id like 'editing.%' and input->>'ref' = any(${refs}) and status in ('queued', 'running'))
       order by ev.run_id, ev.id desc`,
  ]);
  const queued = await ws.sql<{ id: string; run_after: Date }[]>`select id, run_after from agent_runs where workspace_id = ${ws.id} and status = 'queued' and run_after <= now() + interval '1 minute' order by run_after, created_at`;
  const avg = new Map(history.map((h) => [h.job_id, h.s]));
  const progressOf = new Map(events.map((e) => [e.run_id, e.message]));
  const reviewCuts = await reviewCutsSetting();

  const out = rows.map<EditRowView>((r) => {
    const d = r.duration_s ? Number(r.duration_s) : 45;
    const myRuns = runs.filter((x) => x.ref === r.ref);
    const active = myRuns.find((x) => x.status === "running") ?? myRuns.find((x) => x.status === "queued");
    const latest = myRuns[0];
    const myApprovals = approvals.filter((a) => a.subject_id === r.id);
    const final = myApprovals.find((a) => a.subject_type === "edit_render" || a.subject_type === "edit_job");
    const cut = myApprovals.find((a) => a.subject_type === "edit_map" && a.status === "pending");
    const rel = releases.find((x) => x.edit_job_id === r.id && x.version === r.version) ?? null;
    const step = (job: string) => avg.get(job) ?? DEFAULT_S[job]!(d);
    const remainingFrom = (stage: number, job: string | null): number => {
      const later = [stage < 1 ? step("editing.prep") : 0, stage < 2 ? step("editing.plan") : 0, stage < 3 ? step("editing.render") : 0].reduce((a, b) => a + b, 0);
      let current = 0;
      if (job && active) {
        const started = active.started_at ?? active.created_at;
        current = active.status === "running" ? Math.max(10, step(job) - (Date.now() - started.getTime()) / 1000) : step(job);
      }
      return Math.round(current + later);
    };
    const ahead = active?.status === "queued" ? queued.findIndex((q) => q.id === active.id) : -1;
    const base = {
      id: r.id, ref: r.ref, title: r.title ?? r.file_name ?? r.ref, contentId: r.content_id, version: r.version, status: r.status,
      filmBy: r.film_by?.toISOString() ?? null, format: r.format, coverId: r.cover_id, sourceAssetId: r.source_asset_id, outputAssetId: r.output_asset_id,
      durationS: r.duration_s ? Number(r.duration_s) : null, approvalRef: final?.status === "pending" ? final.ref : null,
      release: rel ? { status: rel.status, summary: describe(rel.outcomes, tz) } : null,
      uploadId: r.upload_id, fileName: r.file_name, updatedAt: r.updated_at.toISOString(), createdAt: r.created_at.toISOString(),
      progress: active ? progressOf.get(active.id) ?? null : null,
      queuedAhead: ahead >= 0 ? ahead : null,
      error: null as string | null,
    };
    const failedRun = !active && latest && ["failed"].includes(latest.status) ? latest : null;
    const error = r.upload_error ?? failedRun?.error ?? null;
    const job = active?.job_id ?? null;

    if (r.status === "cancelled") return { ...base, stage: 0, state: "stopped", label: "Stopped", detail: null, etaS: null };
    if (r.status === "approved") {
      const label = rel?.status === "scheduled" ? "Scheduled" : rel?.status === "partial" ? "Partly scheduled" : rel?.status === "failed" ? "Couldn't schedule" : "Approved";
      const stuck = rel?.status === "failed" || rel?.status === "partial";
      return { ...base, stage: 6, state: rel?.status === "failed" ? "failed" : stuck ? "needs_you" : "done", label, detail: stuck ? null : base.release?.summary?.replace(/^Scheduled /, "") ?? "Approved. Scheduling it now.", etaS: null, error: stuck ? base.release?.summary ?? null : null };
    }
    if (r.status === "failed") {
      const at = latest?.job_id === "editing.render" ? 3 : latest?.job_id === "editing.plan" ? 2 : 1;
      return { ...base, stage: at, state: "failed", label: `${STAGES[at]} stopped`, detail: null, etaS: null, error: error ?? "This step stopped." };
    }
    if (r.status === "queued") {
      return { ...base, stage: 0, state: "waiting", label: ahead > 0 ? `In line (${ahead} ahead)` : "Up next", detail: "Prep starts as soon as the editor is free", etaS: remainingFrom(0, job), error };
    }
    if (r.status === "prepping") return { ...base, stage: 1, state: "working", label: "Prepping", detail: "Transcript, pauses and retakes", etaS: remainingFrom(1, job ?? "editing.prep"), error };
    if (r.status === "review" && (cut || r.edit_map_status === "draft")) {
      if (cut && reviewCuts) return { ...base, stage: 1, state: "needs_you", label: "Cuts ready for review", detail: "Review cuts before editing is on", etaS: null, approvalRef: cut.ref, error };
      return { ...base, stage: 1, state: "working", label: "Prepping", detail: "Cut list done, moving on to the plan", etaS: remainingFrom(1, null), error };
    }
    if (r.status === "planning") {
      const revising = job === "editing.revise";
      if (!active && error) return { ...base, stage: 2, state: "failed", label: "Planning stopped", detail: null, etaS: null, error };
      return { ...base, stage: 2, state: "working", label: revising ? `Editing v${r.version + 1}` : "Planning", detail: revising ? "Applying your notes" : "The Art Director is writing the edit plan", etaS: remainingFrom(2, job ?? "editing.plan"), error };
    }
    if (r.status === "rendering") return { ...base, stage: 3, state: "working", label: `Rendering v${r.version}`, detail: "Captions, cuts and sound", etaS: remainingFrom(3, job ?? "editing.render"), error };
    if (r.status === "qc") return { ...base, stage: 4, state: "working", label: "Checking", detail: "Loudness, pauses, frame and captions", etaS: 20, error };
    // review: waiting for the owner, or being revised.
    if (final?.status === "pending") return { ...base, stage: 5, state: "needs_you", label: "Ready for you", detail: `v${r.version} is waiting in Approvals`, etaS: null, error: null };
    if (final?.status === "revised") {
      if (active) return { ...base, stage: 2, state: "working", label: `Editing v${r.version + 1}`, detail: "Applying your notes", etaS: remainingFrom(2, job), error };
      return { ...base, stage: 2, state: error ? "failed" : "working", label: error ? "Changes stopped" : `Editing v${r.version + 1}`, detail: error ? null : "Applying your notes", etaS: error ? null : remainingFrom(2, null), error };
    }
    return { ...base, stage: 5, state: "needs_you", label: "Ready for you", detail: null, etaS: null, error };
  });

  const order = (x: EditRowView) => (x.state === "failed" ? 0 : x.state === "needs_you" ? 1 : x.state === "working" ? 2 : x.state === "waiting" ? 3 : x.state === "done" ? 4 : 5);
  out.sort((a, b) => order(a) - order(b) || (a.filmBy ?? "9").localeCompare(b.filmBy ?? "9") || b.createdAt.localeCompare(a.createdAt));
  return { rows: out, reviewCuts, ready, tz, workerSeen: await workerSeen() };
}

async function reviewCutsSetting(): Promise<boolean> {
  const ws = workspace();
  const cfg = (ws.config.modules.production?.settings as { reviewCuts?: unknown } | undefined)?.reviewCuts;
  try {
    const [row] = await ws.sql<{ value: { reviewCuts?: boolean } }[]>`select value from settings where workspace_id = ${ws.id} and key = 'production:settings'`;
    if (typeof row?.value?.reviewCuts === "boolean") return row.value.reviewCuts;
  } catch {
    // settings table always exists; fall through
  }
  return cfg === true;
}

async function workerSeen(): Promise<string | null> {
  const ws = workspace();
  const [row] = await ws.sql<{ value: { at?: string } }[]>`select value from settings where workspace_id = ${ws.id} and key = 'worker:status'`;
  return row?.value?.at ?? null;
}

function describe(outcomes: { platform: string; outcome: string; scheduledAt?: string | null; message: string }[], tz: string): string | null {
  if (!outcomes?.length) return null;
  const label = (p: string) => ({ instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn", x: "X", threads: "Threads" })[p] ?? p;
  const ok = outcomes.filter((o) => !["invalid", "failed", "rejected"].includes(o.outcome));
  const times = new Map<string, string[]>();
  for (const o of ok) {
    const when = o.scheduledAt
      ? new Date(o.scheduledAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz })
      : "now";
    times.set(when, [...(times.get(when) ?? []), `${label(o.platform)}${o.outcome === "assist" ? " (you post it)" : o.outcome === "awaiting_approval" ? " (waiting for you)" : ""}`]);
  }
  const parts = [...times].map(([w, names]) => `${w === "now" ? "now" : w} on ${names.join(", ")}`);
  const bad = outcomes.filter((o) => !ok.includes(o)).map((o) => `${label(o.platform)}: ${o.message.split("\n")[0]?.replace(/^Fix: /, "")}`);
  return [parts.length ? `Scheduled for ${parts.join("; ")}` : null, bad.length ? `Not scheduled: ${bad.join("; ")}` : null].filter(Boolean).join(". ");
}

export { describe as describeReleaseOutcomes };
