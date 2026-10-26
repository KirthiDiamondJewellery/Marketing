import type { Sql } from "@attentionos/core";
import { currentRunId } from "./run-scope.ts";

/**
 * Postgres job queue on `agent_runs`: claimed with FOR UPDATE SKIP LOCKED, heart-beaten, recovered.
 * Higher `priority` runs first (see migrations/20261023000000_queue_priority.sql); every new run sends NOTIFY.
 *
 * Worker-side helpers (heartbeatRuns, recoverStaleRuns, finishRun, requeueRun, cancelledRuns) are keyed by run id
 * only and cross workspaces on purpose: one worker serves many workspaces, and the run ids come from its own claims
 * (`claimed_by`), never from user or LLM input. Anything that takes an id from a tool or a person filters by
 * `workspace_id` (getRun, retryRun, expediteRun, requeueInterrupted).
 */

/** Queue priorities. Anything a person is waiting on is at least `user`; workers keep a slot for it. */
export const RUN_PRIORITY = { background: 0, user: 100, chat: 110 } as const;

/** NOTIFY channel for new and re-queued runs. Payload: {"ws": workspace id, "priority": n, "inMs": until run_after}. */
export const RUN_NOTIFY_CHANNEL = "aos_runs";

export type RunTrigger = "schedule" | "manual" | "event" | "chat" | "webhook" | "handoff";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "waiting_approval";

export type AgentRunRow = {
  id: string;
  workspace_id: string;
  agent: string;
  job_id: string;
  trigger: RunTrigger;
  status: RunStatus;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  cost_micro: string | number;
  turns: number;
  session_id: string | null;
  parent_run_id: string | null;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  claimed_by: string | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_by: string;
  created_at: Date;
  priority: number;
};

export type EnqueueInput = {
  workspaceId: string;
  jobId: string;
  agent: string;
  input?: Record<string, unknown>;
  trigger?: RunTrigger;
  createdBy?: string;
  /**
   * Skips the insert when any run (in any state) already used this key, e.g. `schedule:<job>:<fire time>`
   * or a webhook delivery id.
   */
  dedupeKey?: string;
  /** Skips the insert while another run of the same job is queued or running (scheduled jobs). */
  skipIfActive?: boolean;
  runAfter?: Date;
  parentRunId?: string;
  maxAttempts?: number;
  /** Insert directly as running, claimed by this owner (inline runs from the CLI). */
  startRunningAs?: string;
  /**
   * Overrides the queue priority. By default the database picks it: chat 110, anything created by `user:*` (or a
   * root manual run) 100, a run started from another run inherits that run's priority, background work 0.
   */
  priority?: number;
};

/** The priority a person's request gets without an explicit one (mirrors the database default), or null. */
export function requestedPriority(e: Pick<EnqueueInput, "priority" | "trigger" | "createdBy">): number | null {
  if (e.priority !== undefined) return e.priority;
  if (e.trigger === "chat") return RUN_PRIORITY.chat;
  if (e.createdBy?.startsWith("user:")) return RUN_PRIORITY.user;
  return null;
}

export async function enqueueRun(sql: Sql, e: EnqueueInput): Promise<{ id: string; deduped: boolean }> {
  const status: RunStatus = e.startRunningAs ? "running" : "queued";
  // A run queued from inside another run (its job code or its MCP server) is that run's follow-up.
  const context = e.parentRunId ? undefined : currentRunId();
  const parent = e.parentRunId
    ? sql`${e.parentRunId}::uuid`
    : context
      ? sql`(select id from agent_runs where id = ${context}::uuid and workspace_id = ${e.workspaceId})`
      : null;
  const rows = await sql<{ id: string }[]>`
    insert into agent_runs (workspace_id, agent, job_id, trigger, status, input, created_by, dedupe_key, run_after,
                            parent_run_id, max_attempts, claimed_by, heartbeat_at, started_at, attempts, priority)
    select ${e.workspaceId}, ${e.agent}, ${e.jobId}, ${e.trigger ?? "manual"}, ${status}, ${sql.json((e.input ?? {}) as never)},
           ${e.createdBy ?? "system"}, ${e.dedupeKey ?? null}, ${e.runAfter ?? sql`now()`}, ${parent},
           ${e.maxAttempts ?? 3}, ${e.startRunningAs ?? null},
           ${e.startRunningAs ? sql`now()` : null}, ${e.startRunningAs ? sql`now()` : null}, ${e.startRunningAs ? 1 : 0},
           ${e.priority ?? null}::int
     where ${e.dedupeKey ? sql`not exists (select 1 from agent_runs where workspace_id = ${e.workspaceId} and dedupe_key = ${e.dedupeKey})` : sql`true`}
       and ${e.skipIfActive ? sql`not exists (select 1 from agent_runs where workspace_id = ${e.workspaceId} and job_id = ${e.jobId} and status in ('queued', 'running'))` : sql`true`}
    on conflict do nothing
    returning id`;
  if (rows[0]) return { id: rows[0].id, deduped: false };
  const [existing] = e.dedupeKey
    ? await sql<{ id: string }[]>`select id from agent_runs where workspace_id = ${e.workspaceId} and dedupe_key = ${e.dedupeKey} order by created_at desc limit 1`
    : await sql<{ id: string }[]>`select id from agent_runs where workspace_id = ${e.workspaceId} and job_id = ${e.jobId} and status in ('queued', 'running') order by created_at desc limit 1`;
  // A person asking for work that's already waiting in the background: move that run up instead of queuing another.
  const wanted = requestedPriority(e);
  if (existing && wanted !== null) await expediteRun(sql, e.workspaceId, existing.id, wanted);
  return { id: existing?.id ?? "", deduped: true };
}

/**
 * Moves a queued run up to `priority` (when it's lower) and makes it runnable now: someone asked for work that was
 * already waiting in the background. Returns whether the run changed.
 */
export async function expediteRun(sql: Sql, workspaceId: string, runId: string, priority: number = RUN_PRIORITY.user): Promise<boolean> {
  const rows = await sql`
    update agent_runs set priority = greatest(priority, ${priority}::int), run_after = least(run_after, now())
     where id = ${runId} and workspace_id = ${workspaceId} and status = 'queued'
       and (priority < ${priority}::int or run_after > now())
    returning id`;
  return rows.length > 0;
}

export type ClaimFilter = {
  /** Only runs at or above this priority (a worker's slot reserved for user work). */
  minPriority?: number;
  /** Skip these jobs (heavy jobs while the worker already runs its limit of them). */
  excludeJobs?: string[];
};

/** Claims the next runnable run of this workspace for `workerId` (highest priority first), or null. */
export async function claimRun(sql: Sql, workspaceId: string, workerId: string, agents?: string[], filter: ClaimFilter = {}): Promise<AgentRunRow | null> {
  const rows = await sql<AgentRunRow[]>`
    select * from aos_claim_run_ws(${workerId}, ${workspaceId}, ${agents ?? null}, ${filter.minPriority ?? null}::int,
                                   ${filter.excludeJobs?.length ? filter.excludeJobs : null}::text[])`;
  return rows[0] ?? null;
}

export async function heartbeatRuns(sql: Sql, runIds: string[], workerId: string): Promise<void> {
  if (!runIds.length) return;
  await sql`update agent_runs set heartbeat_at = now() where id = any(${runIds}) and claimed_by = ${workerId} and status = 'running'`;
}

/** Requeues (or fails, after max attempts) runs whose worker stopped heart-beating. Returns how many changed. */
export async function recoverStaleRuns(sql: Sql, staleAfterSeconds = 300): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select aos_recover_stale_runs(make_interval(secs => ${staleAfterSeconds})) as n`;
  return row?.n ?? 0;
}

export type FinishRunPatch = {
  status: Exclude<RunStatus, "queued" | "running">;
  output?: unknown;
  error?: string | null;
  costMicro?: number;
  turns?: number;
  sessionId?: string | null;
};

export async function finishRun(sql: Sql, runId: string, patch: FinishRunPatch): Promise<void> {
  await sql`
    update agent_runs set
      status = ${patch.status},
      output = ${patch.output === undefined ? sql`output` : patch.output === null ? null : sql.json(patch.output as never)},
      error = ${patch.error ?? null},
      cost_micro = ${patch.costMicro === undefined ? sql`cost_micro` : Math.round(patch.costMicro)},
      turns = ${patch.turns ?? sql`turns`},
      session_id = ${patch.sessionId === undefined ? sql`session_id` : patch.sessionId},
      finished_at = ${patch.status === "waiting_approval" ? null : sql`now()`},
      heartbeat_at = now()
    where id = ${runId}`;
}

/** Puts a running run back on the queue (graceful shutdown, retryable provider errors). */
export async function requeueRun(sql: Sql, runId: string, opts: { delaySeconds?: number; error?: string; refundAttempt?: boolean } = {}): Promise<void> {
  await sql`
    update agent_runs set status = 'queued', claimed_by = null,
      run_after = now() + make_interval(secs => ${opts.delaySeconds ?? 0}),
      attempts = ${opts.refundAttempt ? sql`greatest(attempts - 1, 0)` : sql`attempts`},
      error = ${opts.error ?? null}
    where id = ${runId} and status = 'running'`;
}

export async function getRun(sql: Sql, workspaceId: string, runId: string): Promise<AgentRunRow | null> {
  const [row] = await sql<AgentRunRow[]>`select * from agent_runs where id = ${runId} and workspace_id = ${workspaceId}`;
  return row ?? null;
}

/** Ids among `runIds` that someone cancelled (Studio, chat). */
export async function cancelledRuns(sql: Sql, runIds: string[]): Promise<string[]> {
  if (!runIds.length) return [];
  const rows = await sql<{ id: string }[]>`select id from agent_runs where id = any(${runIds}) and status = 'cancelled'`;
  return rows.map((r) => r.id);
}

/** Re-queues a failed run for another attempt after `delaySeconds` (retryable provider errors). */
export async function retryRun(sql: Sql, workspaceId: string, runId: string, delaySeconds: number): Promise<boolean> {
  const rows = await sql`
    update agent_runs set status = 'queued', claimed_by = null, finished_at = null,
      run_after = now() + make_interval(secs => ${Math.max(0, Math.round(delaySeconds))})
    where id = ${runId} and workspace_id = ${workspaceId} and status = 'failed' and attempts < max_attempts
    returning id`;
  return rows.length > 0;
}

/** Puts runs interrupted by a worker shutdown back on the queue without spending an attempt. */
export async function requeueInterrupted(sql: Sql, workspaceId: string, runIds: string[]): Promise<void> {
  if (!runIds.length) return;
  await sql`
    update agent_runs set status = 'queued', claimed_by = null, finished_at = null, error = null,
      attempts = greatest(attempts - 1, 0), run_after = now()
    where workspace_id = ${workspaceId} and id = any(${runIds}) and status in ('running', 'cancelled', 'failed')`;
}
