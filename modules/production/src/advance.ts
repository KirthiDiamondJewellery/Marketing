import { agentSettings, type JobContext, type WorkspaceContext } from "@attentionos/core";
import { decideApproval, enqueueRun, recordAgentEvent, RUN_PRIORITY } from "@attentionos/db";
import { requestRender } from "@attentionos/module-editing";
import { kickAdvance, updateUpload } from "./repo.ts";
import { ensureProposal, latestRenderApproval, mayRelease } from "./release.ts";
import { loadProductionSettings } from "./settings.ts";

/**
 * `production.advance`: the step between editing jobs. Each pass looks at every edit started from an upload and
 * moves it one step when it is waiting on nothing but a rule:
 *
 * - cut list waiting and "Review cuts before editing" is off → approved for the owner (they still approve the video);
 * - plan saved and checked but no render queued (the Art Director stopped short) → render it;
 * - a step failed → the take shows the problem and a Retry in Studio;
 * - finished video waiting → propose post slots for the approval card; on autopilot, approve it and schedule it;
 * - approved video not scheduled yet → `production.schedule-approved`.
 *
 * It re-queues itself every few seconds while anything is in flight, so the chain runs prep → plan → render →
 * approval → schedule without anyone pressing a button. Approvals are never skipped unless the owner turned them
 * off (autopilot).
 */

type EditRow = {
  id: string;
  ref: string;
  version: number;
  status: string;
  content_id: string | null;
  plan: Record<string, unknown> | null;
  preflight: { plan?: { ok?: boolean; errors?: { message: string }[] } } | null;
  output_asset_id: string | null;
  upload_id: string | null;
  upload_error: string | null;
  title: string | null;
  updated_at: Date;
};

type RunLite = { id: string; job_id: string; status: string; error: string | null; finished_at: Date | null };

const ACTIVE = new Set(["queued", "running"]);

async function runsFor(ws: Pick<WorkspaceContext, "id" | "sql">, ref: string): Promise<RunLite[]> {
  return ws.sql<RunLite[]>`
    select id, job_id, status, error, finished_at from agent_runs
     where workspace_id = ${ws.id} and job_id like 'editing.%' and input->>'ref' = ${ref}
     order by created_at desc limit 20`;
}

export async function runAdvance(ctx: JobContext<{ reason?: string }>): Promise<Record<string, unknown>> {
  const { ws } = ctx;
  const settings = await loadProductionSettings(ws);
  const steps: string[] = [];
  let inFlight = 0;

  const edits = await ws.sql<EditRow[]>`
    select e.id, e.ref, e.version, e.status, e.content_id, e.plan, e.preflight, e.output_asset_id, u.id as upload_id, u.error as upload_error, c.title, e.updated_at
      from edit_jobs e
      join production_uploads u on u.edit_job_id = e.id and u.workspace_id = e.workspace_id and u.role = 'edit'
      left join content c on c.id = e.content_id
     where e.workspace_id = ${ws.id}
       and (e.status not in ('cancelled', 'failed', 'approved') or e.updated_at > now() - interval '2 days')
     order by e.created_at asc
     limit 100`;

  for (const e of edits) {
    try {
      const runs = await runsFor(ws, e.ref);
      const active = runs.filter((r) => ACTIVE.has(r.status));
      const name = e.title ? `“${e.title}”` : e.ref;
      // The problem shown on the take in Studio: cleared as soon as work moves again.
      const setError = async (msg: string | null) => {
        if (e.upload_id && (e.upload_error ?? null) !== msg) await updateUpload(ws, e.upload_id, { error: msg });
      };
      if (active.length) await setError(null);

      // 1. Cut list waiting for review.
      if (e.status === "review") {
        const [cut] = await ws.sql<{ ref: string }[]>`
          select ref from approvals where workspace_id = ${ws.id} and status = 'pending' and kind = 'edit' and subject_type = 'edit_map' and subject_id = ${e.id} limit 1`;
        if (cut) {
          if (!settings.reviewCuts) {
            await decideApproval(ws.sql, ws.id, { refOrId: cut.ref, decision: "approved", actor: "system", note: "Review cuts before editing is off, so the cuts were approved for you." });
            steps.push(`${e.ref}: cuts approved (review is off)`);
            inFlight++;
          }
          continue;
        }
      }

      // 2. Plan saved and checked, but nothing rendering it.
      if (e.status === "planning" && !active.length) {
        const lastPlan = runs.find((r) => r.job_id === "editing.plan" || r.job_id === "editing.revise");
        if (e.plan && e.preflight?.plan?.ok) {
          const r = await requestRender(ws, "agent:art_director", e.ref, { auto: true });
          steps.push(`${e.ref}: render v${r.version} queued`);
          inFlight++;
          continue;
        }
        if (lastPlan && ["failed", "cancelled", "succeeded"].includes(lastPlan.status)) {
          const why = lastPlan.status === "failed" ? lastPlan.error ?? "the plan step stopped" : e.preflight?.plan?.errors?.[0]?.message ?? "the plan didn't pass its checks";
          await setError(`The Art Director couldn't finish the plan: ${why}`);
          continue;
        }
      }

      if (["queued", "prepping", "planning", "rendering", "qc"].includes(e.status)) {
        inFlight++;
        if (!active.length && runs[0]?.status === "failed") await setError(runs[0].error ?? "A step failed.");
        continue;
      }

      if (e.status === "failed") {
        const failed = runs.find((r) => r.status === "failed");
        await setError(failed?.error ?? "Editing stopped.");
        continue;
      }

      // 3. Finished video: waiting for approval, being revised, or approved.
      const approval = await latestRenderApproval(ws, e.id);
      if (!approval) continue;
      if (approval.status === "pending") {
        await ensureProposal(ws, e, approval.ref);
        if (agentSettings(ws.config, "art_director").autonomy === "autopilot") {
          await decideApproval(ws.sql, ws.id, { refOrId: approval.ref, decision: "approved", actor: "system", note: "The Art Director is on autopilot, so this video was approved automatically." });
          await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: "art_director", kind: "progress", runId: ctx.runId, message: `Approved ${name} v${e.version} on autopilot and sent it to the Publisher`, data: { ref: e.ref, version: e.version, approval: approval.ref } });
          steps.push(`${e.ref}: approved on autopilot`);
          await enqueueSchedule(ws, e.ref, e.version);
          inFlight++;
        }
        continue;
      }
      if (approval.status === "revised") {
        // Waiting for the revision to render (a newer approval replaces this one).
        if (active.length || e.status !== "review") {
          inFlight++;
          continue;
        }
        const revise = runs.find((r) => r.job_id === "editing.revise");
        if (revise?.status === "failed") await setError(`The changes couldn't be made: ${revise.error ?? "the revision stopped"}`);
        else if (revise?.status === "succeeded") {
          const [out] = await ws.sql<{ output: { summary?: string } | null }[]>`select output from agent_runs where workspace_id = ${ws.id} and id = ${revise.id}`;
          await setError(`The Art Director didn't make a new version: ${out?.output?.summary ?? "no change was saved"}`);
        }
        continue;
      }
      if (approval.status === "approved" && mayRelease(ws, approval).ok) {
        const [rel] = await ws.sql<{ status: string }[]>`select status from production_releases where workspace_id = ${ws.id} and edit_job_id = ${e.id} and version = ${e.version}`;
        if (!rel || ["proposed", "approved"].includes(rel.status)) {
          await enqueueSchedule(ws, e.ref, e.version);
          steps.push(`${e.ref}: scheduling v${e.version}`);
          inFlight++;
        } else if (rel.status === "scheduling") inFlight++;
      }
    } catch (err) {
      ctx.log.warn("advance step failed", { ref: e.ref, error: (err as Error).message });
    }
  }

  // Uploads still being matched keep the loop alive too.
  const [{ n: matching } = { n: 0 }] = await ws.sql<{ n: number }[]>`
    select count(*)::int as n from production_uploads where workspace_id = ${ws.id} and status = 'matching' and created_at > now() - interval '1 day'`;
  if (inFlight || matching) await kickAdvance(ws, settings.advanceEveryS, settings.advanceEveryS);
  return { checked: edits.length, inFlight, matching, steps };
}

export async function enqueueSchedule(ws: Pick<WorkspaceContext, "id" | "sql">, ref: string, version: number): Promise<void> {
  await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: "production.schedule-approved",
    agent: "publisher",
    input: { ref, version },
    trigger: "event",
    createdBy: "system",
    dedupeKey: `production:schedule:${ref}:v${version}`,
    // The owner approved it and is waiting to see it on the calendar: ahead of background work.
    priority: RUN_PRIORITY.user,
  });
}
