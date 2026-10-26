import type { z } from "zod";
import type { Actor, AgentKey } from "./types.ts";
import type { WorkspaceContext } from "./workspace.ts";
import type { Logger } from "./log.ts";

/** A job is the unit the scheduler and queue run: native (deterministic code) or llm (agent run). */
export type JobContext<I> = {
  ws: WorkspaceContext;
  input: I;
  actor: Actor;
  /** `agent_runs.id`. */
  runId: string;
  log: Logger;
  signal: AbortSignal;
  /** Append a progress event visible in the activity stream (plain language, no internals). */
  progress(message: string, data?: Record<string, unknown>): Promise<void>;
};

type JobBase<I extends z.ZodType> = {
  /** Globally unique, `<module>.<job>` e.g. "research.competitor-scan". */
  id: string;
  agent: AgentKey;
  /** Plain-language description shown in the activity stream and docs. */
  description: string;
  input: I;
  /** Default timeout. */
  timeoutMs?: number;
  /** CPU- or memory-heavy work (renders, transcription): the worker runs only a few of these at once. */
  heavy?: boolean;
};

export type NativeJob<I extends z.ZodType = z.ZodType, O = unknown> = JobBase<I> & {
  kind: "native";
  run(ctx: JobContext<z.output<I>>): Promise<O>;
};

/**
 * What an LLM job's `gate` decides before the model starts: `wait` puts the run back on the queue for later without
 * using up an attempt (the data it needs is on its way); `stop` ends it as failed with a plain reason.
 */
export type JobGate = { wait: { ms: number; reason: string } } | { stop: string };

export type LlmJob<I extends z.ZodType = z.ZodType> = JobBase<I> & {
  kind: "llm";
  /** Skill the agent must follow (directory name under the module's skills/). */
  skill: string;
  /** Builds the task prompt. Must reference Brand Kit files by path, never inline brand literals. */
  prompt(ctx: JobContext<z.output<I>>): string | Promise<string>;
  /** MCP tool names (e.g. "mcp__attentionos__scripting_save_script") and built-in tools the agent may use. */
  allowedTools: string[];
  /** Untrusted-input jobs (scraped text, DMs) must set this: no tools at all, output validated. */
  toolless?: boolean;
  defaultModel?: "opus" | "sonnet" | "haiku";
  /** Reasoning effort (the model's default when unset). Lower answers sooner; keep the default for craft work. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  budgetUsd?: number;
  /** When present the runner validates the final JSON output against it. */
  output?: z.ZodType;
  /**
   * Persists the validated output (e.g. save classifications, create rows). Called by the runner after
   * validation succeeds; required for toolless jobs, which can't write through MCP tools themselves.
   */
  onOutput?(ctx: JobContext<z.output<I>>, output: unknown): Promise<void>;
  /**
   * Returns an earlier agent session to continue (e.g. an edit's revision loop keeps the Art Director's context).
   * Ignored when the runner is given an explicit session or is resuming after an approval decision.
   */
  resumeSession?(ctx: JobContext<z.output<I>>): Promise<string | undefined>;
  /**
   * Checked in code before the model starts, so no model time is spent on a run that can't do its job yet (e.g. a
   * remix whose source post has no checked blueprint). Return null to go ahead.
   */
  gate?(ctx: JobContext<z.output<I>>): Promise<JobGate | null>;
};

export type JobDefinition = NativeJob | LlmJob;

export function defineNativeJob<I extends z.ZodType, O>(job: NativeJob<I, O>): NativeJob<I, O> {
  return job;
}

export function defineLlmJob<I extends z.ZodType>(job: LlmJob<I>): LlmJob<I> {
  return job;
}
