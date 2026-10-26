import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The run whose code is executing right now, so runs it queues are linked to it (`parent_run_id`) and inherit its
 * priority: a user's upload → pipeline check → prep → plan → render all stay ahead of background work.
 *
 * Set by the worker and the runner around each job (`withRunScope`). The MCP server an agent run starts gets the run
 * id as ATTENTIONOS_RUN_ID, which counts for the whole process (and is set on its database connections, so raw
 * inserts are linked by the database trigger too).
 */
const scope = new AsyncLocalStorage<{ runId: string }>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function withRunScope<T>(runId: string, fn: () => T): T {
  return scope.run({ runId }, fn);
}

export function currentRunId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const inScope = scope.getStore()?.runId;
  if (inScope) return inScope;
  const fromEnv = env.ATTENTIONOS_RUN_ID?.trim();
  return fromEnv && UUID.test(fromEnv) ? fromEnv : undefined;
}
