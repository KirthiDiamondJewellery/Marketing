import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { slugify } from "@attentionos/db";
import { DEFAULT_PRESETS, parseCreateArgs, type CreateArgs } from "../args.ts";
import { findAsset, requireAsset } from "../assets.ts";
import { UserError } from "../errors.ts";
import { ui } from "../ui.ts";

const presetSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  files: z.record(z.string(), z.string()).optional(),
  funnelMix: z.object({ tofu: z.number(), mofu: z.number(), bofu: z.number() }).optional(),
  northStar: z.object({ metric: z.string() }).optional(),
}).passthrough();

const DEFAULT_PRESET_FILES: Record<string, string> = {
  "pillars.md": "brand/pillars.md",
  "sources.yaml": "brand/sources.yaml",
  "cadence.yaml": "brand/knowledge/preset-cadence.yaml",
  "cta.yaml": "brand/knowledge/preset-cta.yaml",
  "formats.md": "brand/knowledge/preset-formats.md",
};

const TEXT_EXTENSIONS = new Set([".ts", ".md", ".yaml", ".yml", ".json", ".example", ".txt", ""]);
const QUOTED_EXTENSIONS = new Set([".ts", ".yaml", ".yml", ".json"]);

export function availablePresets(presetsDir: string | null = findAsset("presets")): string[] {
  if (!presetsDir || !existsSync(presetsDir)) return [...DEFAULT_PRESETS];
  const ids = readdirSync(presetsDir).filter((d) => statSync(join(presetsDir, d)).isDirectory() && /^[a-z0-9-]+$/.test(d));
  return ids.length ? ids.sort() : [...DEFAULT_PRESETS];
}

export type CreateWorkspaceOptions = {
  dir: string;
  preset: string;
  name?: string;
  timezone?: string;
  id?: string;
  templateDir?: string;
  presetsDir?: string;
};

export type CreatedWorkspace = { root: string; name: string; slug: string; preset: string; id: string; timezone: string; envCreated: boolean };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** JSON-style escaping keeps a name safe inside the double-quoted strings of .ts, .yaml and .json files. */
function fillPlaceholders(text: string, ext: string, values: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) return match;
    return QUOTED_EXTENSIONS.has(ext) ? JSON.stringify(value).slice(1, -1) : value;
  });
}

function setFunnelMix(yaml: string, mix: { tofu: number; mofu: number; bofu: number }): string {
  const block = `funnelMix:\n  tofu: ${mix.tofu}\n  mofu: ${mix.mofu}\n  bofu: ${mix.bofu}\n`;
  return /^funnelMix:\n(?:[ \t]+.*\n?)*/m.test(yaml) ? yaml.replace(/^funnelMix:\n(?:[ \t]+.*\n?)*/m, block) : `${yaml.trimEnd()}\n\n${block}`;
}

function setNorthStar(config: string, metric: string): string {
  return config.replace(/northStar:\s*\{\s*metric:\s*"[^"]*"/, `northStar: { metric: "${metric}"`);
}

export function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
}

export function nameFromDir(dir: string): string {
  const words = basename(resolve(dir)).replace(/[-_]+/g, " ").trim();
  return words ? words.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : "My brand";
}

/** Copies the workspace template, overlays the preset and fills placeholders. */
export function createWorkspace(o: CreateWorkspaceOptions): CreatedWorkspace {
  const root = resolve(o.dir);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new UserError(`The folder ${o.dir} already exists and isn't empty.`, "Pick a new folder name, e.g. attentionos create my-brand");
  }
  const templateDir = o.templateDir ?? requireAsset("templates/workspace");
  const presetsDir = o.presetsDir ?? findAsset("presets");
  const presetDir = presetsDir ? join(presetsDir, o.preset) : null;
  if (!presetDir || !existsSync(presetDir)) {
    throw new UserError(`There is no "${o.preset}" preset.`, `Choose one of: ${availablePresets(presetsDir).join(", ")}.`);
  }

  mkdirSync(root, { recursive: true });
  cpSync(templateDir, root, { recursive: true, filter: (src) => basename(src) !== "TEMPLATE.md" });
  // npm drops .gitignore from published packages, so the bundled template may carry it as _gitignore.
  if (existsSync(join(root, "_gitignore")) && !existsSync(join(root, ".gitignore"))) renameSync(join(root, "_gitignore"), join(root, ".gitignore"));

  const presetJsonPath = join(presetDir, "preset.json");
  const preset = existsSync(presetJsonPath) ? presetSchema.parse(JSON.parse(readFileSync(presetJsonPath, "utf8"))) : null;
  for (const [file, target] of Object.entries(preset?.files ?? DEFAULT_PRESET_FILES)) {
    const src = join(presetDir, file);
    if (!existsSync(src)) continue;
    const dest = join(root, target);
    if (relative(root, dest).startsWith("..")) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }

  const id = o.id ?? randomUUID();
  const name = o.name ?? nameFromDir(o.dir);
  const timezone = o.timezone ?? defaultTimezone();

  const slug = slugify(name);
  const values = { WORKSPACE_ID: id, WORKSPACE_NAME: name, WORKSPACE_SLUG: slug, PRESET: o.preset, TIMEZONE: timezone };
  for (const file of walk(root)) {
    const ext = extname(file);
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes("{{")) writeFileSync(file, fillPlaceholders(text, ext, values));
  }

  if (preset) {
    const brandYaml = join(root, "brand", "brand.yaml");
    if (preset.funnelMix && existsSync(brandYaml)) writeFileSync(brandYaml, setFunnelMix(readFileSync(brandYaml, "utf8"), preset.funnelMix));
    const config = join(root, "config", "attentionos.config.ts");
    if (preset.northStar && existsSync(config)) writeFileSync(config, setNorthStar(readFileSync(config, "utf8"), preset.northStar.metric));
  }

  for (const dir of ["media/raw", "media/renders", "media/assets", ".attentionos"]) mkdirSync(join(root, dir), { recursive: true });
  let envCreated = false;
  if (existsSync(join(root, ".env.example")) && !existsSync(join(root, ".env"))) {
    copyFileSync(join(root, ".env.example"), join(root, ".env"));
    envCreated = true;
  }
  return { root, name, slug, preset: o.preset, id, timezone, envCreated };
}

export const CREATE_HELP = `Create a new AttentionOS workspace.

Usage
  attentionos create <folder> [--preset coach-consultant|agency-founder]

Options
  --preset <id>       Starting point for lanes, cadence and trend sources (default coach-consultant)
  --name "<brand>"    Brand name (default: from the folder name)
  --timezone <zone>   IANA timezone, e.g. America/Chicago (default: this computer's)
`;

export function runCreate(argv: string[]): number {
  const presets = availablePresets();
  const args: CreateArgs = parseCreateArgs(argv, presets);
  if (args.help) {
    ui.out(CREATE_HELP);
    return 0;
  }
  const ws = createWorkspace({ dir: args.dir, preset: args.preset, name: args.name, timezone: args.timezone });
  const rel = relative(process.cwd(), ws.root) || ".";
  ui.title(`Created ${ws.name} in ${rel}`);
  ui.ok("Brand Kit, settings and Claude Code setup", `preset ${ws.preset}, timezone ${ws.timezone}`);
  if (ws.envCreated) ui.ok("Secrets file .env (fill in what your setup level needs)");
  ui.out();
  ui.out(ui.bold("Next steps"));
  ui.step(1, `${ui.code(`cd ${rel.includes(" ") ? `"${rel}"` : rel}`)}`);
  ui.step(2, `Add your database connection to ${ui.code(".env")} (DATABASE_URL), then run ${ui.code("attentionos doctor --fix")}`);
  ui.step(3, `Open Claude Code here (${ui.code("claude")}) and run ${ui.code("/attention:init")} for the Brand Kit interview`);
  ui.out();
  return 0;
}
