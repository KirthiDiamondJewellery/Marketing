import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "@attentionos/db/testing";
import { loadWorkspace, WorkspaceError } from "../src/index.ts";
import { BRAND_YAML, CONFIG_TS, makeWorkspace } from "./helpers.ts";

describe("loadWorkspace", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    db = await createTestDatabase("attentionos_test_o1_runtime");
  });
  afterAll(async () => db?.drop());

  it("loads config, env, database row, agents and a lazy Brand Kit", async () => {
    const root = makeWorkspace({
      "config/attentionos.config.ts": CONFIG_TS,
      ".env": `DATABASE_URL=${db.url}\nANTHROPIC_API_KEY=sk-test\n`,
      "brand/brand.yaml": BRAND_YAML,
    });
    const ws = await loadWorkspace(`${root}/brand`, { env: {}, search: { workspaceRoot: root, engineRoot: null } });
    try {
      expect(ws.paths.root).toBe(root);
      expect(ws.slug).toBe("examplebrand-studio");
      expect(ws.secret("ANTHROPIC_API_KEY")).toBe("sk-test");
      expect(ws.brand().brand.name).toBe("Examplebrand Studio");
      const agents = await ws.sql`select key from agents where workspace_id = ${ws.id}`;
      expect(agents).toHaveLength(7);
      expect(ws.diagnostics.find((d) => d.kind === "notifier")?.status).toBe("not_installed");
      const again = await loadWorkspace(root, { env: {}, providers: false });
      expect(again.id).toBe(ws.id);
      await again.close();
    } finally {
      await ws.close();
    }
  });

  it("explains a missing DATABASE_URL and a missing workspace", async () => {
    const root = makeWorkspace({ "config/attentionos.config.ts": CONFIG_TS });
    await expect(loadWorkspace(root, { env: {} })).rejects.toMatchObject({ code: "env" });
    await expect(loadWorkspace("/", { env: {} })).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("tells the user to run db push when tables are missing", async () => {
    const empty = await createTestDatabase("attentionos_test_o1_runtime_empty", { migrate: false });
    try {
      const root = makeWorkspace({ "config/attentionos.config.ts": CONFIG_TS });
      await expect(loadWorkspace(root, { env: {}, databaseUrl: empty.url })).rejects.toThrow(/isn't set up yet/);
    } finally {
      await empty.drop();
    }
  });
});
