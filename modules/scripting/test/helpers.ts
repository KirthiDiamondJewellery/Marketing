import { resolve } from "node:path";
import { loadBrandKit, parseConfig, silentLogger, type Sql, type WorkspaceContext } from "@attentionos/core";
import { createTestDatabase } from "@attentionos/db/testing";

export { hasTestDatabase, NEEDS_DB } from "@attentionos/db/testing";

/** Test database helpers. Each test file gets its own database on the test server and never touches any other. */

export const TEST_DB = "attentionos_test_scripting";
export const BRAND_DIR = resolve(import.meta.dirname, "fixtures/brand");
export const NOW = new Date("2026-10-15T12:00:00Z");

/** (Re)creates this file's database with schema v1 and the scripting migrations. Files can run in parallel. */
export function testDb(db: string = TEST_DB): Promise<{ sql: Sql; drop(): Promise<void> }> {
  return createTestDatabase(db, { moduleDirs: [{ dir: resolve(import.meta.dirname, "../migrations"), source: "scripting" }] });
}

export async function makeWorkspace(sql: Sql, opts: { modules?: Record<string, unknown> } = {}): Promise<WorkspaceContext> {
  const slug = `examplebrand-${Math.random().toString(36).slice(2, 10)}`;
  const rows = await sql<{ id: string }[]>`insert into workspaces (name, slug) values ('Examplebrand Studio', ${slug}) returning id`;
  const id = rows[0]!.id;
  const kit = loadBrandKit(BRAND_DIR);
  const config = parseConfig({ platforms: ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x"], modules: opts.modules ?? {} });
  return {
    id,
    paths: { root: "/ws", brand: BRAND_DIR, config: "/ws/config/attentionos.config.ts", media: "/ws/media", lessons: "/ws/brand/lessons.md", state: "/ws/.attentionos" },
    config,
    brand: () => kit,
    reloadBrand: () => kit,
    sql,
    providers: { trendSources: {} },
    log: silentLogger,
    now: () => NOW,
    secret: () => undefined,
  };
}

export async function makeContent(ws: WorkspaceContext, over: { title?: string; cta_type?: string; source_refs?: unknown[]; angle?: string } = {}): Promise<string> {
  const rows = await ws.sql<{ id: string }[]>`
    insert into content (workspace_id, title, lane, funnel_stage, angle, cta_type, source_refs)
    values (${ws.id}, ${over.title ?? "Why remodel budgets break early"}, 'myth-bust', 'mofu', ${over.angle ?? "budget"}, ${over.cta_type ?? "comment_keyword"},
            ${ws.sql.json((over.source_refs ?? []) as never)})
    returning id`;
  return rows[0]!.id;
}

export async function makeHook(ws: WorkspaceContext, over: { text?: string; pattern?: string; origin?: "own" | "competitor" | "manual"; score?: number; abstract?: string | null } = {}): Promise<string> {
  const rows = await ws.sql<{ id: string }[]>`
    insert into hooks (workspace_id, text, pattern, origin, score, abstract)
    values (${ws.id}, ${over.text ?? "Your remodel budget breaks before demolition."}, ${over.pattern ?? "cost-of-mistake"}, ${over.origin ?? "own"}, ${over.score ?? 3.5}, ${over.abstract ?? null})
    returning id`;
  return rows[0]!.id;
}
