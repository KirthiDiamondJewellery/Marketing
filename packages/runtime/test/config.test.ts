import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecrets, findWorkspaceRoot, loadConfigFile, readDotenv, WorkspaceError, workspacePaths } from "../src/index.ts";
import { CONFIG_TS, makeWorkspace } from "./helpers.ts";

describe("workspace config", () => {
  it("finds the workspace root from a nested folder", () => {
    const root = makeWorkspace({ "config/attentionos.config.ts": CONFIG_TS });
    const nested = join(root, "media", "raw", "day-1");
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(root);
    expect(workspacePaths(root).lessons).toBe(join(root, "brand", "lessons.md"));
    expect(findWorkspaceRoot("/")).toBeNull();
  });

  it("loads a TypeScript config without node_modules in the workspace", async () => {
    const root = makeWorkspace({ "config/attentionos.config.ts": CONFIG_TS });
    const config = await loadConfigFile(join(root, "config/attentionos.config.ts"));
    expect(config.workspace).toMatchObject({ name: "Examplebrand Studio", preset: "agency-founder", timezone: "America/Chicago" });
    expect(config.providers.notifier).toBe("console");
    expect(config.budgets.dailyUsd).toBe(5);
  });

  it("explains invalid values in plain language", async () => {
    const root = makeWorkspace({
      "config/attentionos.config.ts": `import { defineConfig } from "attentionos/config";\nexport default defineConfig({ budgets: { dailyUsd: -1 }, mode: "turbo" } as any);\n`,
    });
    const err = await loadConfigFile(join(root, "config/attentionos.config.ts")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).message).toMatch(/budgets\.dailyUsd/);
    expect((err as WorkspaceError).message).toMatch(/mode/);
  });

  it("reports syntax errors without a stack trace", async () => {
    const root = makeWorkspace({ "config/attentionos.config.ts": `export default {{ broken` });
    await expect(loadConfigFile(join(root, "config/attentionos.config.ts"))).rejects.toThrow(/Could not read config/);
  });

  it("reads .env with the real environment taking precedence", () => {
    const root = makeWorkspace({ ".env": "DATABASE_URL=postgres://from-file\nEMPTY=\nTELEGRAM_BOT_TOKEN='abc'\n" });
    const secret = createSecrets(readDotenv(root), { DATABASE_URL: "postgres://from-env" });
    expect(secret("DATABASE_URL")).toBe("postgres://from-env");
    expect(secret("TELEGRAM_BOT_TOKEN")).toBe("abc");
    expect(secret("EMPTY")).toBeUndefined();
    expect(secret("MISSING")).toBeUndefined();
  });
});
