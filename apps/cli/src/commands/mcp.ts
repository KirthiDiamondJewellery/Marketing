import { startMcpServer, startSetupMcpServer } from "@attentionos/mcp";
import { loadWorkspace, resolveModules, WorkspaceError } from "@attentionos/runtime";
import { cliLogger, workspaceDir, type CliContext } from "../workspace.ts";

/**
 * `attentionos mcp`: the MCP server Claude Code starts from the workspace's .mcp.json (inside the stack, or through `docker compose exec`).
 * stdout is the JSON-RPC channel, so nothing else may print there. If the workspace can't load, a setup-only server
 * starts instead so Claude Code can tell the user what to fix.
 */
export async function runMcp(_argv: string[], ctx: CliContext): Promise<number> {
  const log = cliLogger(ctx, "warn");
  let ws: Awaited<ReturnType<typeof loadWorkspace>>;
  try {
    ws = await loadWorkspace(workspaceDir(ctx), { log });
  } catch (err) {
    const e = err as { message?: string; fix?: string };
    log.error("AttentionOS MCP server started in setup mode", { problem: e.message });
    await startSetupMcpServer({ message: e.message ?? String(err), fix: err instanceof WorkspaceError ? e.fix : "Run `./aos doctor` from your AttentionOS folder." });
    return await new Promise<number>(() => {});
  }
  const res = await resolveModules(ws.config, { search: { workspaceRoot: ws.paths.root } });
  for (const p of res.problems) log[p.severity === "error" ? "error" : "warn"](p.message);
  // Set by the runner when `claude -p` starts this server for one agent run (see packages/runner/src/llm.ts).
  const toolList = process.env.ATTENTIONOS_TOOLS?.split(",").map((t) => t.trim()).filter(Boolean);
  const toolFilter = toolList && !toolList.includes("*") ? (name: string) => toolList.includes(name) : undefined;
  const { close } = await startMcpServer(ws, {
    modules: res.modules,
    problems: res.problems,
    diagnostics: ws.diagnostics,
    ...(process.env.ATTENTIONOS_LOCK_ACTOR === "1" ? { lockActor: true } : {}),
    ...(toolFilter ? { toolFilter } : {}),
  });
  const shutdown = async () => {
    await close().catch(() => {});
    await ws.close();
    process.exit(0);
  };
  process.stdin.on("close", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return await new Promise<number>(() => {});
}
