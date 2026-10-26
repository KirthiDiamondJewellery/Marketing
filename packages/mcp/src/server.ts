import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { compact, ToolError, type Actor, type ModuleDefinition, type ToolDefinition, type WorkspaceContext } from "@attentionos/core";
import { agentColumn, recordAgentEvent } from "@attentionos/db";
import { resolveModules, type ModuleProblem, type ProviderDiagnostic } from "@attentionos/runtime";
import { callActor, envActor } from "./actor.ts";
import { coreTools, SELF_LOGGING_TOOLS } from "./core-tools.ts";

export const SERVER_NAME = "attentionos";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "AttentionOS data layer: research, plans, scripts, edits, posts, conversations, results and the approvals queue for this workspace.",
  "Taste lives in the Brand Kit files (read them with core_brand_kit); facts live behind these tools. Never invent numbers: use the proof inventory or tool data.",
  "Nothing goes public without approval: use core_request_approval. When the user corrects work, save the rule with core_append_lesson.",
  "Report progress in plain language with core_log_progress.",
].join(" ");

export type CreateMcpServerOptions = {
  /** Enabled modules whose tools to register. */
  modules: ModuleDefinition[];
  problems?: ModuleProblem[];
  diagnostics?: ProviderDiagnostic[];
  /** Default actor for calls. Defaults to ATTENTIONOS_ACTOR or user:local. */
  actor?: Actor;
  /** Ignore per-call `_actor` claims (Autopilot runs pin the actor to the running agent). */
  lockActor?: boolean;
  /** `agent_runs.id` this server serves; defaults to ATTENTIONOS_RUN_ID. */
  runId?: string;
  /** Register only tools whose name passes (e.g. a job's allowed tools). */
  toolFilter?: (name: string) => boolean;
};

type CallExtra = { _meta?: Record<string, unknown> };

function text(value: unknown, isError = false): CallToolResult {
  const body = typeof value === "string" ? value : JSON.stringify(compact(value) ?? null);
  return isError ? { content: [{ type: "text", text: body }], isError: true } : { content: [{ type: "text", text: body }] };
}

function errorResult(err: unknown, toolName: string): { result: CallToolResult; unexpected: boolean } {
  if (err instanceof ToolError) {
    return { result: text(`Error: ${err.message}${err.hint ? `\nHint: ${err.hint}` : ""}`, true), unexpected: false };
  }
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { result: text(`Error: invalid input for ${toolName}: ${issues}`, true), unexpected: false };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { result: text(`Error: ${toolName} failed: ${message}`, true), unexpected: true };
}

const annotationsOf = (t: ToolDefinition) => ({
  readOnlyHint: t.annotations?.readOnly ?? false,
  destructiveHint: t.annotations?.destructive ?? false,
  idempotentHint: t.annotations?.idempotent ?? false,
  openWorldHint: t.annotations?.openWorld ?? false,
});

/** Registers tool definitions on a server with actor attribution, activity events and compact JSON output. */
export function registerTools(server: McpServer, ws: WorkspaceContext, tools: ToolDefinition[], opts: CreateMcpServerOptions): string[] {
  const baseActor = opts.actor ?? envActor();
  const locked = opts.lockActor ?? false;
  const runId = opts.runId ?? process.env.ATTENTIONOS_RUN_ID ?? null;
  const registered: string[] = [];

  for (const tool of tools) {
    if (opts.toolFilter && !opts.toolFilter(tool.name)) continue;
    const schema = locked
      ? tool.input
      : tool.input.extend({
          _actor: z.string().max(80).optional().describe("Who is acting, e.g. agent:copywriter. Omit when acting for the user."),
        });
    const readOnly = tool.annotations?.readOnly ?? false;

    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: schema, annotations: annotationsOf(tool) },
      async (args: Record<string, unknown>, extra: CallExtra): Promise<CallToolResult> => {
        const { _actor, ...input } = args;
        const actor = callActor(baseActor, locked, _actor ?? extra?._meta?.actor ?? extra?._meta?._actor);
        if (!actor) {
          return text(`Error: "${String(_actor)}" is not a valid actor.\nHint: use agent:<analyst|strategist|copywriter|art_director|publisher|community|chief_of_staff> or user:<id>.`, true);
        }
        const started = Date.now();
        try {
          const output = await tool.handler({ ws, actor }, input);
          if (!readOnly && !SELF_LOGGING_TOOLS.has(tool.name)) {
            await recordAgentEvent(ws.sql, {
              workspaceId: ws.id,
              agent: agentColumn(actor),
              kind: "tool",
              runId,
              message: `Used ${tool.name}`,
              data: { tool: tool.name, actor, ms: Date.now() - started },
            }).catch((err: unknown) => ws.log.warn("could not record tool event", { tool: tool.name, error: (err as Error).message }));
          }
          return text(output);
        } catch (err) {
          const { result, unexpected } = errorResult(err, tool.name);
          if (unexpected) {
            ws.log.error("tool failed", { tool: tool.name, actor, error: (err as Error)?.message });
            await recordAgentEvent(ws.sql, {
              workspaceId: ws.id,
              agent: agentColumn(actor),
              kind: "error",
              runId,
              message: `${tool.name} failed`,
              data: { tool: tool.name, error: (err as Error)?.message ?? String(err) },
            }).catch(() => {});
          }
          return result;
        }
      },
    );
    registered.push(tool.name);
  }
  return registered;
}

/** The AttentionOS MCP server for a loaded workspace: every enabled module's tools plus the core tools. */
export function createMcpServer(ws: WorkspaceContext, opts: CreateMcpServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const core = coreTools({ modules: opts.modules, problems: opts.problems, diagnostics: opts.diagnostics, runId: opts.runId });
  const moduleTools = opts.modules.flatMap((m) => m.tools);
  const coreNames = new Set(core.map((t) => t.name));
  const clash = moduleTools.find((t) => coreNames.has(t.name));
  if (clash) throw new Error(`A module redefines the core tool ${clash.name}`);
  registerTools(server, ws, [...core, ...moduleTools], opts);
  return server;
}

/** Keeps stdout clean for JSON-RPC: anything a library prints goes to stderr instead. */
function protectStdout(): void {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
}

/** Starts the server on stdio (what Claude Code runs through the workspace's .mcp.json). */
export async function startMcpServer(
  ws: WorkspaceContext & { diagnostics?: ProviderDiagnostic[] },
  opts: Partial<CreateMcpServerOptions> = {},
): Promise<{ server: McpServer; close(): Promise<void> }> {
  protectStdout();
  let modules = opts.modules;
  let problems = opts.problems;
  if (!modules) {
    const res = await resolveModules(ws.config);
    modules = res.modules;
    problems = res.problems;
    for (const p of res.problems) ws.log[p.severity === "error" ? "error" : "warn"](p.message);
  }
  const server = createMcpServer(ws, { ...opts, modules, problems, diagnostics: opts.diagnostics ?? ws.diagnostics });
  await server.connect(new StdioServerTransport());
  return { server, close: () => server.close() };
}

/**
 * A minimal server for when no workspace can be loaded (wrong folder, no database yet). Claude Code still connects,
 * and `core_status` explains what to do instead of the plugin showing a broken server.
 */
export function createSetupMcpServer(problem: { message: string; fix?: string }): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: `AttentionOS is not ready: ${problem.message}` });
  server.registerTool(
    "core_status",
    { description: "Explains why AttentionOS isn't ready yet and how to fix it.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => text({ ready: false, problem: problem.message, fix: problem.fix }),
  );
  return server;
}

export async function startSetupMcpServer(problem: { message: string; fix?: string }): Promise<{ server: McpServer; close(): Promise<void> }> {
  protectStdout();
  const server = createSetupMcpServer(problem);
  await server.connect(new StdioServerTransport());
  return { server, close: () => server.close() };
}
