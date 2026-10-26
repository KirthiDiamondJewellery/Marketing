import { microToUsd, type LlmJob, type WorkspaceContext } from "@attentionos/core";
import { spendTodayMicro } from "@attentionos/db";

export type BudgetDecision =
  | { ok: true; capUsd: number; spentTodayUsd: number; dailyUsd: number }
  | { ok: false; reason: string; fix: string; spentTodayUsd: number; dailyUsd: number };

/** Smallest budget worth starting a run with; below it the run would stop almost immediately. */
export const MIN_RUN_USD = 0.05;

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Pure budget rule: refuse when today's spend leaves less than MIN_RUN_USD; otherwise cap the run at the smallest of
 * the per-run budget, the job's own budget and what is left today.
 */
export function evaluateBudget(i: { spentTodayMicro: number; dailyUsd: number; perRunUsd: number; jobBudgetUsd?: number }): BudgetDecision {
  const spent = microToUsd(i.spentTodayMicro);
  const remaining = i.dailyUsd - spent;
  if (remaining < MIN_RUN_USD) {
    return {
      ok: false,
      reason: `Today's AI budget is used up (${usd(spent)} of ${usd(i.dailyUsd)}).`,
      fix: "Raise budgets.dailyUsd in config/attentionos.config.ts, or wait until tomorrow.",
      spentTodayUsd: spent,
      dailyUsd: i.dailyUsd,
    };
  }
  const cap = Math.min(i.perRunUsd, i.jobBudgetUsd ?? Number.POSITIVE_INFINITY, remaining);
  return { ok: true, capUsd: Math.round(cap * 100) / 100, spentTodayUsd: spent, dailyUsd: i.dailyUsd };
}

export async function checkBudget(ws: WorkspaceContext, job: Pick<LlmJob, "budgetUsd">): Promise<BudgetDecision> {
  const spent = await spendTodayMicro(ws.sql, ws.id, ws.config.workspace.timezone, ws.now(), "llm");
  return evaluateBudget({ spentTodayMicro: spent, dailyUsd: ws.config.budgets.dailyUsd, perRunUsd: ws.config.budgets.perRunUsd, jobBudgetUsd: job.budgetUsd });
}
