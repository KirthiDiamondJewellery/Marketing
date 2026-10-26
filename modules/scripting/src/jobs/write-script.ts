import { z } from "zod";
import { defineLlmJob, type Actor, type WorkspaceContext } from "@attentionos/core";
import { scriptPackageSchema, suggestKeywords, validateScript, type ScriptPackage, type ValidationResult } from "@attentionos/guardrails";
import { getContent, getContentKeyword, ledgerWords } from "../db.ts";
import { writeScriptAgentPrompt, writeScriptPrompt } from "../prompts.ts";
import { parseScriptPackage, reviseUntilValid, type RevisionAttempt } from "../revision.ts";
import { writePacket } from "../packet.ts";
import { remixGate, remixSourceId } from "../remix.ts";
import { buildScriptRules, getClaimSources, getContentBrief, pickHooks, saveScript, validateForContent } from "../service.ts";
import { scriptingSettings } from "../settings.ts";

/** The owner's change request on a script version (from Studio, chat or the CLI): the revision path. */
export const reviseRequestSchema = z.object({
  approvalRef: z.string().max(40).optional(),
  fromVersion: z.number().int().positive().optional(),
  notes: z.string().trim().min(1).max(2000),
});
export type ReviseRequest = z.output<typeof reviseRequestSchema>;

export const writeScriptInput = z.object({
  contentId: z.string().uuid(),
  /** Set when the owner asked for changes: write the next version from these notes. */
  revise: reviseRequestSchema.optional(),
});

/**
 * The work packet carries the brief, claim sources, keywords, hook picks and recent scripts, so the run needs only
 * the save (which validates) and the remix switch. Lookups stay available for the rare case the packet isn't enough.
 */
const TOOLS = [
  "scripting_save_script",
  "scripting_use_remix_source",
  "scripting_find_remix_sources",
  "scripting_get_content_brief",
  "knowledge_search",
].map((t) => `mcp__attentionos__${t}`);

/**
 * `scripting.write-script`: one content id → a versioned, validated script awaiting human approval.
 * In agent mode the loop is enforced by the tools: scripting_save_script validates in code, returns the
 * exact fixes and tells the agent to stop once the revision budget is spent.
 */
export const writeScriptJob = defineLlmJob({
  kind: "llm",
  id: "scripting.write-script",
  agent: "copywriter",
  description: "Writes a script for one content idea, checks it, and sends it for review.",
  input: writeScriptInput,
  skill: "write-script",
  defaultModel: "opus",
  maxTurns: 30,
  budgetUsd: 1,
  timeoutMs: 10 * 60_000,
  allowedTools: ["Read", ...TOOLS],
  // A remix is written only from its source's checked blueprint: until it's in, the run waits (in code, no model time).
  gate: (ctx) => remixGate(ctx.ws, ctx.input.contentId, { runId: ctx.runId }),
  prompt: async (ctx) => {
    const content = await getContent(ctx.ws, ctx.input.contentId);
    const mode = content && remixSourceId(content) ? "remix" : "original";
    const packet = await writePacket(ctx.ws, ctx.input.contentId);
    return writeScriptAgentPrompt(ctx.input.contentId, scriptingSettings(ctx.ws).maxRevisions, ctx.input.revise, mode, packet);
  },
});

/** A tool-less model call: prompt in, text (or parsed JSON) out. Wired by the worker to its LLM runner. */
export type ScriptModel = (req: { prompt: string; feedback: string | null; attempt: number }) => Promise<unknown>;

export type WriteScriptOutcome = {
  ok: boolean;
  scriptId: string | null;
  version: number | null;
  approvalRef: string | null;
  attempts: { attempt: number; ok: boolean; errors: number }[];
  report: ValidationResult;
  summary: string;
};

/**
 * Code-driven version of the job for runners that call the model directly: draft → validate in code →
 * send the exact fixes back (at most `maxRevisions` times) → save the version → request approval.
 * The best failing draft is still saved (as a draft, no approval) so a person can finish it.
 */
export async function runWriteScript(deps: {
  ws: WorkspaceContext;
  actor: Actor;
  contentId: string;
  model: ScriptModel;
  revise?: ReviseRequest;
  runId?: string | null;
  progress?: (message: string) => Promise<void> | void;
  rng?: () => number;
}): Promise<WriteScriptOutcome> {
  const { ws, contentId } = deps;
  const settings = scriptingSettings(ws);
  const content = await getContent(ws, contentId);
  if (!content) throw new Error(`No content item with id ${contentId}.`);
  const brief = await getContentBrief(ws, contentId);
  const hooks = await pickHooks(ws, { count: remixSourceId(content) ? 2 : 3, rng: deps.rng });
  const sources = await getClaimSources(ws, contentId, settings);
  const rules = await buildScriptRules(ws, contentId, settings);
  const reserved = await getContentKeyword(ws, contentId);
  const keywordSuggestions = reserved ? [] : suggestKeywords({ topicText: `${content.title} ${content.angle ?? ""}`, ledgerWords: await ledgerWords(ws, contentId), count: 5 });
  const prompt = writeScriptPrompt({ brief, hooks: hooks.picks.map((p) => p.view), sources, keywordSuggestions, reservedKeyword: reserved?.word ?? null, revise: deps.revise ?? null });

  await deps.progress?.(deps.revise ? `Revising "${content.title}" from your notes` : `Drafting a script for "${content.title}"`);
  const outcome = await reviseUntilValid<ScriptPackage>({
    maxRevisions: settings.maxRevisions,
    generate: (feedback, attempt) => deps.model({ prompt: feedback ? `${prompt}\n\n${feedback}` : prompt, feedback, attempt }),
    parse: parseScriptPackage,
    validate: async (pkg) => (await validateForContent(ws, content, pkg, rules)).report,
    onAttempt: async (a: RevisionAttempt<ScriptPackage>) => {
      if (!a.ok) await deps.progress?.(`Draft ${a.attempt + 1} missed ${a.report.errors.length} check${a.report.errors.length === 1 ? "" : "s"}; revising`);
    },
  });
  const attempts = outcome.attempts.map((a) => ({ attempt: a.attempt, ok: a.ok, errors: a.report.errors.length }));

  if (!outcome.value) {
    return { ok: false, scriptId: null, version: null, approvalRef: null, attempts, report: outcome.report, summary: `No usable draft for "${content.title}" after ${attempts.length} tries.` };
  }
  const saved = await saveScript(ws, deps.actor, { contentId, package: scriptPackageSchema.parse(outcome.value), requestApproval: true, runId: deps.runId ?? null });
  const summary = saved.ok
    ? `Drafted a script for "${content.title}" (version ${saved.version}); waiting for review${saved.approvalRef ? ` (${saved.approvalRef})` : ""}.`
    : `Saved a draft for "${content.title}" (version ${saved.version}) that still misses ${saved.report.errors.length} check${saved.report.errors.length === 1 ? "" : "s"}; it needs a person to finish it.`;
  await deps.progress?.(summary);
  return { ok: saved.ok, scriptId: saved.scriptId, version: saved.version, approvalRef: saved.approvalRef, attempts, report: saved.report, summary };
}

/** Exposed for tests and the validate tool: validates without touching the database beyond reads. */
export async function dryRunValidate(ws: WorkspaceContext, contentId: string, pkg: unknown): Promise<ValidationResult> {
  const content = await getContent(ws, contentId);
  if (!content) return validateScript(pkg, {});
  return (await validateForContent(ws, content, pkg)).report;
}
