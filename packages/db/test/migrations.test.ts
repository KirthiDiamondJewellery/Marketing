import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectMigrations, coreMigrationsDir, migrationStatus, MigrationError, runMigrations } from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("collectMigrations", () => {
  it("sorts files globally by name across sources", () => {
    const files = collectMigrations([
      { dir: coreMigrationsDir(), source: "core" },
      { dir: join(fixtures, "mod-a"), source: "mod-a" },
      { dir: join(fixtures, "mod-b"), source: "mod-b" },
    ]);
    expect(files.map((f) => `${f.source}:${f.name}`)).toEqual([
      "core:20261011000000_schema_v1.sql",
      "core:20261011000100_queue_claim_workspace.sql",
      "mod-b:20261011500000_mod_b_first.sql",
      "mod-a:20261012000000_mod_a_table.sql",
      "mod-b:20261013000000_mod_b_after_a.sql",
      "core:20261020000000_knowledge_chunks.sql",
      "core:20261023000000_queue_priority.sql",
      "core:20261024000000_drop_workspace_is_demo.sql",
    ]);
  });

  it("rejects badly named and duplicate files", () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-mig-"));
    writeFileSync(join(dir, "add_stuff.sql"), "select 1;");
    expect(() => collectMigrations([{ dir, source: "x" }])).toThrow(MigrationError);
    const a = mkdtempSync(join(tmpdir(), "aos-mig-"));
    const b = mkdtempSync(join(tmpdir(), "aos-mig-"));
    writeFileSync(join(a, "20261020000000_same.sql"), "select 1;");
    writeFileSync(join(b, "20261020000000_same.sql"), "select 2;");
    expect(() => collectMigrations([{ dir: a, source: "a" }, { dir: b, source: "b" }])).toThrow(/share the name/);
  });
});

describe("runMigrations", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  const modA = mkdtempSync(join(tmpdir(), "aos-moda-"));
  cpSync(join(fixtures, "mod-a"), modA, { recursive: true });

  beforeAll(async () => {
    db = await createTestDatabase("attentionos_test_o1_migrations", { migrate: false });
  });
  afterAll(async () => db?.drop());

  it("applies core and module migrations in order, once", async () => {
    const moduleDirs = [{ dir: modA, source: "mod-a" }, { dir: join(fixtures, "mod-b"), source: "mod-b" }];
    const first = await runMigrations(db.sql, { moduleDirs });
    expect(first.applied).toHaveLength(8);
    const cols = await db.sql`select column_name from information_schema.columns where table_name = 'mod_a_items' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(["id", "label", "note"]);
    const second = await runMigrations(db.sql, { moduleDirs });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(8);
  });

  it("refuses to run when an applied file changed", async () => {
    writeFileSync(join(modA, "20261012000000_mod_a_table.sql"), "create table mod_a_items (id uuid primary key);\n-- edited\n");
    const moduleDirs = [{ dir: modA, source: "mod-a" }, { dir: join(fixtures, "mod-b"), source: "mod-b" }];
    await expect(runMigrations(db.sql, { moduleDirs })).rejects.toThrow(/changed after they ran: 20261012000000_mod_a_table.sql/);
    const status = await migrationStatus(db.sql, collectMigrations([{ dir: modA, source: "mod-a" }]));
    expect(status.changed).toHaveLength(1);
  });

  it("rolls back a failing file and keeps earlier ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-bad-"));
    writeFileSync(join(dir, "20261020000000_good.sql"), "create table good_one (id int);");
    writeFileSync(join(dir, "20261021000000_bad.sql"), "create table bad_one (id int); select * from does_not_exist;");
    await expect(runMigrations(db.sql, { moduleDirs: [{ dir, source: "bad" }] })).rejects.toThrow(/20261021000000_bad.sql \(bad\) failed/);
    const tables = await db.sql`select table_name from information_schema.tables where table_name in ('good_one', 'bad_one')`;
    expect(tables.map((t) => t.table_name)).toEqual(["good_one"]);
  });
});
