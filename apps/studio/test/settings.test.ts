import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyConfigEdits, editConfigSource, keyStatuses, setEnvKey, validateSetting, writeEnvKey } from "../src/server/settings.ts";

const CONFIG = `// AttentionOS workspace settings.
import { defineConfig } from "attentionos/config";

export default defineConfig({
  workspace: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Examplebrand Studio",
    // Used for schedules.
    timezone: "America/Chicago",
  },

  // "copilot" or "autopilot".
  mode: "copilot",

  modules: {
    research: { enabled: true, schedules: {}, settings: {} },
    editing: { enabled: false, schedules: {}, settings: {} },
    ops: {
      enabled: true,
      schedules: {
        // "ops.morning-brief": "0 8 * * 1-5",
      },
      settings: {
        demoMode: false, // nothing to mask
      },
    },
  },

  budgets: {
    perRunUsd: 2,
    dailyUsd: 5,
    scrapingMonthlyUsd: 29,
    imagesDailyUsd: 2,
  },

  acknowledgements: {
    scrapingTerms: false,
    trialReelsRisk: false,
  },
});
`;

function edit(src: string, path: string, value: string | number | boolean): string {
  const res = editConfigSource(src, path.split("."), value);
  if (!res.ok) throw new Error(res.reason);
  return res.source;
}

describe("config scalar edits", () => {
  it("replaces a literal and leaves every other line alone", () => {
    const out = edit(CONFIG, "budgets.dailyUsd", 7.5);
    expect(out).toContain("    dailyUsd: 7.5,");
    expect(out.replace("dailyUsd: 7.5", "dailyUsd: 5")).toBe(CONFIG);
  });

  it("edits strings, booleans and nested module toggles", () => {
    let out = edit(CONFIG, "mode", "autopilot");
    out = edit(out, "workspace.timezone", "Europe/London");
    out = edit(out, "modules.editing.enabled", true);
    out = edit(out, "acknowledgements.scrapingTerms", true);
    expect(out).toContain('mode: "autopilot",');
    expect(out).toContain('timezone: "Europe/London",');
    expect(out).toContain("editing: { enabled: true, schedules: {}, settings: {} },");
    expect(out).toContain("scrapingTerms: true,");
    expect(out).toContain("// Used for schedules.");
  });

  it("doesn't touch keys inside comments", () => {
    const out = edit(CONFIG, "modules.ops.settings.demoMode", true);
    expect(out).toContain("demoMode: true, // nothing to mask");
    expect(out).toContain('// "ops.morning-brief": "0 8 * * 1-5",');
  });

  it("inserts a missing key into the closest parent", () => {
    const a = edit(CONFIG, "acknowledgements.automatedDmRisk", true);
    expect(a).toContain("    trialReelsRisk: false,\n    automatedDmRisk: true,\n  },");
    const b = edit(CONFIG, "modules.publishing.enabled", true);
    expect(b).toContain("    publishing: { enabled: true },\n  },");
    const c = edit(CONFIG, "modules.ops.schedules.x", "0 9 * * *");
    expect(c).toContain('// "ops.morning-brief"');
    expect(c).toContain('x: "0 9 * * *",');
  });

  it("inserts into one-line objects", () => {
    const src = `export default defineConfig({ budgets: { dailyUsd: 5 } });`;
    expect(edit(src, "budgets.perRunUsd", 1)).toBe(`export default defineConfig({ budgets: { dailyUsd: 5, perRunUsd: 1 } });`);
  });

  it("refuses values set by code, spreads and duplicates", () => {
    const expr = CONFIG.replace("dailyUsd: 5,", "dailyUsd: base * 2,");
    expect(editConfigSource(expr, ["budgets", "dailyUsd"], 3)).toMatchObject({ ok: false, reason: expect.stringContaining("expression") });
    const spread = CONFIG.replace("budgets: {", "budgets: {\n    ...shared,");
    expect(editConfigSource(spread, ["budgets", "dailyUsd"], 3)).toMatchObject({ ok: false, reason: expect.stringContaining("built with code") });
    const dup = CONFIG.replace('mode: "copilot",', 'mode: "copilot",\n  mode: "autopilot",');
    expect(editConfigSource(dup, ["mode"], "copilot")).toMatchObject({ ok: false, reason: expect.stringContaining("more than once") });
    const variable = CONFIG.replace(/budgets: \{[^}]*\},/, "budgets: myBudgets,");
    expect(editConfigSource(variable, ["budgets", "dailyUsd"], 3)).toMatchObject({ ok: false });
    expect(editConfigSource("export const x = 1;", ["mode"], "copilot")).toMatchObject({ ok: false, reason: expect.stringContaining("defineConfig") });
    expect(editConfigSource(CONFIG, ["budgets"], 3)).toMatchObject({ ok: false, reason: expect.stringContaining("group") });
  });

  it("re-validates the edited file before replacing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "aos-studio-config-"));
    mkdirSync(join(root, "config"));
    const file = join(root, "config", "attentionos.config.ts");
    writeFileSync(file, CONFIG);
    const ok = await applyConfigEdits(root, [{ path: ["budgets", "dailyUsd"], value: 9 }, { path: ["mode"], value: "autopilot" }]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.budgets.dailyUsd).toBe(9);
    expect(readFileSync(file, "utf8")).toContain("dailyUsd: 9,");

    // The schema rejects a negative daily budget: the file must stay as it was.
    const before = readFileSync(file, "utf8");
    const bad = await applyConfigEdits(root, [{ path: ["budgets", "dailyUsd"], value: -1 }]);
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("budgets.dailyUsd") });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("validates what Studio may change", () => {
    expect(validateSetting("budgets.dailyUsd", "12.345")).toEqual({ ok: true, path: ["budgets", "dailyUsd"], value: 12.35 });
    expect(validateSetting("budgets.dailyUsd", 0)).toMatchObject({ ok: false });
    expect(validateSetting("workspace.timezone", "Mars/Olympus")).toMatchObject({ ok: false });
    expect(validateSetting("modules.editing.enabled", true)).toMatchObject({ ok: true });
    expect(validateSetting("providers.publisher", "blotato")).toMatchObject({ ok: false });
    expect(validateSetting("acknowledgements.anythingElse", true)).toMatchObject({ ok: false });
  });
});

describe(".env key writing", () => {
  const ENV = "# Secrets\n\n# Level 1\nDATABASE_URL=postgres://x\nAPIFY_TOKEN=\n# ANTHROPIC_API_KEY=old-comment\nexport ZERNIO_API_KEY=abc\n";

  it("replaces an empty placeholder in place and keeps comments", () => {
    const out = setEnvKey(ENV, "APIFY_TOKEN", "apify_api_123");
    expect(out).toBe(ENV.replace("APIFY_TOKEN=\n", "APIFY_TOKEN=apify_api_123\n"));
  });

  it("appends a new key and leaves commented lines alone", () => {
    const out = setEnvKey(ENV, "ANTHROPIC_API_KEY", "sk-ant-xyz");
    expect(out).toBe(`${ENV}ANTHROPIC_API_KEY=sk-ant-xyz\n`);
    expect(setEnvKey("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(setEnvKey("", "B", "2")).toBe("B=2\n");
  });

  it("replaces export lines, keeps CRLF and quotes awkward values", () => {
    expect(setEnvKey(ENV, "ZERNIO_API_KEY", "new")).toContain("\nZERNIO_API_KEY=new\n");
    expect(setEnvKey("A=1\r\nB=2\r\n", "B", "3")).toBe("A=1\r\nB=3\r\n");
    expect(setEnvKey("", "CRM_WEBHOOK_URL", "has space #hash")).toBe("CRM_WEBHOOK_URL='has space #hash'\n");
    expect(() => setEnvKey("", "A", "two\nlines")).toThrow();
    expect(() => setEnvKey("", "lower", "x")).toThrow();
  });

  it("writes only known keys and reports set or missing without values", () => {
    const root = mkdtempSync(join(tmpdir(), "aos-studio-env-"));
    writeFileSync(join(root, ".env"), ENV);
    writeEnvKey(root, "TELEGRAM_BOT_TOKEN", "123:abc");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(`${ENV}TELEGRAM_BOT_TOKEN=123:abc\n`);
    expect(() => writeEnvKey(root, "NODE_OPTIONS", "--inspect")).toThrow();
    expect(() => writeEnvKey(root, "DATABASE_URL", "postgres://y")).toThrow();
    const status = keyStatuses(root, { ANTHROPIC_API_KEY: "from-env" });
    const by = Object.fromEntries(status.map((s) => [s.name, s]));
    expect(by.TELEGRAM_BOT_TOKEN).toMatchObject({ set: true, source: "env-file" });
    expect(by.APIFY_TOKEN).toMatchObject({ set: false });
    expect(by.ANTHROPIC_API_KEY).toMatchObject({ set: true, source: "environment" });
    expect(JSON.stringify(status)).not.toContain("123:abc");
  });
});
