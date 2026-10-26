"use server";

import { requireSession } from "@/server/auth";
import { enqueueRun, recordAgentEvent } from "@attentionos/db";
import { refresh } from "next/cache";
import { AGENT_INFO, isAgentKey } from "@/components/agents/meta";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, id as idSchema, key, parse } from "@/server/validate";
import type { ActionResult } from "./approvals";

const ACTOR = "user:studio";

/** "Run now": queues one of the agent's own jobs for the worker. */
export async function runNowAction(agent: string, jobId: string): Promise<ActionResult & { runId?: string }> {
  await requireSession();
  if (!parse(z.object({ agent: key, jobId: key }), { agent, jobId })) return { ok: false, error: BAD_REQUEST };
  if (!isAgentKey(agent)) return { ok: false, error: "Unknown agent." };
  const job = AGENT_INFO[agent].jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, error: "That agent can't run this job from Studio." };
  const ws = workspace();
  const { id, deduped } = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId,
    agent,
    trigger: "manual",
    createdBy: ACTOR,
    input: {},
    skipIfActive: true,
  });
  if (!deduped) {
    await recordAgentEvent(ws.sql, {
      workspaceId: ws.id,
      agent: ACTOR,
      kind: "handoff",
      runId: id || null,
      message: `Asked ${AGENT_INFO[agent].name} to ${job.label.charAt(0).toLowerCase()}${job.label.slice(1)}`,
      data: { to: agent, jobId },
    });
  }
  refresh();
  return { ok: true, runId: id, message: deduped ? `${AGENT_INFO[agent].name} is already on it` : `${job.label}: queued` };
}

/** Stops a queued or running run. The worker notices on its next heartbeat. */
export async function cancelRunAction(runId: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(idSchema, runId)) return { ok: false, error: "Unknown run." };
  const ws = workspace();
  const rows = await ws.sql<{ agent: string; job_id: string }[]>`
    update agent_runs set status = 'cancelled', finished_at = now()
     where id = ${runId} and workspace_id = ${ws.id} and status in ('queued', 'running', 'waiting_approval')
     returning agent, job_id`;
  if (!rows[0]) return { ok: false, error: "That task already finished." };
  await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", runId, message: `Stopped a task for ${rows[0].agent.replace(/_/g, " ")}`, data: { jobId: rows[0].job_id } });
  refresh();
  return { ok: true, message: "Stopped" };
}

/** Re-queues a failed run for another attempt. */
export async function retryRunAction(runId: string): Promise<ActionResult> {
  await requireSession();
  if (!parse(idSchema, runId)) return { ok: false, error: "Unknown run." };
  const ws = workspace();
  const rows = await ws.sql<{ id: string }[]>`
    update agent_runs set status = 'queued', claimed_by = null, finished_at = null, error = null, run_after = now(),
           priority = greatest(priority, 100), max_attempts = greatest(max_attempts, attempts + 1)
     where id = ${runId} and workspace_id = ${ws.id} and status in ('failed', 'cancelled')
     returning id`;
  if (!rows[0]) return { ok: false, error: "Only failed or stopped tasks can be retried." };
  await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: ACTOR, kind: "progress", runId, message: "Asked for another try" });
  refresh();
  return { ok: true, message: "Queued again" };
}
