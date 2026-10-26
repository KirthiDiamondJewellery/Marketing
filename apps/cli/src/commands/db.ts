import { migrationStatus, collectMigrations, coreMigrationsDir, runMigrations, seedAgents } from "@attentionos/db";
import { describeDatabaseError, resolveModules, resolveWorkspaceId } from "@attentionos/runtime";
import { parseCommand } from "../args.ts";
import { UserError } from "../errors.ts";
import { ui } from "../ui.ts";
import { openConfigAndDatabase, type CliContext } from "../workspace.ts";

export const DB_HELP = `Set up or update your database.

Usage
  attentionos db push [--dry-run]   Apply database updates for the engine and every module that's on
  attentionos db status             Show which updates are applied
`;

export async function runDb(argv: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand("db", argv, { "dry-run": { type: "boolean", default: false } });
  const sub = positionals[0];
  if (values.help || !sub) {
    ui.out(DB_HELP);
    return sub ? 0 : values.help ? 0 : 1;
  }
  if (sub !== "push" && sub !== "status") throw new UserError(`Unknown db command "${sub}".`, "Use `attentionos db push` or `attentionos db status`.");

  const { root, config, sql } = await openConfigAndDatabase(ctx);
  try {
    const modules = await resolveModules(config, { search: { workspaceRoot: root } });
    const moduleDirs = modules.modules.filter((m) => m.migrationsDir).map((m) => ({ dir: m.migrationsDir!, source: m.manifest.id }));
    try {
      await sql`select 1`;
    } catch (err) {
      throw describeDatabaseError(err);
    }
    if (sub === "status") {
      const status = await migrationStatus(sql, collectMigrations([{ dir: coreMigrationsDir(), source: "core" }, ...moduleDirs]));
      ui.title("Database");
      ui.ok(`${status.applied.length} update(s) applied`);
      for (const p of status.pending) ui.warn(`Not applied yet: ${p.name}`, p.source);
      for (const c of status.changed) ui.fail(`Edited after it ran: ${c.name}`);
      ui.out();
      return status.changed.length ? 1 : 0;
    }
    const dryRun = Boolean(values["dry-run"]);
    const result = await runMigrations(sql, { moduleDirs, dryRun });
    ui.title(dryRun ? "Database updates (dry run)" : "Database");
    if (dryRun) {
      if (!result.pending.length) ui.ok("Nothing to apply");
      for (const name of result.pending) ui.out(`  would apply ${name}`);
      ui.out();
      return 0;
    }
    if (result.applied.length) ui.ok(`Applied ${result.applied.length} update(s)`, result.applied.join(", "));
    else ui.ok("Already up to date", `${result.alreadyApplied} update(s)`);
    const ws = await resolveWorkspaceId(sql, config, true);
    await seedAgents(sql, ws.id, config);
    ui.ok(`Workspace ${config.workspace.name} is ready`, "agents and settings synced");
    ui.out();
    return 0;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
