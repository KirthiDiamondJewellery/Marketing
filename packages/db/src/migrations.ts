import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { silentLogger, type Logger, type Sql } from "@attentionos/core";

const MIGRATIONS_REL = ["..", "migrations"].join("/");

/**
 * SQL migrations: `packages/db/migrations/*.sql` (schema v1 + engine additions) plus every enabled module's
 * `migrationsDir`. All files are sorted globally by filename (they start with a UTC timestamp), applied once each
 * inside a transaction, and tracked in `_aos_migrations`. An applied file whose checksum changed stops the run:
 * migrations are append-only.
 */

export type MigrationSource = { dir: string; source: string };

export type MigrationFile = {
  /** File name, e.g. `20261011000000_schema_v1.sql`. Unique across all sources. */
  name: string;
  path: string;
  /** "core" or the module id that owns it. */
  source: string;
  sql: string;
  checksum: string;
};

export type MigrationStatus = {
  applied: { name: string; appliedAt: Date }[];
  pending: MigrationFile[];
  /** Applied files whose content changed since they ran. */
  changed: { name: string; expected: string; actual: string }[];
  /** Applied in the database but not found on disk (e.g. a module was turned off). Informational. */
  unknown: string[];
};

export class MigrationError extends Error {
  constructor(message: string, public readonly fix?: string) {
    super(message);
    this.name = "MigrationError";
  }
}

const MIGRATION_NAME = /^\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/;

/** The engine's own migrations folder. The bundled CLI mirrors it under dist/assets, so the relative URL holds there too. */
export function coreMigrationsDir(): string {
  const candidates = [
    process.env.ATTENTIONOS_MIGRATIONS_DIR,
    // Non-literal on purpose: bundlers treat `new URL("<literal>", import.meta.url)` as an asset to inline.
    fileURLToPath(new URL(MIGRATIONS_REL, import.meta.url)),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new MigrationError("Could not find the engine's database migrations.", "Rebuild AttentionOS: ./aos update (or run from a full checkout of the repository).");
  return found;
}

export function checksum(sql: string): string {
  // Normalise line endings so a checkout on Windows doesn't look like an edit.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/** Reads every migration file from the given folders, sorted globally by file name. */
export function collectMigrations(sources: MigrationSource[]): MigrationFile[] {
  const byName = new Map<string, MigrationFile>();
  for (const { dir, source } of sources) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (!MIGRATION_NAME.test(file)) {
        throw new MigrationError(
          `Migration file "${file}" in ${source} has an invalid name.`,
          "Name migrations <14-digit UTC timestamp>_<snake_case>.sql, e.g. 20261015120000_add_hooks_index.sql.",
        );
      }
      const path = join(dir, file);
      const existing = byName.get(file);
      if (existing) {
        throw new MigrationError(`Two migrations share the name "${file}" (${existing.source} and ${source}).`, "Give one of them a unique suffix.");
      }
      const sql = readFileSync(path, "utf8");
      byName.set(file, { name: basename(file), path, source, sql, checksum: checksum(sql) });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function ensureTable(sql: Sql): Promise<void> {
  await sql`
    create table if not exists _aos_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )`;
}

export async function migrationStatus(sql: Sql, files: MigrationFile[]): Promise<MigrationStatus> {
  await ensureTable(sql);
  const rows = await sql<{ name: string; checksum: string; applied_at: Date }[]>`
    select name, checksum, applied_at from _aos_migrations order by name`;
  const applied = new Map(rows.map((r) => [r.name, r]));
  const onDisk = new Set(files.map((f) => f.name));
  const changed: MigrationStatus["changed"] = [];
  const pending: MigrationFile[] = [];
  for (const f of files) {
    const row = applied.get(f.name);
    if (!row) pending.push(f);
    else if (row.checksum !== f.checksum) changed.push({ name: f.name, expected: row.checksum, actual: f.checksum });
  }
  return {
    applied: rows.map((r) => ({ name: r.name, appliedAt: r.applied_at })),
    pending,
    changed,
    unknown: rows.filter((r) => !onDisk.has(r.name)).map((r) => r.name),
  };
}

export type RunMigrationsOptions = {
  /** Defaults to the engine's own folder. */
  coreDir?: string;
  /** Module-owned folders: `{ dir: def.migrationsDir, source: def.manifest.id }`. */
  moduleDirs?: MigrationSource[];
  dryRun?: boolean;
  log?: Logger;
};

export type RunMigrationsResult = { applied: string[]; alreadyApplied: number; pending: string[] };

/**
 * Applies pending migrations in order, each in its own transaction. A session-level advisory lock on a reserved
 * connection serialises concurrent runners (two `db push` at once, or a worker starting while the CLI migrates).
 */
export async function runMigrations(sql: Sql, opts: RunMigrationsOptions = {}): Promise<RunMigrationsResult> {
  const log = opts.log ?? silentLogger;
  const files = collectMigrations([{ dir: opts.coreDir ?? coreMigrationsDir(), source: "core" }, ...(opts.moduleDirs ?? [])]);
  const conn = await sql.reserve();
  try {
    await conn`select pg_advisory_lock(hashtext('attentionos:migrations'))`;
    const status = await migrationStatus(conn, files);
    if (status.changed.length) {
      const names = status.changed.map((c) => c.name).join(", ");
      throw new MigrationError(
        `These migrations were changed after they ran: ${names}.`,
        "Migrations are append-only. Restore the original file and put your change in a new migration.",
      );
    }
    if (opts.dryRun) return { applied: [], alreadyApplied: status.applied.length, pending: status.pending.map((p) => p.name) };
    const applied: string[] = [];
    for (const file of status.pending) {
      log.info("applying migration", { name: file.name, source: file.source });
      try {
        await conn`begin`;
        await conn.unsafe(file.sql);
        await conn`insert into _aos_migrations (name, checksum) values (${file.name}, ${file.checksum})`;
        await conn`commit`;
      } catch (err) {
        await conn`rollback`.catch(() => {});
        const reason = err instanceof Error ? err.message : String(err);
        const done = applied.length ? ` ${applied.length} earlier migration(s) from this run were applied.` : "";
        throw new MigrationError(`Migration ${file.name} (${file.source}) failed: ${reason}.${done}`, "Fix the SQL and run `attentionos db push` again.");
      }
      applied.push(file.name);
    }
    return { applied, alreadyApplied: status.applied.length, pending: [] };
  } finally {
    await conn`select pg_advisory_unlock(hashtext('attentionos:migrations'))`.catch(() => {});
    conn.release();
  }
}
