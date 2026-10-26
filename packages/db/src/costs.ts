import type { Sql } from "@attentionos/core";

export type CostCategory = "llm" | "scraping" | "publishing" | "images" | "asr" | "other";

/** Spend (micro-USD) in one category since local midnight in the workspace timezone. */
export async function spendTodayMicro(sql: Sql, workspaceId: string, timezone: string, now: Date, category: CostCategory = "llm"): Promise<number> {
  const [row] = await sql<{ total: string | null }[]>`
    select coalesce(sum(amount_micro), 0)::text as total
      from cost_ledger
     where workspace_id = ${workspaceId} and category = ${category}
       and ts >= (date_trunc('day', ${now}::timestamptz at time zone ${timezone}) at time zone ${timezone})
       and ts <= ${now}::timestamptz`;
  return Number(row?.total ?? 0);
}

/** Spend (micro-USD) in one category since the first day of the current month, workspace timezone. */
export async function spendThisMonthMicro(sql: Sql, workspaceId: string, timezone: string, now: Date, category: CostCategory): Promise<number> {
  const [row] = await sql<{ total: string | null }[]>`
    select coalesce(sum(amount_micro), 0)::text as total
      from cost_ledger
     where workspace_id = ${workspaceId} and category = ${category}
       and ts >= (date_trunc('month', ${now}::timestamptz at time zone ${timezone}) at time zone ${timezone})
       and ts <= ${now}::timestamptz`;
  return Number(row?.total ?? 0);
}

export async function recordCost(
  sql: Sql,
  c: { workspaceId: string; category: CostCategory; provider: string; amountMicro: number; runId?: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  if (!Number.isFinite(c.amountMicro) || c.amountMicro <= 0) return;
  await sql`
    insert into cost_ledger (workspace_id, category, provider, amount_micro, run_id, detail)
    values (${c.workspaceId}, ${c.category}, ${c.provider}, ${Math.round(c.amountMicro)}, ${c.runId ?? null}, ${c.detail ? sql.json(c.detail as never) : null})`;
}
