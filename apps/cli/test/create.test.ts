import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfigFile } from "@attentionos/runtime";
import { createWorkspace, nameFromDir } from "../src/commands/create.ts";
import { setEnvValue } from "../src/commands/doctor.ts";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const base = { templateDir: join(fixtures, "template"), presetsDir: join(fixtures, "presets") };

describe("createWorkspace", () => {
  it("copies the template, overlays the preset and fills placeholders", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "aos-create-")), "examplebrand studio");
    const ws = createWorkspace({ ...base, dir, preset: "coach-consultant", name: 'Examplebrand "QF" Studio', timezone: "America/Chicago" });
    expect(ws).toMatchObject({ name: 'Examplebrand "QF" Studio', slug: "examplebrand-qf-studio", preset: "coach-consultant", timezone: "America/Chicago", envCreated: true });
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);

    const config = await loadConfigFile(join(dir, "config", "attentionos.config.ts"));
    expect(config.workspace).toEqual({ id: ws.id, name: 'Examplebrand "QF" Studio', preset: "coach-consultant", timezone: "America/Chicago" });
    expect(config.northStar.metric).toBe("booked_calls_per_week");
    const brand = readFileSync(join(dir, "brand", "brand.yaml"), "utf8");
    expect(brand).toContain('name: "Examplebrand \\"QF\\" Studio"');
    expect(brand).toContain("tofu: 45");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe('# Examplebrand "QF" Studio\n');
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("examplebrand-qf-studio");
    expect(readFileSync(join(dir, "brand", "pillars.md"), "utf8")).toBe("# Pillars (fixture)\n");
    expect(existsSync(join(dir, "brand", "knowledge", "preset-cadence.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "_gitignore"))).toBe(false);
    expect(existsSync(join(dir, "TEMPLATE.md"))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    for (const d of ["media/raw", "media/renders", "media/assets", ".attentionos"]) expect(existsSync(join(dir, d))).toBe(true);
  });

  it("uses the default preset file map when a preset has no preset.json", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "aos-create-")), "agency");
    createWorkspace({ ...base, dir, preset: "agency-founder" });
    expect(readFileSync(join(dir, "brand", "pillars.md"), "utf8")).toBe("# Agency pillars (fixture)\n");
  });

  it("refuses a non-empty folder and unknown presets", () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-create-"));
    writeFileSync(join(dir, "keep.txt"), "x");
    expect(() => createWorkspace({ ...base, dir, preset: "coach-consultant" })).toThrow(/isn't empty/);
    const empty = join(dir, "new");
    mkdirSync(empty);
    expect(() => createWorkspace({ ...base, dir: empty, preset: "dentist" })).toThrow(expect.objectContaining({ message: 'There is no "dentist" preset.', fix: "Choose one of: agency-founder, coach-consultant." }));
  });

  it("derives a readable name from the folder", () => {
    expect(nameFromDir("examplebrand-studio")).toBe("Examplebrand Studio");
    expect(nameFromDir("/tmp/my_brand")).toBe("My Brand");
  });
});

describe("setEnvValue", () => {
  it("replaces an empty line or appends", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aos-env-")), ".env");
    writeFileSync(path, "DATABASE_URL=postgres://x\nTELEGRAM_CHAT_ID=\nOTHER=1");
    setEnvValue(path, "TELEGRAM_CHAT_ID", "12345");
    setEnvValue(path, "NEW_KEY", "v");
    expect(readFileSync(path, "utf8")).toBe("DATABASE_URL=postgres://x\nTELEGRAM_CHAT_ID=12345\nOTHER=1\nNEW_KEY=v\n");
  });
});
