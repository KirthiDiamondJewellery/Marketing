import type { NativeJob, WorkspaceContext } from "@attentionos/core";
import { recordAgentEvent, withRunScope } from "@attentionos/db";
import {
  closeRun,
  DEFAULT_NATIVE_TIMEOUT_MS,
  errorMessage,
  hasPendingApproval,
  jobContext,
  openRun,
  parseInput,
  retryDelayMs,
  type RunJobOptions,
  type RunResult,
} from "./context.ts";

/** Runs deterministic job code with input validation, a timeout, cancellation and run bookkeeping. */
export async function runNativeJob(ws: WorkspaceContext, job: NativeJob, input: unknown, opts: RunJobOptions = {}): Promise<RunResult> {
  const parsed = parseInput(job, input);
  const { runId, actor } = await openRun(ws, job, parsed, opts);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? job.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS;
  let timedOut = false;
  const onAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) controller.abort(opts.signal.reason);

  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, timeoutMs);
    const stop = () => reject(controller.signal.reason ?? new Error("aborted"));
    // Already aborted (the caller cancelled while the run row was being created): an abort listener would never fire.
    if (controller.signal.aborted) stop();
    else controller.signal.addEventListener("abort", stop, { once: true });
  });
  stopped.catch(() => {});

  try {
    const ctx = jobContext(ws, job, parsed, runId, actor, controller.signal);
    // Runs this job queues are its follow-ups: linked to it and at its queue priority.
    const output = await Promise.race([withRunScope(runId, () => job.run(ctx)), stopped]);
    const status = (await hasPendingApproval(ws, runId)) ? "waiting_approval" : "succeeded";
    return await closeRun(ws, runId, { status, output, costUsd: 0, turns: 0 });
  } catch (err) {
    const cancelled = !timedOut && controller.signal.aborted;
    const error = timedOut ? `Stopped after ${Math.round(timeoutMs / 60_000) || 1} min (time limit).` : cancelled ? "Cancelled." : errorMessage(err);
    await recordAgentEvent(ws.sql, { workspaceId: ws.id, agent: job.agent, kind: "error", runId, message: error }).catch(() => {});
    const closed = await closeRun(ws, runId, { status: cancelled ? "cancelled" : "failed", error, costUsd: 0, turns: 0 });
    const retryAfterMs = cancelled || timedOut ? null : retryDelayMs(err);
    return retryAfterMs === null ? closed : { ...closed, retryAfterMs };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
