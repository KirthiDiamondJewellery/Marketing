import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { builtinLoader } from "./builtins.ts";
import { findEngineRoot } from "./paths.ts";

/**
 * Imports an optional engine package (a module or a provider) by name, tolerating packages that aren't installed.
 * Lookup order:
 *  0. the built-in registry (everything bundled into the `attentionos` package);
 *  1. normal resolution from the engine;
 *  2. the workspace's own node_modules (`npm install @attentionos/provider-x` in the workspace);
 *  3. the engine source checkout (`modules/<id>`, `packages/providers/<dir>`) when running from source.
 */

export type ImportResult<T> =
  | { ok: true; module: T; from: "builtin" | "engine" | "workspace" | "source" }
  | { ok: false; reason: "not_installed" | "failed"; error: string };

export type ImportSearch = { workspaceRoot?: string; engineRoot?: string | null };

function isNotFound(err: unknown, spec: string): boolean {
  const e = err as { code?: string; message?: string };
  return (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") && Boolean(e.message?.includes(spec));
}

function sourceDir(spec: string, engineRoot: string): string | null {
  const mod = /^@attentionos\/module-([a-z0-9-]+)$/.exec(spec);
  if (mod) return join(engineRoot, "modules", mod[1]!);
  const prov = /^@attentionos\/provider-([a-z0-9-]+)$/.exec(spec);
  if (prov) return join(engineRoot, "packages", "providers", prov[1]!);
  return null;
}

function entryOf(dir: string): string | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: unknown; main?: string };
  const root = typeof pkg.exports === "object" && pkg.exports !== null && "." in pkg.exports ? (pkg.exports as Record<string, unknown>)["."] : pkg.exports;
  const target =
    typeof root === "string"
      ? root
      : root && typeof root === "object"
        ? ((root as Record<string, unknown>).import ?? (root as Record<string, unknown>).default)
        : pkg.main;
  return typeof target === "string" ? join(dir, target) : null;
}

export async function importOptional<T = unknown>(spec: string, search: ImportSearch = {}): Promise<ImportResult<T>> {
  const builtin = builtinLoader(spec);
  if (builtin) {
    try {
      return { ok: true, module: (await builtin()) as T, from: "builtin" };
    } catch (err) {
      return { ok: false, reason: "failed", error: (err as Error).message };
    }
  }
  try {
    return { ok: true, module: (await import(spec)) as T, from: "engine" };
  } catch (err) {
    if (!isNotFound(err, spec)) return { ok: false, reason: "failed", error: (err as Error).message };
  }
  if (search.workspaceRoot && existsSync(join(search.workspaceRoot, "node_modules"))) {
    try {
      const resolved = createRequire(join(search.workspaceRoot, "package.json")).resolve(spec);
      return { ok: true, module: (await import(pathToFileURL(resolved).href)) as T, from: "workspace" };
    } catch (err) {
      if (!isNotFound(err, spec)) return { ok: false, reason: "failed", error: (err as Error).message };
    }
  }
  const engineRoot = search.engineRoot === undefined ? findEngineRoot() : search.engineRoot;
  const dir = engineRoot ? sourceDir(spec, engineRoot) : null;
  const entry = dir ? entryOf(dir) : null;
  if (entry && existsSync(entry)) {
    try {
      return { ok: true, module: (await import(pathToFileURL(entry).href)) as T, from: "source" };
    } catch (err) {
      return { ok: false, reason: "failed", error: (err as Error).message };
    }
  }
  return { ok: false, reason: "not_installed", error: `${spec} is not installed` };
}
