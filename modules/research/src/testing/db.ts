import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSql, loadBrandKit, parseConfig, silentLogger,
  type AttentionOSConfigInput, type BrandKit, type ProviderRegistry, type Sql, type WorkspaceContext,
} from "@attentionos/core";
import { databaseUrl, hasTestDatabase, NEEDS_DB, TEST_SERVER_URL } from "@attentionos/db/testing";

export { hasTestDatabase, NEEDS_DB, TEST_SERVER_URL };

/**
 * Test harness shared by the research, strategy and learn test suites (import from
 * `@attentionos/module-research/testing`). Uses its own database (`attentionos_test_research`) on the test server
 * (ATTENTIONOS_TEST_DATABASE_URL, a server URL; the database it names is never touched), applies schema v1 plus these modules'
 * migrations once per schema change (guarded by an advisory lock so parallel test files don't race), and
 * isolates every test file in its own workspace row.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

export const TEST_DATABASE_NAME = "attentionos_test_research";
export const TEST_DATABASE_URL = databaseUrl(TEST_DATABASE_NAME);

/** The fictional demo Brand Kit used by these tests. */
export const DEMO_BRAND_DIR = resolve(HERE, "../../test/fixtures/brand");

function migrationFiles(): string[] {
  const dirs = [join(REPO, "packages/db/migrations"), ...["research", "strategy", "learn"].map((m) => join(REPO, "modules", m, "migrations"))];
  const files: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".sql")) files.push(join(d, f));
  }
  // Sorted by file name (timestamp prefix) across all folders, like the real migration runner.
  return files.sort((a, b) => a.split("/").pop()!.localeCompare(b.split("/").pop()!));
}

async function ensureDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^attentionos_test_[a-z0-9_]+$/.test(name)) throw new Error(`refusing to use ${name}: test databases must be named attentionos_test_*`);
  const probe = createSql(url, { max: 1 });
  try {
    await probe`select 1`;
    return;
  } catch (err) {
    if (!/does not exist/.test((err as Error).message)) throw err;
  } finally {
    await probe.end({ timeout: 1 });
  }
  const admin = new URL(url);
  admin.pathname = "/template1";
  const sql = createSql(admin.toString(), { max: 1 });
  try {
    await sql.unsafe(`create database "${name.replace(/"/g, "")}" template template0`);
  } catch (err) {
    // Parallel test files may race to create it.
    if (!/already exists|pg_database_datname_index/.test((err as Error).message)) throw err;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

let ready: Promise<Sql> | undefined;

/** Connects to the test database, (re)applying migrations when they changed. */
export function testSql(): Promise<Sql> {
  ready ??= (async () => {
    await ensureDatabase(TEST_DATABASE_URL);
    const sql = createSql(TEST_DATABASE_URL, { max: 4 });
    const files = migrationFiles();
    const hash = createHash("sha256");
    for (const f of files) hash.update(f.split("/").pop()!).update(readFileSync(f));
    const digest = hash.digest("hex");
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(4207110)`;
      await tx.unsafe("create table if not exists public._aos_test_meta (id int primary key, hash text not null)");
      const [row] = await tx`select hash from public._aos_test_meta where id = 1`;
      if (row?.hash === digest) return;
      await tx.unsafe("drop schema public cascade; create schema public;");
      for (const f of files) await tx.unsafe(readFileSync(f, "utf8"));
      await tx.unsafe("create table public._aos_test_meta (id int primary key, hash text not null)");
      await tx`insert into public._aos_test_meta (id, hash) values (1, ${digest})`;
    });
    return sql;
  })();
  return ready;
}

export type TestWorkspaceOptions = {
  /** Fixed workspace id (re-created on every run) for tests whose seeded plans must be stable. */
  id?: string;
  config?: AttentionOSConfigInput;
  brandDir?: string;
  providers?: Partial<ProviderRegistry>;
  now?: () => Date;
  secrets?: Record<string, string>;
  root?: string;
};

/** A fresh workspace row plus a WorkspaceContext pointing at it. */
export async function createTestWorkspace(opts: TestWorkspaceOptions = {}): Promise<WorkspaceContext & { setNow(d: Date): void }> {
  const sql = await testSql();
  const id = opts.id ?? randomUUID();
  const config = parseConfig(opts.config ?? {});
  if (opts.id) await sql`delete from workspaces where id = ${id}`;
  await sql`insert into workspaces (id, name, slug, timezone) values (${id}, ${"Test workspace"}, ${`test-${id}`}, ${config.workspace.timezone})`;
  const brandDir = opts.brandDir ?? DEMO_BRAND_DIR;
  let brand: BrandKit | undefined;
  let clock = opts.now ?? (() => new Date());
  const root = opts.root ?? dirname(brandDir);
  return {
    id,
    paths: { root, brand: brandDir, config: join(root, "config/attentionos.config.ts"), media: join(root, "media"), lessons: join(brandDir, "lessons.md"), state: join(root, ".attentionos") },
    config,
    brand: () => (brand ??= loadBrandKit(brandDir)),
    reloadBrand: () => (brand = loadBrandKit(brandDir)),
    sql,
    providers: { trendSources: {}, ...opts.providers },
    log: silentLogger,
    now: () => clock(),
    secret: (k) => opts.secrets?.[k],
    setNow(d: Date) {
      clock = () => d;
    },
  };
}
