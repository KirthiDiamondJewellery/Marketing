import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrandKit, parseConfig, silentLogger, type AttentionOSConfigInput, type BrandKit, type Sql, type WorkspaceContext } from "@attentionos/core";
import { createTestDatabase } from "@attentionos/db/testing";
import { afterAll } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The blank workspace template's Brand Kit, plus the fixture files in test/fixtures/brand. */
export const TEMPLATE_BRAND = resolve(HERE, "../../../templates/workspace/brand");
export const FIXTURE_BRAND = resolve(HERE, "fixtures/brand");
export const FIXTURE_SEED = resolve(HERE, "fixtures/seed");

/** Temp workspace roots made by testWorkspace, removed after the importing test file. */
const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

let db: Promise<{ sql: Sql; drop(): Promise<void> }> | undefined;

/** One scratch database per test file run (`attentionos_test_knowledge`), with every core migration applied. */
export function testDb(name = "attentionos_test_knowledge") {
  // Module migrations too: seeds include module-owned tables (hooks.abstract, learn's history, ...).
  const modulesRoot = fileURLToPath(new URL("../../../modules", import.meta.url));
  const moduleDirs = readdirSync(modulesRoot)
    .map((m) => ({ dir: join(modulesRoot, m, "migrations"), source: m }))
    .filter((m) => existsSync(m.dir));
  db ??= createTestDatabase(name, { moduleDirs });
  return db;
}

/** A workspace row plus a context whose root is a temp copy of the template Brand Kit with the fixture files on top. */
export async function testWorkspace(opts: { config?: AttentionOSConfigInput; secrets?: Record<string, string>; now?: () => Date; dbName?: string } = {}): Promise<WorkspaceContext> {
  const { sql } = await testDb(opts.dbName);
  const id = randomUUID();
  await sql`insert into workspaces (id, name, slug) values (${id}, 'Test workspace', ${`test-${id}`})`;
  const root = mkdtempSync(join(tmpdir(), "aos-knowledge-"));
  roots.push(root);
  cpSync(TEMPLATE_BRAND, join(root, "brand"), { recursive: true });
  cpSync(FIXTURE_BRAND, join(root, "brand"), { recursive: true });
  const brandDir = join(root, "brand");
  let brand: BrandKit | undefined;
  return {
    id,
    paths: { root, brand: brandDir, config: join(root, "config/attentionos.config.ts"), media: join(root, "media"), lessons: join(brandDir, "lessons.md"), state: join(root, ".attentionos") },
    config: parseConfig(opts.config ?? {}),
    brand: () => (brand ??= loadBrandKit(brandDir)),
    reloadBrand: () => (brand = loadBrandKit(brandDir)),
    sql,
    providers: { trendSources: {} },
    log: silentLogger,
    now: opts.now ?? (() => new Date()),
    secret: (k) => opts.secrets?.[k],
  };
}
