import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrandFileError,
  normalizeBrandFile,
  patchYaml,
  readLanes,
  readSection,
  resolveBrandFile,
  setLanes,
  upsertSection,
  validateBrandFile,
  writeBrandFile,
} from "../src/lib/brand-files.ts";

const TEMPLATE = join(import.meta.dirname, "..", "..", "..", "templates", "workspace", "brand");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aos-onb-"));
  mkdirSync(join(root, "brand"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("which files may be written", () => {
  it("accepts top-level Brand Kit files with or without brand/", () => {
    expect(normalizeBrandFile("brand/voice.md")).toBe("voice.md");
    expect(normalizeBrandFile("proof-inventory.yaml")).toBe("proof-inventory.yaml");
    expect(resolveBrandFile(root, "brand/icp.md")).toBe(join(root, "brand", "icp.md"));
  });

  it("refuses anything outside brand/ or not in the kit", () => {
    for (const bad of ["../.env", "brand/../.env", "config/attentionos.config.ts", "brand/knowledge/x.md", "/etc/passwd", "brand/notes.md", ""]) {
      expect(normalizeBrandFile(bad)).toBeNull();
      expect(() => resolveBrandFile(root, bad)).toThrow(BrandFileError);
    }
  });
});

describe("validation against the Brand Kit schemas", () => {
  it("accepts every starter file in the workspace template", () => {
    for (const f of ["brand.yaml", "competitors.yaml", "sources.yaml", "proof-inventory.yaml", "pillars.md", "voice.md", "icp.md"]) {
      const text = readFileSync(join(TEMPLATE, f), "utf8").replace("{{WORKSPACE_NAME}}", "Examplebrand Studio").replace("{{TIMEZONE}}", "America/New_York");
      expect(() => validateBrandFile(f, text)).not.toThrow();
    }
  });

  it("rejects a brand.yaml that breaks the schema", () => {
    expect(() => validateBrandFile("brand.yaml", "name: Examplebrand Studio\nfunnelMix: { tofu: 90, mofu: 30, bofu: 20 }\n")).toThrow(/funnel mix must sum to 100/);
    expect(() => validateBrandFile("brand.yaml", "name: [unclosed\n")).toThrow(/isn't valid YAML/);
  });

  it("requires a source for every number in the proof inventory", () => {
    const ok = "items:\n  - id: win-1\n    kind: client_win\n    title: Faster launch\n    summary: Shipped two weeks early.\n    numbers:\n      - { value: '2 weeks', label: early, source: 'owner, onboarding interview' }\n";
    expect(() => validateBrandFile("proof-inventory.yaml", ok)).not.toThrow();
    expect(() => validateBrandFile("proof-inventory.yaml", ok.replace("'owner, onboarding interview'", "'  '"))).toThrow(/without a source/);
    expect(() => validateBrandFile("proof-inventory.yaml", ok.replace(", source: 'owner, onboarding interview'", ""))).toThrow(/proof-inventory.yaml/);
    expect(() => validateBrandFile("proof-inventory.yaml", `${ok}${ok.replace("items:\n", "")}`)).toThrow(/used twice/);
  });

  it("checks competitors, sources and pillar lanes", () => {
    expect(() => validateBrandFile("competitors.yaml", "creators:\n  - { handle: '@a', platform: myspace }\n")).toThrow();
    expect(() => validateBrandFile("sources.yaml", "sources:\n  - { id: a, kind: rss, target: x }\n  - { id: a, kind: rss, target: y }\n")).toThrow(/used twice/);
    expect(() => validateBrandFile("pillars.md", "# no front matter\n")).toThrow(/front matter/);
    expect(() => validateBrandFile("pillars.md", "---\nlanes: []\n---\n# x\n")).toThrow(/at least one lane/);
    expect(() => validateBrandFile("pillars.md", "---\nlanes:\n  - { id: a, name: A, weeklyQuota: 2, funnelStage: tofu }\n---\nbody\n")).not.toThrow();
  });

  it("refuses empty files", () => {
    expect(() => validateBrandFile("voice.md", "   \n")).toThrow(/empty/);
  });
});

describe("writing", () => {
  it("writes atomically and reports whether anything changed", () => {
    const first = writeBrandFile(root, "brand/voice.md", "# How we sound\r\n\r\nCalm.\r\n");
    expect(first.changed).toBe(true);
    expect(readFileSync(join(root, "brand", "voice.md"), "utf8")).toBe("# How we sound\n\nCalm.\n");
    expect(writeBrandFile(root, "voice.md", "# How we sound\n\nCalm.\n").changed).toBe(false);
  });

  it("writes nothing when validation fails", () => {
    writeFileSync(join(root, "brand", "brand.yaml"), "name: Examplebrand Studio\n");
    expect(() => writeBrandFile(root, "brand.yaml", "name: ''\n")).toThrow(BrandFileError);
    expect(readFileSync(join(root, "brand", "brand.yaml"), "utf8")).toBe("name: Examplebrand Studio\n");
    expect(existsSync(join(root, ".env"))).toBe(false);
  });
});

describe("comment-preserving edits", () => {
  it("patches YAML values and keeps the owner's notes", () => {
    const src = "# Notes for you\nname: \"Old\"\n# TODO: one line\noneLiner: \"\"\nhandles: {}\n";
    const out = patchYaml(src, { name: "Examplebrand Studio", "handles.instagram": "@examplebrand", "cta.siteUrl": "https://examplebrand.example" });
    expect(out).toContain("# Notes for you");
    expect(out).toContain("# TODO: one line");
    expect(out).toContain("name: Examplebrand Studio");
    expect(out).toMatch(/instagram: "?@examplebrand"?/);
    expect(validateBrandFile("brand.yaml", out)).toBeTruthy();
  });

  it("replaces pillar lanes but keeps the body", () => {
    const md = readFileSync(join(TEMPLATE, "pillars.md"), "utf8");
    const lanes = readLanes(md);
    expect(lanes.length).toBeGreaterThan(2);
    const next = setLanes(md, lanes.map((l) => ({ ...l, weeklyQuota: 3 })));
    expect(readLanes(next).every((l) => l.weeklyQuota === 3)).toBe(true);
    expect(next).toContain("## Story structures");
    expect(() => validateBrandFile("pillars.md", next)).not.toThrow();
  });

  it("upserts markdown sections in place or at the end", () => {
    const md = "# Title\n\n## Captions\n\n<!-- TODO -->\n\n### Detail\nkeep\n\n## Look\n\nold\n";
    const a = upsertSection(md, "captions", "Two lines at most.");
    expect(a).toContain("## Captions\n\nTwo lines at most.");
    expect(a).not.toContain("<!-- TODO -->");
    expect(a).not.toContain("### Detail");
    expect(a).toContain("## Look\n\nold");
    const b = upsertSection(a, "Formats we use", "- `raw-talking-head`");
    expect(b.trimEnd().endsWith("- `raw-talking-head`")).toBe(true);
    expect(readSection(b, "Look")).toBe("old");
    expect(readSection(md, "Captions")).toContain("### Detail");
  });
});
