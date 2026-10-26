import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { configSchema, type AttentionOSConfig } from "@attentionos/core";
import { describeIssues, WorkspaceError } from "./errors.ts";

/**
 * Loads `config/attentionos.config.ts` with jiti.
 *
 * Why jiti: it transpiles TypeScript in-process with no native binary and no loader hooks, so it works the same from
 * source, from the bundled CLI inside the Docker image, and on Windows. Its `alias` option lets us point `attentionos/config` at
 * a bundled shim, so a workspace config loads even before (or without) `npm install` in the workspace.
 * tsx's `tsImport` needs esbuild's platform binary and registers global hooks; Node's own type stripping refuses
 * files that import uninstalled packages.
 */

function shimPath(): string {
  for (const candidate of ["./config-shim.ts", "./config-shim.js"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new WorkspaceError("The AttentionOS install looks incomplete (config shim missing).", "Reinstall attentionos: npm install -g attentionos@latest");
}

export async function loadConfigModule(path: string): Promise<unknown> {
  const shim = shimPath();
  const jiti = createJiti(import.meta.url, {
    alias: { "attentionos/config": shim, "@attentionos/core": shim, attentionos: shim },
    moduleCache: false,
    fsCache: false,
    interopDefault: true,
  });
  try {
    return await jiti.import(path, { default: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new WorkspaceError(`Could not read config/attentionos.config.ts: ${reason}`, "Fix the syntax error shown above, or run `attentionos doctor`.");
  }
}

export function validateConfig(raw: unknown): AttentionOSConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new WorkspaceError(`Your config has problems: ${describeIssues(parsed.error.issues)}`, "Edit config/attentionos.config.ts and run `attentionos doctor` again.");
  }
  return parsed.data;
}

export async function loadConfigFile(path: string): Promise<AttentionOSConfig> {
  if (!existsSync(path)) throw new WorkspaceError(`Config file not found: ${path}`, "Start AttentionOS with `./aos start`; it creates the workspace on first start.", "no_workspace");
  return validateConfig(await loadConfigModule(path));
}
