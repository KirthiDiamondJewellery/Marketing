import { workspaceStatus } from "@attentionos/mcp";
import { parseCommand } from "../args.ts";
import { ui } from "../ui.ts";
import { openWorkspace, type CliContext } from "../workspace.ts";

export async function runStatus(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseCommand("status", argv, { json: { type: "boolean", default: false } });
  if (values.help) {
    ui.out("Show what is set up and what is waiting.\n\nUsage\n  attentionos status [--json]\n");
    return 0;
  }
  const { ws, modules } = await openWorkspace(ctx);
  try {
    const s = await workspaceStatus(ws, { modules: modules.modules, problems: modules.problems, diagnostics: ws.diagnostics });
    if (values.json) {
      ui.out(JSON.stringify(s, null, 2));
      return 0;
    }
    ui.title(`${s.workspace.name}  ${ui.dim(`${s.workspace.mode} mode · ${s.workspace.timezone}`)}`);
    ui.ok("Modules on", s.modules.on.join(", ") || "none installed yet");
    for (const p of modules.problems.filter((x) => x.severity === "warning")) ui.warn(p.message, p.fix);
    for (const p of s.providers) (p.status === "loaded" || p.status === "builtin" ? ui.ok : ui.warn)(`${p.kind}: ${p.choice}`, p.status === "loaded" || p.status === "builtin" ? undefined : p.status.replace("_", " "));
    ui.ok("AI spend today", `$${s.budgets.spentTodayUsd.toFixed(2)} of $${s.budgets.dailyUsd.toFixed(2)}`);
    (s.approvals.pending ? ui.warn : ui.ok)(`${s.approvals.pending} approval${s.approvals.pending === 1 ? "" : "s"} waiting`, s.approvals.pending ? "attentionos approvals" : undefined);
    ui.ok("Jobs", `${s.runs.queued} queued, ${s.runs.running} running, ${s.runs.waitingApproval} waiting for you`);
    if (s.runs.failedToday) ui.warn(`${s.runs.failedToday} job${s.runs.failedToday === 1 ? "" : "s"} failed in the last 24 hours`);
    const jobs = modules.modules.flatMap((m) => m.jobs.map((j) => `${j.id} (${j.kind === "llm" ? "AI" : "data"})`));
    if (jobs.length) {
      ui.out();
      ui.out(ui.bold("Jobs you can run"));
      for (const j of jobs) ui.out(`  ${j}`);
    }
    ui.out();
    return 0;
  } finally {
    await ws.close();
  }
}
