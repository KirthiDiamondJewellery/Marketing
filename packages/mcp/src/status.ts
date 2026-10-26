import { microToUsd, type ModuleDefinition, type WorkspaceContext } from "@attentionos/core";
import { countPendingApprovals, spendTodayMicro } from "@attentionos/db";
import type { ModuleProblem, ProviderDiagnostic } from "@attentionos/runtime";

export type StatusInfo = {
  modules: ModuleDefinition[];
  problems?: ModuleProblem[];
  diagnostics?: ProviderDiagnostic[];
};

export type WorkspaceStatus = {
  workspace: { id: string; name: string; timezone: string; mode: string; preset: string };
  modules: { on: string[]; problems: string[] };
  providers: { kind: string; choice: string; status: string; detail?: string }[];
  budgets: { dailyUsd: number; perRunUsd: number; spentTodayUsd: number };
  approvals: { pending: number };
  runs: { queued: number; running: number; waitingApproval: number; failedToday: number };
};

/** One snapshot shared by `core_status`, `attentionos status` and the morning brief. */
export async function workspaceStatus(ws: WorkspaceContext, info: StatusInfo): Promise<WorkspaceStatus> {
  const { config } = ws;
  const now = ws.now();
  const [spent, pending, runs] = await Promise.all([
    spendTodayMicro(ws.sql, ws.id, config.workspace.timezone, now),
    countPendingApprovals(ws.sql, ws.id),
    ws.sql<{ queued: number; running: number; waiting: number; failed: number }[]>`
      select count(*) filter (where status = 'queued')::int as queued,
             count(*) filter (where status = 'running')::int as running,
             count(*) filter (where status = 'waiting_approval')::int as waiting,
             count(*) filter (where status = 'failed' and finished_at > ${now}::timestamptz - interval '24 hours')::int as failed
        from agent_runs where workspace_id = ${ws.id}`,
  ]);
  const r = runs[0] ?? { queued: 0, running: 0, waiting: 0, failed: 0 };
  return {
    workspace: { id: ws.id, name: config.workspace.name, timezone: config.workspace.timezone, mode: config.mode, preset: config.workspace.preset },
    modules: {
      on: info.modules.map((m) => m.manifest.id),
      problems: (info.problems ?? []).filter((p) => p.severity === "error").map((p) => p.message),
    },
    providers: (info.diagnostics ?? [])
      .filter((d) => d.status !== "none" && d.kind !== "trendSource")
      .map((d) => ({ kind: d.kind, choice: d.choice, status: d.status, detail: d.status === "loaded" || d.status === "builtin" ? undefined : d.detail })),
    budgets: { dailyUsd: config.budgets.dailyUsd, perRunUsd: config.budgets.perRunUsd, spentTodayUsd: Math.round(microToUsd(spent) * 100) / 100 },
    approvals: { pending },
    runs: { queued: r.queued, running: r.running, waitingApproval: r.waiting, failedToday: r.failed },
  };
}
