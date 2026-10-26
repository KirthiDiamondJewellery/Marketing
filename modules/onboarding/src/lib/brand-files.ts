import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  BRAND_FILES,
  brandSchema,
  competitorsSchema,
  pillarSchema,
  proofInventorySchema,
  sourcesSchema,
} from "@attentionos/core";
import { parse as parseYaml, parseDocument } from "yaml";
import type { z } from "zod";

/**
 * Brand Kit file access for onboarding: one place that decides which files may be written, validates them against
 * the core Brand Kit schemas before anything touches disk, and writes atomically. Used by the MCP tool
 * `onboarding_save_brand_file` (agents) and by Studio's setup wizard (owner approvals).
 */

export const WRITABLE_BRAND_FILES: readonly string[] = Object.values(BRAND_FILES);
export const MAX_BRAND_FILE_BYTES = 256 * 1024;

export class BrandFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandFileError";
  }
}

/** "brand/voice.md" or "voice.md" → "voice.md"; null when it isn't a top-level Brand Kit file. */
export function normalizeBrandFile(file: string): string | null {
  if (typeof file !== "string") return null;
  const f = file.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^brand\//, "");
  if (!f || f.includes("/") || f.includes("..")) return null;
  return WRITABLE_BRAND_FILES.includes(f) ? f : null;
}

/** Absolute path of a Brand Kit file inside `<root>/brand/`, refusing anything else. */
export function resolveBrandFile(root: string, file: string): string {
  const name = normalizeBrandFile(file);
  if (!name) throw new BrandFileError(`Only these Brand Kit files can be written: ${WRITABLE_BRAND_FILES.map((f) => `brand/${f}`).join(", ")}.`);
  const dir = resolve(root, "brand");
  const abs = resolve(dir, name);
  const rel = relative(dir, abs);
  if (!rel || rel.startsWith("..") || rel.includes(sep)) throw new BrandFileError("That path is outside brand/.");
  return abs;
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(top level)"}: ${i.message}`).join("; ");

/** Splits `---\n<yaml>\n---\n<body>`; null front matter when there is none. */
export function splitFrontMatter(md: string): { front: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { front: null, body: md };
  return { front: m[1]!, body: md.slice(m[0].length) };
}

function parseYamlText(file: string, text: string): unknown {
  try {
    return parseYaml(text) ?? {};
  } catch (err) {
    const e = err as { message?: string; linePos?: { line: number; col: number }[] };
    const where = e.linePos?.[0] ? ` (line ${e.linePos[0].line})` : "";
    throw new BrandFileError(`${file} isn't valid YAML${where}: ${(e.message ?? "").split("\n")[0]}`);
  }
}

/**
 * Validates a Brand Kit file's full content. YAML files must match the core schemas; pillars.md front matter must
 * hold valid lanes; every number in the proof inventory must name its source. Returns the clean (LF) content.
 */
export function validateBrandFile(file: string, content: string): string {
  const name = normalizeBrandFile(file);
  if (!name) throw new BrandFileError(`brand/${file} isn't a Brand Kit file.`);
  if (typeof content !== "string") throw new BrandFileError("The file content must be text.");
  const text = content.replace(/\r\n/g, "\n");
  if (Buffer.byteLength(text) > MAX_BRAND_FILE_BYTES) throw new BrandFileError(`${name} is too large (256 KB limit).`);
  if (!text.trim()) throw new BrandFileError(`${name} is empty.`);

  const check = (schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    if (!r.success) throw new BrandFileError(`${name} doesn't match the Brand Kit rules: ${issues(r.error)}`);
    return r.data;
  };

  switch (name) {
    case BRAND_FILES.brand:
      check(brandSchema, parseYamlText(name, text));
      break;
    case BRAND_FILES.proofInventory: {
      const inv = check(proofInventorySchema, parseYamlText(name, text)) as z.output<typeof proofInventorySchema>;
      for (const item of inv.items) {
        const bad = item.numbers.find((n) => !n.source.trim() || !n.value.trim());
        if (bad) throw new BrandFileError(`Proof item "${item.id}" has a number without a source. Every number needs where it came from.`);
      }
      const ids = inv.items.map((i) => i.id);
      const dup = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dup) throw new BrandFileError(`Proof item id "${dup}" is used twice.`);
      break;
    }
    case BRAND_FILES.competitors:
      check(competitorsSchema, parseYamlText(name, text));
      break;
    case BRAND_FILES.sources: {
      const s = check(sourcesSchema, parseYamlText(name, text)) as z.output<typeof sourcesSchema>;
      const ids = s.sources.map((x) => x.id);
      const dup = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dup) throw new BrandFileError(`Source id "${dup}" is used twice.`);
      break;
    }
    case BRAND_FILES.pillars: {
      const { front } = splitFrontMatter(text);
      if (front === null) throw new BrandFileError("pillars.md must start with front matter (--- lanes: ... ---).");
      const p = check(pillarSchema, parseYamlText(name, front)) as z.output<typeof pillarSchema>;
      if (!p.lanes.length) throw new BrandFileError("pillars.md needs at least one lane.");
      break;
    }
    default:
      break;
  }
  return text;
}

/** Parses YAML text, or null when it doesn't parse (never throws). */
export function parseYamlLoose(text: string): unknown {
  try {
    return parseYaml(text) ?? null;
  } catch {
    return null;
  }
}

export const contentHash = (s: string) => createHash("sha256").update(s).digest("hex");

export function readBrandFile(root: string, file: string): string {
  const abs = resolveBrandFile(root, file);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

/** Validates, then writes atomically (temp file + rename). Returns what was written. */
export function writeBrandFile(root: string, file: string, content: string): { file: string; path: string; bytes: number; hash: string; changed: boolean } {
  const abs = resolveBrandFile(root, file);
  const name = normalizeBrandFile(file)!;
  const text = validateBrandFile(name, content);
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  if (before !== text) {
    const tmp = join(resolve(root, "brand"), `.${name}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, abs);
  }
  return { file: name, path: `brand/${name}`, bytes: Buffer.byteLength(text), hash: contentHash(text), changed: before !== text };
}

// ───────────────────────────── Comment-preserving edits ─────────────────────────────

/**
 * Sets values in a YAML file without losing its comments (the starter files are full of notes for the owner).
 * `patch` keys are dotted paths; `undefined` deletes the key.
 */
export function patchYaml(text: string, patch: Record<string, unknown>): string {
  const doc = parseDocument(text || "{}");
  if (doc.errors.length) throw new BrandFileError(`The file isn't valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.split(".");
    if (value === undefined) doc.deleteIn(keys);
    else doc.setIn(keys, doc.createNode(value));
  }
  return doc.toString({ lineWidth: 0 });
}

export type Lane = z.output<typeof pillarSchema>["lanes"][number];

export function readLanes(pillarsMd: string): Lane[] {
  const { front } = splitFrontMatter(pillarsMd);
  if (front === null) return [];
  const r = pillarSchema.safeParse(parseYaml(front) ?? {});
  return r.success ? r.data.lanes : [];
}

/** Replaces the lanes in pillars.md front matter, keeping its comments and the body. */
export function setLanes(pillarsMd: string, lanes: Lane[]): string {
  const { front, body } = splitFrontMatter(pillarsMd);
  const doc = parseDocument(front ?? "");
  doc.setIn(["lanes"], doc.createNode(lanes.map((l) => ({ id: l.id, name: l.name, weeklyQuota: l.weeklyQuota, funnelStage: l.funnelStage, description: l.description }))));
  return `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/**
 * Replaces the body of a `## Heading` section (up to the next `## ` heading) or appends the section.
 * Headings are matched case-insensitively.
 */
export function upsertSection(md: string, heading: string, body: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const target = heading.trim().toLowerCase();
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === target);
  const block = [start === -1 ? `## ${heading}` : lines[start]!, "", body.trim(), ""];
  if (start === -1) {
    const out = md.replace(/\s*$/, "");
    return `${out}\n\n${block.join("\n")}`;
  }
  let end = lines.findIndex((l, i) => i > start && /^##?\s+/.test(l));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Reads the plain body of a `## Heading` section, without HTML comments. */
export function readSection(md: string, heading: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const target = heading.trim().toLowerCase();
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === target);
  if (start === -1) return "";
  let end = lines.findIndex((l, i) => i > start && /^##?\s+/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Lower-case slug for ids (offers, proof items, sources). */
export function slugify(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s || "item";
}
