import { createLogger, createSql, type AttentionOSConfig, type LogLevel, type Sql } from "@attentionos/core";
import {
  createSecrets,
  findWorkspaceRoot,
  loadConfigFile,
  loadWorkspace,
  readDotenv,
  resolveModules,
  WorkspaceError,
  workspacePaths,
  type LoadedWorkspace,
  type ModuleResolution,
} from "@attentionos/runtime";
import { ui } from "./ui.ts";

export type CliContext = { debug: boolean; workspaceDir?: string };

export function workspaceDir(ctx: CliContext): string {
  return ctx.workspaceDir ?? process.env.ATTENTIONOS_WORKSPACE ?? process.cwd();
}

export function cliLogger(ctx: CliContext, level: LogLevel = "warn") {
  return createLogger({ level: ctx.debug ? "debug" : level });
}

/** Loads the workspace plus its modules; module warnings are printed once, errors stop the command. */
export async function openWorkspace(
  ctx: CliContext,
  opts: { providers?: boolean; logLevel?: LogLevel; quiet?: boolean } = {},
): Promise<{ ws: LoadedWorkspace; modules: ModuleResolution }> {
  const ws = await loadWorkspace(workspaceDir(ctx), { providers: opts.providers, log: cliLogger(ctx, opts.logLevel) });
  try {
    const modules = await resolveModules(ws.config, { search: { workspaceRoot: ws.paths.root } });
    const errors = modules.problems.filter((p) => p.severity === "error");
    if (errors.length) throw new WorkspaceError(errors.map((e) => e.message).join("\n"), errors.find((e) => e.fix)?.fix, "module");
    return { ws, modules };
  } catch (err) {
    await ws.close();
    throw err;
  }
}

/** For commands that must work before the tables exist (`db push`): config + a raw connection, no workspace row. */
export async function openConfigAndDatabase(ctx: CliContext): Promise<{ root: string; config: AttentionOSConfig; sql: Sql; secret: (n: string) => string | undefined }> {
  const root = findWorkspaceRoot(workspaceDir(ctx));
  if (!root) throw new WorkspaceError("No AttentionOS workspace found here.", "cd into your workspace folder (the stack's workspace/), or start AttentionOS with ./aos start to create one", "no_workspace");
  const config = await loadConfigFile(workspacePaths(root).config);
  const secret = createSecrets(readDotenv(root));
  const url = secret("DATABASE_URL");
  if (!url) throw new WorkspaceError("DATABASE_URL is not set.", "Add DATABASE_URL to the .env file in your workspace (see .env.example).", "env");
  return { root, config, sql: createSql(url, { max: 2 }), secret };
}

export function printModuleWarnings(modules: ModuleResolution, quiet = false): void {
  if (quiet) return;
  for (const p of modules.problems.filter((x) => x.severity === "warning")) ui.warn(p.message);
}
