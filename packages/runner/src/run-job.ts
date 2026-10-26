import { type JobDefinition, type ModuleDefinition, type WorkspaceContext } from "@attentionos/core";
import type { RunJobOptions, RunResult } from "./context.ts";
import { RunnerError } from "./errors.ts";
import { runLlmJob, type LlmRunOptions } from "./llm.ts";
import { runNativeJob } from "./native.ts";

export function findJob(modules: ModuleDefinition[], jobId: string): JobDefinition | undefined {
  for (const m of modules) {
    const job = m.jobs.find((j) => j.id === jobId);
    if (job) return job;
  }
  return undefined;
}

export function requireJob(modules: ModuleDefinition[], jobId: string): JobDefinition {
  const job = findJob(modules, jobId);
  if (job) return job;
  const moduleId = jobId.split(".")[0];
  const installed = modules.some((m) => m.manifest.id === moduleId);
  throw new RunnerError(
    "unknown_job",
    installed ? `The ${moduleId} module has no job called "${jobId}".` : `No module provides the job "${jobId}".`,
    installed ? "Run `attentionos status` to see the jobs you can run." : `Turn on the ${moduleId} module in config/attentionos.config.ts, or check the job id.`,
  );
}

/** Runs a native or LLM job with the same bookkeeping. */
export function runJob(ws: WorkspaceContext, job: JobDefinition, input: unknown, opts: LlmRunOptions = {}): Promise<RunResult> {
  return job.kind === "native" ? runNativeJob(ws, job, input, opts as RunJobOptions) : runLlmJob(ws, job, input, opts);
}
