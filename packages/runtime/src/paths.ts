import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspacePaths } from "@attentionos/core";

/** Config file names accepted in `<workspace>/config/`, in priority order. */
export const CONFIG_FILES = ["attentionos.config.ts", "attentionos.config.mts", "attentionos.config.js", "attentionos.config.mjs"] as const;

export function findConfigFile(root: string): string | null {
  for (const name of CONFIG_FILES) {
    const path = join(root, "config", name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Walks up from `start` to the first folder holding `config/attentionos.config.ts`. */
export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (findConfigFile(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    brand: join(root, "brand"),
    config: findConfigFile(root) ?? join(root, "config", CONFIG_FILES[0]),
    media: join(root, "media"),
    lessons: join(root, "brand", "lessons.md"),
    state: join(root, ".attentionos"),
  };
}

/**
 * The engine's source checkout (the folder with pnpm-workspace.yaml), when running from source.
 * Used to find modules, providers, templates and presets during development. Null when installed from npm.
 */
export function findEngineRoot(from: string = fileURLToPath(new URL(".", import.meta.url))): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "packages", "core"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
