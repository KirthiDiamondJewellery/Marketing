import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, unknown>>;
export type TransactionSql = postgres.TransactionSql<Record<string, unknown>>;

/**
 * Postgres client for the engine (Supabase Postgres or any Postgres 15+).
 * The engine connects with the workspace's DATABASE_URL; RLS policies protect multi-user access (Studio).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSql(url: string, opts: { max?: number; debug?: boolean } = {}): Sql {
  // The MCP server of one agent run (ATTENTIONOS_RUN_ID) tags its connections, so runs it queues are linked to that
  // run and inherit its queue priority (see packages/db/migrations/20261023000000_queue_priority.sql).
  const runId = process.env.ATTENTIONOS_RUN_ID?.trim();
  return postgres(url, {
    ...(runId && UUID.test(runId) ? { connection: { "attentionos.run_id": runId } } : {}),
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false, // works through Supabase's transaction pooler
    transform: { undefined: null },
    onnotice: () => {},
    debug: opts.debug ? (_conn, query) => process.stderr.write(`[sql] ${query}\n`) : undefined,
  }) as Sql;
}

/** A jsonb query parameter. postgres.js types `sql.json` narrowly; callers pass plain JSON values. */
export function jsonb(sql: Sql | TransactionSql, value: unknown) {
  return sql.json(value as Parameters<Sql["json"]>[0]);
}

/** Drops null/undefined fields so MCP tool output stays compact (token-cheap). */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = compact(v);
    }
    return out as T;
  }
  return value;
}

/** Short human refs shared by every module: approvals "ap-7", edit jobs "rf-12". One counter per prefix. */
export type RefPrefix = "ap" | "rf";

export async function nextRef(sql: Sql, workspaceId: string, prefix: RefPrefix): Promise<string> {
  const [row] = await sql<{ n: string }[]>`select aos_next_counter(${workspaceId}, ${prefix}) as n`;
  return `${prefix}-${row!.n}`;
}
