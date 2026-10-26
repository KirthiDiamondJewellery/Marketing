import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@attentionos/core";
import { ensureWorkspace, insertOrder, loadSeed, resolveRelativeTime, seedAgents, seedShiftMs, slugify, zonedTime } from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

const seedDir = fileURLToPath(new URL("./fixtures/seed", import.meta.url));

describe("pure helpers", () => {
  it("slugifies names", () => {
    expect(slugify("Examplebrand Studio")).toBe("examplebrand-studio");
    expect(slugify("  Café & Co!! ")).toBe("cafe-co");
    expect(slugify("***")).toBe("workspace");
  });

  it("resolves relative times", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(resolveRelativeTime("@now", now)).toBe("2026-10-10T12:00:00.000Z");
    expect(resolveRelativeTime("@now-2d", now)).toBe("2026-10-08T12:00:00.000Z");
    expect(resolveRelativeTime("@now+90m", now)).toBe("2026-10-10T13:30:00.000Z");
    expect(resolveRelativeTime("now", now)).toBeNull();
    expect(zonedTime("2026-10-13T12:00:00", "America/Chicago").toISOString()).toBe("2026-10-13T17:00:00.000Z");
    expect(seedShiftMs({ today: "2026-10-13", timezone: "America/Chicago", links: [] }, new Date("2026-10-14T17:00:00Z"))).toBe(86_400_000);
  });

  it("orders tables by foreign keys and defers cycles", () => {
    const fks = new Map([
      ["content", [{ column: "keyword_id", target: "keywords" }, { column: "hook_id", target: "hooks" }]],
      ["keywords", [{ column: "content_id", target: "content" }]],
      ["posts", [{ column: "content_id", target: "content" }, { column: "variant_of", target: "posts" }]],
      ["hooks", []],
    ]);
    const { order, deferred } = insertOrder(["posts", "content", "keywords", "hooks"], fks);
    expect(order.indexOf("hooks")).toBeLessThan(order.indexOf("content"));
    expect(order.indexOf("content")).toBeLessThan(order.indexOf("posts"));
    expect(deferred.size).toBe(1);
    // A preferred order is followed where the foreign keys allow it.
    const pref = insertOrder(["posts", "content", "keywords", "hooks"], fks, ["keywords", "hooks", "content", "posts"]);
    expect(pref.order).toEqual(["hooks", "keywords", "content", "posts"]);
    expect([...pref.deferred]).toEqual(["keywords.content_id"]);
  });
});

describe("workspace bootstrap and seed loader", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    // Module migrations too: seeds may include module-owned tables (e.g. learn's follower history).
    const modulesRoot = fileURLToPath(new URL("../../../modules", import.meta.url));
    const moduleDirs = readdirSync(modulesRoot)
      .map((m) => ({ dir: join(modulesRoot, m, "migrations"), source: m }))
      .filter((m) => existsSync(m.dir));
    db = await createTestDatabase("attentionos_test_o1_seed", { moduleDirs });
  });
  afterAll(async () => db?.drop());

  it("ensures a workspace by slug or id", async () => {
    const a = await ensureWorkspace(db.sql, { name: "Examplebrand Studio", slug: "examplebrand-studio", timezone: "America/Chicago" });
    expect(a.created).toBe(true);
    const again = await ensureWorkspace(db.sql, { name: "Examplebrand Studio", slug: "examplebrand-studio", timezone: "America/Denver" });
    expect(again).toEqual({ id: a.id, created: false });
    const fixed = "4f0d0a52-8f36-4f53-9a3e-0d2f3c1b9a11";
    const b = await ensureWorkspace(db.sql, { id: fixed, name: "Examplebrand Studio", slug: "examplebrand-studio", timezone: "UTC" });
    expect(b.id).toBe(fixed);
    const [row] = await db.sql`select slug from workspaces where id = ${fixed}`;
    expect(row!.slug).toBe("examplebrand-studio-2");
  });

  it("seeds the seven agents and follows config", async () => {
    const { id } = await ensureWorkspace(db.sql, { name: "Agents", slug: "agents-test", timezone: "UTC" });
    await seedAgents(db.sql, id, parseConfig({ agents: { copywriter: { autonomy: "review_key", model: "opus" } } }));
    const rows = await db.sql<{ key: string; monogram: string; autonomy: string; model: string | null }[]>`
      select key, monogram, autonomy, model from agents where workspace_id = ${id} order by key`;
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.key === "copywriter")).toMatchObject({ monogram: "Cw", autonomy: "review_key", model: "opus" });
    expect(rows.find((r) => r.key === "chief_of_staff")?.monogram).toBe("Cs");
  });

  it("loads a seed with remapped ids, cycles, self references and loose references", async () => {
    const { id } = await ensureWorkspace(db.sql, { name: "Seed", slug: "seed-test", timezone: "UTC" });
    const now = new Date("2026-10-10T12:00:00Z");
    const result = await loadSeed(db.sql, id, seedDir, { now });
    expect(Object.fromEntries(result.tables.map((t) => [t.table, t.rows]))).toMatchObject({ content: 2, keywords: 1, posts: 2, hooks: 1 });

    const [content] = await db.sql`select * from content where workspace_id = ${id} and status = 'published'`;
    const [kw] = await db.sql`select * from keywords where workspace_id = ${id}`;
    const [hook] = await db.sql`select * from hooks where workspace_id = ${id}`;
    expect(content!.keyword_id).toBe(kw!.id);
    expect(kw!.content_id).toBe(content!.id);
    expect(content!.hook_id).toBe(hook!.id);
    expect(content!.source_refs).toEqual([{ type: "manual", id: "note-1" }]);
    expect((content!.published_at as Date).toISOString()).toBe("2026-10-07T12:00:00.000Z");

    const posts = await db.sql`select id, platform, variant_of from posts where workspace_id = ${id}`;
    const ig = posts.find((p) => p.platform === "instagram")!;
    expect(posts.find((p) => p.platform === "tiktok")!.variant_of).toBe(ig.id);

    const [metric] = await db.sql`select post_id from post_metrics where workspace_id = ${id}`;
    expect(metric!.post_id).toBe(ig.id);
    const [approval] = await db.sql`select subject_id from approvals where workspace_id = ${id}`;
    const [idea] = await db.sql`select id from content where workspace_id = ${id} and status = 'idea'`;
    expect(approval!.subject_id).toBe(idea!.id);

    // Loading the same seed twice into another workspace works because ids are fresh each time.
    const other = await ensureWorkspace(db.sql, { name: "Seed 2", slug: "seed-test-2", timezone: "UTC" });
    await expect(loadSeed(db.sql, other.id, seedDir, { now })).resolves.toBeDefined();
  });

});
