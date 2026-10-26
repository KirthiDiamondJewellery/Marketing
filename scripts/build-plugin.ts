/**
 * Builds the AttentionOS Claude Code plugin into `plugin/` (Copilot mode).
 *
 *   pnpm plugin:build            assemble plugin/ from plugin-src/ and every module's skills
 *   pnpm plugin:build --check    fail if plugin/ is out of date (CI)
 *   pnpm plugin:build --out dir  write somewhere else
 *
 * Output layout (the standard Claude Code plugin layout):
 *   plugin/.claude-plugin/plugin.json   from plugin-src/plugin.json
 *   plugin/commands/*.md                /attention:<name> commands, from plugin-src/commands
 *   plugin/agents/*.md                  the six agents plus the Chief of Staff, from plugin-src/agents
 *   plugin/hooks/                       hooks.json + run.mjs, from plugin-src/hooks
 *   plugin/skills/<skill>/              every modules/<id>/skills/<skill>/ folder, discovered at build time
 *   plugin/README.md                    generated inventory
 *
 * The MCP server is deliberately NOT bundled: it's declared in each workspace's `.mcp.json` as server
 * "attentionos", so tool names are `mcp__attentionos__<tool>` in Copilot and Autopilot alike and the server runs
 * with the workspace as its working directory (a plugin-bundled server would be renamed
 * `mcp__plugin_attention_attentionos__*` and start in the plugin's install folder).
 *
 * The repo-root `.claude-plugin/marketplace.json` lists `./plugin`, so `/plugin marketplace add
 * evanbaker315/AttentionOS` then `/plugin install attentionos@attentionos` installs this output.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type FileMap = Map<string, Buffer>;

export type SkillInfo = { name: string; module: string; description: string; files: number };

export type Assembled = {
  files: FileMap;
  pluginName: string;
  version: string;
  commands: { name: string; description: string }[];
  agents: { name: string; description: string }[];
  skills: SkillInfo[];
  hookEvents: string[];
  warnings: string[];
};

export class PluginBuildError extends Error {
  constructor(public readonly problems: string[]) {
    super(`plugin build failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "PluginBuildError";
  }
}

// ---------------------------------------------------------------------------
// Front matter (a small YAML subset: scalars, quoted strings, inline [lists], "- item" lists, > and | blocks)
// ---------------------------------------------------------------------------

export type FrontMatter = Record<string, string | string[]>;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
  }
  return t;
}

export function parseFrontMatter(text: string): { data: FrontMatter; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const data: FrontMatter = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!.trim();
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      data[key] = rest.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if (rest === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) items.push(unquote(lines[++i]!.replace(/^\s*-\s+/, "")));
      data[key] = items.length ? items : "";
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = rest.slice(1, -1).split(",").map((s) => unquote(s)).filter(Boolean);
    } else {
      data[key] = unquote(rest);
    }
  }
  return { data, body: m[2]! };
}

const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(", ") : (v ?? ""));
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const posix = (p: string) => p.split(sep).join("/");

const AGENT_UNSUPPORTED = ["hooks", "mcpServers", "permissionMode"];

/** Reads plugin-src/ and modules/*\/skills/ under `root` and returns every output file. Writes nothing. */
export function assemblePlugin(root: string): Assembled {
  const problems: string[] = [];
  const warnings: string[] = [];
  const files: FileMap = new Map();
  const src = join(root, "plugin-src");

  // Manifest
  let manifest: Record<string, unknown> = {};
  const manifestPath = join(src, "plugin.json");
  if (!existsSync(manifestPath)) problems.push("plugin-src/plugin.json is missing");
  else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      problems.push(`plugin-src/plugin.json is not valid JSON (${e instanceof Error ? e.message : e})`);
    }
  }
  const pluginName = typeof manifest.name === "string" ? manifest.name : "";
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (existsSync(manifestPath)) {
    if (!KEBAB.test(pluginName)) problems.push(`plugin-src/plugin.json: "name" must be kebab-case (got "${pluginName}")`);
    if (!version) problems.push('plugin-src/plugin.json: "version" is required');
  }
  for (const key of ["commands", "agents", "skills", "hooks", "mcpServers"]) {
    if (key in manifest) problems.push(`plugin-src/plugin.json: remove "${key}"; the build lays out components in the default folders`);
  }
  files.set(".claude-plugin/plugin.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));

  // Commands
  const commands: Assembled["commands"] = [];
  for (const file of listFiles(join(src, "commands")).filter((f) => f.endsWith(".md"))) {
    const name = posix(relative(join(src, "commands"), file)).replace(/\.md$/, "");
    const text = readFileSync(file, "utf8");
    const fm = parseFrontMatter(text);
    if (name.includes("/")) problems.push(`commands/${name}.md: keep commands flat (no subfolders)`);
    if (!KEBAB.test(name.split("/").pop()!)) problems.push(`commands/${name}.md: file name must be kebab-case`);
    if (!fm || !str(fm.data.description)) problems.push(`commands/${name}.md: front matter needs a description`);
    commands.push({ name, description: str(fm?.data.description) });
    files.set(`commands/${name}.md`, Buffer.from(text));
  }

  // Agents
  const agents: Assembled["agents"] = [];
  for (const file of listFiles(join(src, "agents")).filter((f) => f.endsWith(".md"))) {
    const base = posix(relative(join(src, "agents"), file)).replace(/\.md$/, "");
    const text = readFileSync(file, "utf8");
    const fm = parseFrontMatter(text);
    if (!fm) {
      problems.push(`agents/${base}.md: missing front matter`);
      continue;
    }
    const name = str(fm.data.name);
    if (name !== base) problems.push(`agents/${base}.md: front matter name "${name}" must match the file name`);
    if (name.includes(":")) problems.push(`agents/${base}.md: names can't contain ":"`);
    if (!str(fm.data.description)) problems.push(`agents/${base}.md: front matter needs a description`);
    for (const k of AGENT_UNSUPPORTED) if (k in fm.data) problems.push(`agents/${base}.md: "${k}" is ignored for plugin agents; remove it`);
    const tools = Array.isArray(fm.data.tools) ? fm.data.tools : str(fm.data.tools).split(",").map((t) => t.trim()).filter(Boolean);
    for (const t of tools) {
      if (t.startsWith("mcp__") && !t.startsWith("mcp__attentionos")) warnings.push(`agents/${base}.md: tool "${t}" is not from the attentionos MCP server`);
    }
    agents.push({ name, description: str(fm.data.description) });
    files.set(`agents/${base}.md`, Buffer.from(text));
  }

  // Hooks
  const hookEvents: string[] = [];
  const hooksJson = join(src, "hooks", "hooks.json");
  if (existsSync(hooksJson)) {
    try {
      const parsed = JSON.parse(readFileSync(hooksJson, "utf8")) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
      if (!parsed.hooks || typeof parsed.hooks !== "object") problems.push('hooks/hooks.json: wrap the events in a top-level "hooks" object');
      for (const [event, matchers] of Object.entries(parsed.hooks ?? {})) {
        hookEvents.push(event);
        for (const m of matchers) {
          for (const h of m.hooks ?? []) {
            for (const ref of h.command?.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g) ?? []) {
              if (!existsSync(join(src, ref[1]!))) problems.push(`hooks/hooks.json: ${event} runs ${ref[1]}, which is not in plugin-src/`);
            }
          }
        }
      }
    } catch (e) {
      problems.push(`hooks/hooks.json is not valid JSON (${e instanceof Error ? e.message : e})`);
    }
  }
  for (const file of listFiles(join(src, "hooks"))) files.set(`hooks/${posix(relative(join(src, "hooks"), file))}`, readFileSync(file));

  // Skills from every module
  const skills: SkillInfo[] = [];
  const seen = new Map<string, string>();
  const commandNames = new Set(commands.map((c) => c.name));
  const agentNames = new Set(agents.map((a) => a.name));
  const modulesDir = join(root, "modules");
  const moduleDirs = existsSync(modulesDir)
    ? readdirSync(modulesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort()
    : [];
  for (const mod of moduleDirs) {
    const skillsDir = join(modulesDir, mod, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name;
      const dir = join(skillsDir, name);
      const skillMd = join(dir, "SKILL.md");
      const where = `modules/${mod}/skills/${name}`;
      if (!existsSync(skillMd)) {
        warnings.push(`${where}: no SKILL.md yet, skipped`);
        continue;
      }
      const fm = parseFrontMatter(readFileSync(skillMd, "utf8"));
      if (!KEBAB.test(name)) problems.push(`${where}: folder name must be kebab-case`);
      if (!fm) problems.push(`${where}/SKILL.md: missing front matter`);
      else {
        if (!str(fm.data.description)) problems.push(`${where}/SKILL.md: front matter needs a description`);
        if (fm.data.name !== undefined && str(fm.data.name) !== name) problems.push(`${where}/SKILL.md: name "${str(fm.data.name)}" must match the folder name`);
      }
      if (seen.has(name)) problems.push(`skill "${name}" exists in both modules/${seen.get(name)} and modules/${mod}; rename one`);
      if (commandNames.has(name)) problems.push(`${where}: "${name}" clashes with the /${pluginName || "attention"}:${name} command; rename the skill`);
      if (agentNames.has(name)) problems.push(`${where}: "${name}" is also an agent name; rename the skill so ${pluginName || "attention"}:${name} means one thing`);
      seen.set(name, mod);
      const skillFiles = listFiles(dir);
      for (const f of skillFiles) files.set(`skills/${name}/${posix(relative(dir, f))}`, readFileSync(f));
      skills.push({ name, module: mod, description: str(fm?.data.description), files: skillFiles.length });
    }
  }

  if (problems.length) throw new PluginBuildError(problems);
  files.set("README.md", Buffer.from(renderReadme({ pluginName, version, commands, agents, skills })));
  return { files, pluginName, version, commands, agents, skills, hookEvents, warnings };
}

function oneLine(s: string, max = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function renderReadme(a: Pick<Assembled, "pluginName" | "version" | "commands" | "agents" | "skills">): string {
  const lines = [
    "# AttentionOS plugin for Claude Code",
    "",
    "<!-- Generated by `pnpm plugin:build`. Edit plugin-src/ or modules/*/skills/ instead. -->",
    "",
    `Version ${a.version}. Open an AttentionOS workspace in Claude Code and start with \`/${a.pluginName}:init\`.`,
    "",
    "Install it from Claude Code:",
    "",
    "```",
    "/plugin marketplace add evanbaker315/AttentionOS",
    "/plugin install attentionos@attentionos",
    "```",
    "",
    "## Commands",
    "",
    "| Command | What it does |",
    "|---|---|",
    ...a.commands.map((c) => `| \`/${a.pluginName}:${c.name}\` | ${oneLine(c.description)} |`),
    "",
    "## Agents",
    "",
    "| Agent | When it's used |",
    "|---|---|",
    ...a.agents.map((g) => `| \`${a.pluginName}:${g.name}\` | ${oneLine(g.description)} |`),
    "",
    "## Skills",
    "",
    "| Skill | Module | What it's for |",
    "|---|---|---|",
    ...a.skills.map((s) => `| \`${s.name}\` | ${s.module} | ${oneLine(s.description)} |`),
    "",
    "The AttentionOS MCP server is configured by your workspace's `.mcp.json`, not by this plugin.",
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Write and check
// ---------------------------------------------------------------------------

export function readTree(dir: string): FileMap {
  const out: FileMap = new Map();
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name !== ".DS_Store") out.set(posix(relative(dir, full)), readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** Paths that differ between the assembled files and what's on disk. */
export function diffTree(expected: FileMap, actual: FileMap): { missing: string[]; changed: string[]; extra: string[] } {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [p, buf] of expected) {
    const have = actual.get(p);
    if (!have) missing.push(p);
    else if (!have.equals(buf)) changed.push(p);
  }
  const extra = [...actual.keys()].filter((p) => !expected.has(p));
  return { missing: missing.sort(), changed: changed.sort(), extra: extra.sort() };
}

export function writePlugin(outDir: string, files: FileMap): void {
  rmSync(outDir, { recursive: true, force: true });
  for (const [p, buf] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const full = join(outDir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buf);
  }
}

export function buildPlugin(opts: { root: string; outDir?: string; check?: boolean }): Assembled & { outDir: string; upToDate?: boolean; diff?: ReturnType<typeof diffTree> } {
  const root = resolve(opts.root);
  const outDir = resolve(opts.outDir ?? join(root, "plugin"));
  if (outDir === root || root.startsWith(outDir + sep)) throw new PluginBuildError([`refusing to write the plugin over ${outDir}`]);
  const assembled = assemblePlugin(root);
  if (opts.check) {
    const diff = diffTree(assembled.files, readTree(outDir));
    const upToDate = !diff.missing.length && !diff.changed.length && !diff.extra.length;
    return { ...assembled, outDir, upToDate, diff };
  }
  writePlugin(outDir, assembled.files);
  return { ...assembled, outDir };
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const check = args.includes("--check");
  const outIdx = args.indexOf("--out");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = outIdx >= 0 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;
  try {
    const r = buildPlugin({ root, ...(outDir ? { outDir } : {}), check });
    for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
    const rel = relative(root, r.outDir) || ".";
    const summary = `${r.commands.length} commands, ${r.agents.length} agents, ${r.hookEvents.length} hook events, ${r.skills.length} skills from ${new Set(r.skills.map((s) => s.module)).size} modules`;
    if (check) {
      if (r.upToDate) {
        process.stdout.write(`${rel}/ is up to date (${summary})\n`);
        return 0;
      }
      const d = r.diff!;
      for (const p of d.missing) process.stderr.write(`  missing  ${p}\n`);
      for (const p of d.changed) process.stderr.write(`  changed  ${p}\n`);
      for (const p of d.extra) process.stderr.write(`  extra    ${p}\n`);
      process.stderr.write(`${rel}/ is out of date. Run \`pnpm plugin:build\` and commit the result.\n`);
      return 1;
    }
    process.stdout.write(`Built ${rel}/ with ${summary}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv);
}
