import { runGuard } from "@attentionos/guardrails";
import { silentLogger, type WorkspaceContext } from "@attentionos/core";
import { importOptional, loadWorkspace, type LoadedWorkspace } from "@attentionos/runtime";
import { parseCommand } from "../args.ts";
import { UserError } from "../errors.ts";
import { ui } from "../ui.ts";
import { workspaceDir, type CliContext } from "../workspace.ts";

async function drainStdin(): Promise<void> {
  if (process.stdin.isTTY) return;
  for await (const _ of process.stdin) {
    // Claude Code sends the hook payload; session-start doesn't need it.
  }
}

/**
 * Claude Code hooks, called by the plugin's hooks/run.mjs. Both fail open: a hook must never block a session or
 * a write because AttentionOS itself had a problem.
 *   attentionos hook session-start   prints approvals waiting and today's filming (from the ops module)
 *   attentionos hook copy-guard      runs the copy guard on the hook payload (same as attentionos-guard --hook)
 */
export async function runHook(argv: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand("hook", argv, { json: { type: "boolean", default: false } });
  const mode = positionals[0];
  if (values.help || !mode) {
    ui.out("Claude Code hooks (used by the AttentionOS plugin).\n\nUsage\n  attentionos hook session-start\n  attentionos hook copy-guard [--json]\n");
    return values.help ? 0 : 1;
  }
  if (mode === "copy-guard") {
    try {
      return await runGuard(["--hook", ...(values.json ? ["--json"] : [])]);
    } catch {
      return 0;
    }
  }
  if (mode !== "session-start") throw new UserError(`Unknown hook "${mode}".`, "Use session-start or copy-guard.");

  let ws: LoadedWorkspace | undefined;
  try {
    await drainStdin();
    ws = await loadWorkspace(workspaceDir(ctx), { providers: false, ensureRow: false, log: silentLogger });
    const ops = await importOptional<{ sessionStartSummary?: (w: WorkspaceContext) => Promise<string> }>("@attentionos/module-ops", { workspaceRoot: ws.paths.root });
    if (ops.ok && typeof ops.module.sessionStartSummary === "function") {
      const text = (await ops.module.sessionStartSummary(ws)).trim();
      if (text) ui.out(text);
    }
  } catch (err) {
    if (ctx.debug) process.stderr.write(`session-start: ${(err as Error).message}\n`);
  } finally {
    await ws?.close().catch(() => {});
  }
  return 0;
}
