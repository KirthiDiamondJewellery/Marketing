import {
  createLogger,
  createSql,
  loadBrandKit,
  type AttentionOSConfig,
  type BrandKit,
  type Logger,
  type Sql,
  type WorkspaceContext,
} from "@attentionos/core";
import { ensureWorkspace, seedAgents, slugify } from "@attentionos/db";
import { loadConfigFile } from "./config.ts";
import { createSecrets, readDotenv } from "./env.ts";
import { WorkspaceError } from "./errors.ts";
import { findWorkspaceRoot, workspacePaths } from "./paths.ts";
import { buildProviderRegistry, type ProviderDiagnostic } from "./providers.ts";
import type { ImportSearch } from "./resolve.ts";

export type LoadWorkspaceOptions = {
  /** Overrides DATABASE_URL from the environment / .env. */
  databaseUrl?: string;
  /** Use an existing connection pool instead of opening one (tests, CLI commands that already connected). */
  sql?: Sql;
  log?: Logger;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Set false to skip loading provider packages (e.g. `db push`). Default true. */
  providers?: boolean;
  /** Create the `workspaces` row (and agents) when missing. Default true. */
  ensureRow?: boolean;
  /** Where to look for optional packages; defaults to the engine install plus the workspace's node_modules. */
  search?: ImportSearch;
};

/** WorkspaceContext plus what the CLI, MCP server and worker need on top. */
export type LoadedWorkspace = WorkspaceContext & {
  slug: string;
  diagnostics: ProviderDiagnostic[];
  close(): Promise<void>;
};

const PG_UNDEFINED_TABLE = "42P01";

export function describeDatabaseError(err: unknown): WorkspaceError {
  const e = err as { code?: string; message?: string };
  if (e?.code === PG_UNDEFINED_TABLE) {
    return new WorkspaceError("Your database isn't set up yet.", "Run `attentionos db push` to create the tables.", "database");
  }
  if (e?.code === "ECONNREFUSED" || e?.code === "ENOTFOUND" || e?.code === "ETIMEDOUT" || e?.code === "CONNECT_TIMEOUT") {
    return new WorkspaceError(
      "Could not connect to the database.",
      "Is AttentionOS running? With the Docker install, start it with `./aos start` from your AttentionOS folder. Otherwise check DATABASE_URL in your workspace .env and that the database is up (for development: `pnpm db:start`).",
      "database",
    );
  }
  if (e?.code === "28P01" || e?.code === "28000") {
    return new WorkspaceError("The database rejected the password in DATABASE_URL.", "Check the password in DATABASE_URL in .env. With the Docker install the stack sets it for you: run `./aos restart`.", "database");
  }
  return new WorkspaceError(`Database error: ${e?.message ?? String(err)}`, undefined, "database");
}

export async function resolveWorkspaceId(sql: Sql, config: AttentionOSConfig, ensureRow: boolean): Promise<{ id: string; slug: string; created: boolean }> {
  const slug = slugify(config.workspace.name);
  const { id, name, timezone } = config.workspace;
  try {
    if (ensureRow) {
      const res = await ensureWorkspace(sql, { id, name, slug, timezone });
      if (res.created) await seedAgents(sql, res.id, config);
      const [row] = await sql<{ slug: string }[]>`select slug from workspaces where id = ${res.id}`;
      return { ...res, slug: row?.slug ?? slug };
    }
    const rows = id
      ? await sql<{ id: string; slug: string }[]>`select id, slug from workspaces where id = ${id}`
      : await sql<{ id: string; slug: string }[]>`select id, slug from workspaces where slug = ${slug}`;
    if (!rows[0]) throw new WorkspaceError(`This workspace isn't in the database yet.`, "Run `attentionos db push`.", "database");
    return { id: rows[0].id, slug: rows[0].slug, created: false };
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
    throw describeDatabaseError(err);
  }
}

/**
 * Loads the workspace that contains `rootDir` (walking up to the folder with `config/attentionos.config.ts`):
 * `.env`, config, database connection, workspace id, providers and a lazily-loaded Brand Kit.
 */
export async function loadWorkspace(rootDir: string, opts: LoadWorkspaceOptions = {}): Promise<LoadedWorkspace> {
  const root = findWorkspaceRoot(rootDir);
  if (!root) {
    throw new WorkspaceError(
      "No AttentionOS workspace found here.",
      "Run this inside your workspace folder. The Docker stack creates one on first start (`./aos start`).",
      "no_workspace",
    );
  }
  const paths = workspacePaths(root);
  const secret = createSecrets(readDotenv(root), opts.env);
  const config = await loadConfigFile(paths.config);
  const log = opts.log ?? createLogger();

  let sql = opts.sql;
  if (!sql) {
    const url = opts.databaseUrl ?? secret("DATABASE_URL");
    if (!url) {
      throw new WorkspaceError("DATABASE_URL is not set.", "Add DATABASE_URL to the .env file in your workspace (see .env.example).", "env");
    }
    sql = createSql(url);
  }
  const ownsSql = !opts.sql;

  try {
    const { id, slug } = await resolveWorkspaceId(sql, config, opts.ensureRow ?? true);
    const search: ImportSearch = opts.search ?? { workspaceRoot: root };
    const { providers, diagnostics } =
      opts.providers === false
        ? { providers: { trendSources: {} }, diagnostics: [] as ProviderDiagnostic[] }
        : await buildProviderRegistry(config, { secret, config, log, search, mediaDir: paths.media });

    let brand: BrandKit | undefined;
    const now = opts.now ?? (() => new Date());
    const finalSql = sql;
    return {
      id,
      slug,
      paths,
      config,
      brand: () => (brand ??= loadBrandKit(paths.brand)),
      reloadBrand: () => (brand = loadBrandKit(paths.brand)),
      sql: finalSql,
      providers,
      diagnostics,
      log,
      now,
      secret,
      async close() {
        if (ownsSql) await finalSql.end({ timeout: 5 });
      },
    };
  } catch (err) {
    if (ownsSql) await sql.end({ timeout: 1 }).catch(() => {});
    throw err;
  }
}
