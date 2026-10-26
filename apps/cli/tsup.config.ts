import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Options } from "tsup";

/**
 * Builds the self-contained `attentionos` package: every @attentionos/* workspace package (core, runtime, modules,
 * provider adapters, guardrails…) is bundled; npm dependencies stay external and must be listed in package.json.
 *
 * Files the engine reads at runtime (module skills/migrations/module.json, db migrations, templates, presets,
 * media-py) are copied to dist/assets in the same layout as the repo, and every `import.meta.url` in
 * workspace source is rewritten to that file's mirrored location under dist/assets. So code that resolves
 * `new URL("../skills", import.meta.url)` finds the same files bundled as it does from source.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
};
const SKIP = new Set([".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "tests", "node_modules", "TEMPLATE.md", ".DS_Store"]);
/** Imported for types only (or loaded optionally from the workspace): never required at install time. */
const OPTIONAL = new Set(["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk"]);

function workspaceDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const group of ["packages", "packages/providers", "modules", "apps"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const file = join(base, d, "package.json");
      if (existsSync(file)) dirs.set((JSON.parse(readFileSync(file, "utf8")) as { name: string }).name, join(base, d));
    }
  }
  return dirs;
}

/** Fails the build when a bundled workspace package needs an npm dependency the CLI doesn't declare. */
function checkDependencies(): void {
  const dirs = workspaceDirs();
  const seen = new Set<string>();
  const missing = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name) || !dirs.has(name)) return;
    seen.add(name);
    const deps = (JSON.parse(readFileSync(join(dirs.get(name)!, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith("@attentionos/")) visit(dep);
      else if (!pkg.dependencies[dep] && !pkg.peerDependencies?.[dep] && !OPTIONAL.has(dep)) missing.add(`${dep} (needed by ${name})`);
    }
  };
  for (const dep of Object.keys(pkg.devDependencies)) visit(dep);
  if (missing.size) throw new Error(`apps/cli/package.json is missing dependencies: ${[...missing].join(", ")}`);
}

function copyAssets(): void {
  const out = join(here, "dist", "assets");
  // dist/assets/studio is managed by buildStudio (kept as is with ATTENTIONOS_SKIP_STUDIO=1).
  if (existsSync(out)) for (const d of readdirSync(out)) if (d !== "studio") rmSync(join(out, d), { recursive: true, force: true });
  const copy = (rel: string) => {
    const src = join(root, rel);
    if (existsSync(src)) cpSync(src, join(out, rel), { recursive: true, filter: (p) => !SKIP.has(basename(p)) });
  };
  for (const id of existsSync(join(root, "modules")) ? readdirSync(join(root, "modules")) : []) {
    for (const part of ["module.json", "skills", "migrations"]) copy(`modules/${id}/${part}`);
  }
  for (const rel of [
    "packages/db/migrations",
    "packages/runtime/src/config-shim.ts",
    "templates/workspace",
    "templates/formats",
    "presets",
    "media-py",
  ]) copy(rel);
  // npm drops .gitignore from published packages; create.ts renames it back.
  const gi = join(out, "templates", "workspace", ".gitignore");
  if (existsSync(gi)) renameSync(gi, join(out, "templates", "workspace", "_gitignore"));
}

/**
 * Studio ships as a Next.js standalone build in dist/assets/studio (server.js at apps/studio/server.js, as Next lays out
 * a monorepo build traced from the repo root).
 *
 * The standalone output mirrors pnpm's layout: packages live in node_modules/.pnpm/<id>/node_modules/<name> and are
 * reached through symlinks, which npm packages can't carry. So the copy is made symlink-free: every real package
 * directory is hoisted to node_modules/<name> (npm's flat layout, the version pnpm hoisted wins on a clash), links that
 * only point at a hoisted package are dropped, and any other link (Turbopack's hashed aliases for external packages,
 * like .next/node_modules/postgres-<hash>) is replaced by a copy of its target.
 *
 * ATTENTIONOS_SKIP_STUDIO=1 skips this (fast CLI-only builds); NEXT_DIST_DIR picks the build folder (default .next-pack,
 * so packaging never touches the .next folder a running `next dev` uses).
 */
function buildStudio(): void {
  if (process.env.ATTENTIONOS_SKIP_STUDIO === "1") {
    const kept = existsSync(join(here, "dist", "assets", "studio", "apps", "studio", "server.js"));
    console.warn(`[attentionos] ATTENTIONOS_SKIP_STUDIO=1: ${kept ? "keeping the previous Studio build" : "this build has no Studio"}.`);
    return;
  }
  const appDir = join(root, "apps", "studio");
  const distDir = process.env.NEXT_DIST_DIR || ".next-pack";
  const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
  execFileSync(process.execPath, [nextBin, "build", "--webpack"], {
    cwd: appDir,
    stdio: "inherit",
    env: { ...process.env, NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: "1", ATTENTIONOS_STUDIO_SKIP_TYPECHECK: process.env.ATTENTIONOS_STUDIO_SKIP_TYPECHECK ?? "1" },
  });
  assembleStudio(join(appDir, distDir, "standalone"), join(here, "dist", "assets", "studio"), { appDir, distDir });
}

const STUDIO_SKIP = new Set([".DS_Store", "tsconfig.tsbuildinfo", "next-env.d.ts"]);

function assembleStudio(standalone: string, out: string, opts: { appDir: string; distDir: string }): void {
  if (!existsSync(join(standalone, "apps", "studio", "server.js"))) throw new Error(`No Studio standalone build in ${standalone}`);
  rmSync(out, { recursive: true, force: true });
  const store = join(standalone, "node_modules", ".pnpm");
  const hoisted = new Map<string, string>(); // package name -> real dir

  // pnpm's own hoisting choices first (node_modules/.pnpm/node_modules/<name> -> preferred version).
  const pnpmHoist = join(store, "node_modules");
  const packageDirs = (base: string): [string, string][] => {
    if (!existsSync(base)) return [];
    const out: [string, string][] = [];
    for (const d of readdirSync(base)) {
      if (d.startsWith(".")) continue;
      if (d.startsWith("@")) for (const s of readdirSync(join(base, d))) out.push([`${d}/${s}`, join(base, d, s)]);
      else out.push([d, join(base, d)]);
    }
    return out;
  };
  for (const [name, p] of packageDirs(pnpmHoist)) if (existsSync(p)) hoisted.set(name, realpathSync(p));
  if (existsSync(store)) {
    for (const id of readdirSync(store)) {
      if (id === "node_modules") continue;
      for (const [name, p] of packageDirs(join(store, id, "node_modules"))) {
        if (!lstatSync(p).isSymbolicLink() && !hoisted.has(name)) hoisted.set(name, p);
      }
    }
  }
  // sharp is only used for image optimization, which Studio turns off; its binaries are per-platform (~18 MB).
  for (const name of [...hoisted.keys()]) if (name === "sharp" || name.startsWith("@img/")) hoisted.delete(name);
  const realHoisted = new Set([...hoisted.values()].map((p) => realpathSync(p)));
  for (const [name, p] of hoisted) cpSync(p, join(out, "node_modules", name), { recursive: true, dereference: true, filter: (f) => !STUDIO_SKIP.has(basename(f)) });

  // Everything else, without the pnpm store.
  const walk = (src: string, dst: string) => {
    for (const entry of readdirSync(src)) {
      if (STUDIO_SKIP.has(entry)) continue;
      const s = join(src, entry);
      const d = join(dst, entry);
      if (s === join(standalone, "node_modules")) continue;
      const st = lstatSync(s);
      if (st.isSymbolicLink()) {
        const target = realpathSync(s);
        const parent = basename(dirname(s));
        const scoped = parent.startsWith("@");
        const inNodeModules = parent === "node_modules" || (scoped && basename(dirname(dirname(s))) === "node_modules");
        const name = scoped ? `${parent}/${entry}` : entry;
        // A link to a package that's now hoisted resolves without it.
        if (inNodeModules && realHoisted.has(target) && hoisted.has(name) && realpathSync(hoisted.get(name)!) === target) continue;
        cpSync(target, d, { recursive: true, dereference: true });
      } else if (st.isDirectory()) {
        mkdirSync(d, { recursive: true });
        walk(s, d);
      } else {
        cpSync(s, d);
      }
    }
  };
  walk(standalone, out);
  // The source Next traced alongside is not needed at runtime.
  for (const rel of ["apps/studio/src", "apps/studio/scripts", "apps/studio/test"]) rmSync(join(out, rel), { recursive: true, force: true });

  const staticDir = join(opts.appDir, opts.distDir, "static");
  cpSync(staticDir, join(out, "apps", "studio", opts.distDir, "static"), { recursive: true });
  if (existsSync(join(opts.appDir, "public"))) cpSync(join(opts.appDir, "public"), join(out, "apps", "studio", "public"), { recursive: true });

  // Fail the build rather than ship a link npm would drop.
  const leftover: string[] = [];
  const check = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) leftover.push(relative(out, p));
      else if (st.isDirectory()) check(p);
    }
  };
  check(out);
  if (leftover.length) throw new Error(`Studio build still has symlinks: ${leftover.slice(0, 5).join(", ")}`);
}

/** Removes the previous build's chunks (top-level dist files only; dist/assets is handled separately). */
function cleanChunks(): void {
  const dist = join(here, "dist");
  if (!existsSync(dist)) return;
  for (const f of readdirSync(dist)) if (/\.(m?js|d\.ts|map)$/.test(f)) rmSync(join(dist, f), { force: true });
}
cleanChunks();

const mirrorImportMetaUrl: NonNullable<Options["esbuildPlugins"]>[number] = {
  name: "attentionos-asset-urls",
  setup(build) {
    build.onLoad({ filter: /\.m?ts$/ }, async (args) => {
      if (!args.path.startsWith(root + sep) || args.path.includes(`${sep}node_modules${sep}`)) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta.url")) return undefined;
      const rel = relative(root, args.path).split(sep).join("/");
      // Chunks are written to dist/, so this resolves to dist/assets/<repo path of the source file>.
      return { contents: source.replaceAll("import.meta.url", `new URL(${JSON.stringify(`./assets/${rel}`)}, import.meta.url).href`), loader: "ts" };
    });
  },
};

export default defineConfig({
  entry: {
    bin: "src/bin.ts",
    create: "src/create-bin.ts",
    guard: "src/guard-bin.ts",
    config: "src/config.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  // Cleaned by cleanChunks() instead: tsup's clean would also wipe dist/assets/studio.
  clean: false,
  splitting: true,
  sourcemap: false,
  dts: { entry: { config: "src/config.ts" } },
  noExternal: [/^@attentionos\//],
  external: [...OPTIONAL],
  esbuildPlugins: [mirrorImportMetaUrl],
  define: { __ATTENTIONOS_VERSION__: JSON.stringify(pkg.version) },
  onSuccess: async () => {
    checkDependencies();
    copyAssets();
    buildStudio();
  },
});
