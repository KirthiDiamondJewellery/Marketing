import postgres from "postgres";
import { createSql, type Sql } from "@attentionos/core";
import { runMigrations, type MigrationSource } from "./migrations.ts";

/**
 * Test helpers shared by every integration suite.
 *
 * ATTENTIONOS_TEST_DATABASE_URL is a SERVER url: harnesses create (and drop) their own `attentionos_test_*`
 * databases on it and never touch the database named in the URL. Default: the dev Postgres from `pnpm db:start`.
 */
export const DEFAULT_TEST_SERVER_URL = "postgresql://postgres:postgres@127.0.0.1:55433/postgres";
export const TEST_SERVER_URL = process.env.ATTENTIONOS_TEST_DATABASE_URL || DEFAULT_TEST_SERVER_URL;

export function databaseUrl(name: string, serverUrl = TEST_SERVER_URL): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The server URL without its password, for messages. */
function displayUrl(serverUrl = TEST_SERVER_URL): string {
  const url = new URL(serverUrl);
  if (url.password) url.password = "***";
  return url.toString();
}

let probe: Promise<string | null> | undefined;

/** Why the test server can't be used (null when it can). Probed once per test file. */
export function testDatabaseProblem(): Promise<string | null> {
  probe ??= (async () => {
    const sql = postgres(TEST_SERVER_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
    try {
      await sql`select 1`;
      return null;
    } catch (err) {
      return (err as Error).message || String(err);
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  })();
  return probe;
}

/**
 * True when the test Postgres is reachable. Otherwise prints why and returns false so DB suites can
 * `describe.skipIf(!hasDb)` visibly; under CI (`process.env.CI` set) it throws instead, so a missing database fails.
 */
export async function hasTestDatabase(): Promise<boolean> {
  const problem = await testDatabaseProblem();
  if (!problem) return true;
  const msg = `no test Postgres at ${displayUrl()} (${problem}). Start one with \`pnpm db:start\` or set ATTENTIONOS_TEST_DATABASE_URL.`;
  if (process.env.CI) throw new Error(`CI needs a test database: ${msg}`);
  console.warn(`[skip] database tests skipped: ${msg}`);
  return false;
}

/** Suffix for suite names that skip without a database, e.g. `describe.skipIf(!hasDb)(\`flow${NEEDS_DB}\`, ...)`. */
export const NEEDS_DB = " (needs Postgres)";

export async function createTestDatabase(
  name: string,
  opts: { migrate?: boolean; moduleDirs?: MigrationSource[] } = {},
): Promise<{ sql: Sql; url: string; drop(): Promise<void> }> {
  if (!/^attentionos_test_[a-z0-9_]+$/.test(name)) throw new Error("test database names must start with attentionos_test_");
  const admin = createSql(databaseUrl("template1"), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}" template template0`);
  } finally {
    await admin.end();
  }
  const url = databaseUrl(name);
  const sql = createSql(url, { max: 4 });
  if (opts.migrate !== false) await runMigrations(sql, { moduleDirs: opts.moduleDirs });
  return {
    sql,
    url,
    async drop() {
      await sql.end();
      const a = createSql(databaseUrl("template1"), { max: 1 });
      try {
        await a.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}
