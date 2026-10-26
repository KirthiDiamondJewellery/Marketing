import { z } from "zod";
import { ProviderError, type Actor, type JobContext, type JobDefinition, type ModuleDefinition, type WorkspaceContext } from "@attentionos/core";
import { enqueueRun, finishRun, recordAgentEvent, type RunTrigger } from "@attentionos/db";
import { RunnerError } from "./errors.ts";

export type RunJobOptions = {
  /** An existing `agent_runs` row (the worker's claimed run). Without it an inline run row is created. */
  runId?: string;
  actor?: Actor;
  trigger?: RunTrigger;
  /** Owner recorded as `claimed_by` for inline runs. */
  owner?: string;
  /** Cancels the run (Ctrl-C, Studio cancel, worker shutdown). */
  signal?: AbortSignal;
  /** Overrides the job's timeout. */
  timeoutMs?: number;
  /** Enabled modules: LLM runs expose their tools and skills. */
  modules?: ModuleDefinition[];
};

/** `deferred`: a job's gate put the run back on the queue (it waits for data that is on its way). */
export type RunStatusOut = "succeeded" | "failed" | "cancelled" | "waiting_approval" | "deferred";

export type RunResult = {
  runId: string;
  status: RunStatusOut;
  output?: unknown;
  error?: string;
  costUsd: number;
  turns: number;
  sessionId?: string;
  /** Set when the failure is a provider hiccup worth retrying (rate limit, outage). */
  retryAfterMs?: number;
};

export const DEFAULT_NATIVE_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_LLM_TIMEOUT_MS = 30 * 60_000;

export function parseInput<T extends z.ZodType>(job: { id: string; input: T }, input: unknown): z.output<T> {
  const parsed = job.input.safeParse(input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new RunnerError("invalid_input", `The input for ${job.id} isn't valid: ${issues}`, "Check the --input JSON against the job's description.");
  }
  return parsed.data;
}

export async function openRun(ws: WorkspaceContext, job: JobDefinition, input: unknown, opts: RunJobOptions): Promise<{ runId: string; actor: Actor }> {
  const actor = opts.actor ?? (`agent:${job.agent}` as Actor);
  if (opts.runId) return { runId: opts.runId, actor };
  const { id } = await enqueueRun(ws.sql, {
    workspaceId: ws.id,
    jobId: job.id,
    agent: job.agent,
    input: (input ?? {}) as Record<string, unknown>,
    trigger: opts.trigger ?? "manual",
    createdBy: opts.actor ?? "system",
    startRunningAs: opts.owner ?? `cli:${process.pid}`,
  });
  return { runId: id, actor };
}

export function jobContext<I>(ws: WorkspaceContext, job: JobDefinition, input: I, runId: string, actor: Actor, signal: AbortSignal): JobContext<I> {
  const log = ws.log.child({ job: job.id, run: runId });
  return {
    ws,
    input,
    actor,
    runId,
    log,
    signal,
    async progress(message, data) {
      await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: job.agent, kind: "progress", runId, message, data: data ?? null }).catch((err: unknown) =>
        log.warn("could not record progress", { error: (err as Error).message }),
      );
    },
  };
}

/** A run that asked for approval and is still waiting ends as `waiting_approval`; deciding re-queues it. */
export async function hasPendingApproval(ws: WorkspaceContext, runId: string): Promise<boolean> {
  const rows = await ws.sql`select 1 from approvals where workspace_id = ${ws.id} and run_id = ${runId} and status = 'pending' limit 1`;
  return rows.length > 0;
}

/** JSON-safe output for `agent_runs.output`. */
export function toJsonOutput(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { result: String(value) };
  }
}

export async function closeRun(ws: WorkspaceContext, runId: string, result: Omit<RunResult, "runId" | "status"> & { status: Exclude<RunStatusOut, "deferred"> }): Promise<RunResult> {
  await finishRun(ws.sql, runId, {
    status: result.status,
    output: result.output === undefined ? undefined : toJsonOutput(result.output),
    error: result.error ?? null,
    costMicro: Math.round(result.costUsd * 1_000_000),
    turns: result.turns,
    sessionId: result.sessionId ?? undefined,
  });
  return { runId, ...result };
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Provider hiccups worth another attempt (rate limits, vendor outages). */
export function retryDelayMs(err: unknown): number | null {
  if (err instanceof ProviderError && (err.code === "rate_limited" || err.code === "upstream")) return err.details?.retryAfterMs ?? 60_000;
  return null;
}
