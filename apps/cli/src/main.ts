import { splitCommand } from "./args.ts";
import { runApprovals } from "./commands/approvals.ts";
import { runCreate } from "./commands/create.ts";
import { runDb } from "./commands/db.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runHook } from "./commands/hook.ts";
import { runInit } from "./commands/init.ts";
import { runMcp } from "./commands/mcp.ts";
import { runRun } from "./commands/run.ts";
import { runStatus } from "./commands/status.ts";
import { runStudio } from "./commands/studio.ts";
import { runUp } from "./commands/up.ts";
import { runUpdate, VERSION } from "./commands/update.ts";
import { runWorker } from "./commands/worker.ts";
import { reportError, UserError } from "./errors.ts";
import { ui } from "./ui.ts";
import type { CliContext } from "./workspace.ts";

export const HELP = `AttentionOS ${VERSION}: your content operating system.

Usage
  attentionos <command> [options]

Getting started
  create <folder>     Create a workspace (the Docker stack does this on first start)
  doctor [--fix]      Check your setup and fix what's missing
  init                Check the Brand Kit (the interview runs in Claude Code: /attention:init)

Every day
  status              What's set up and what's waiting
  approvals           See and decide what's waiting for your approval
  run <job>           Run one job now

Studio and Autopilot
  studio              Open Studio, the dashboard (http://localhost:4747)
  up                  Studio and Autopilot together, for 24/7 on a server
  worker              Start Autopilot (schedules, queue, webhooks)
  mcp                 Start the data server for Claude Code (used by .mcp.json)
  hook <name>         Claude Code hooks used by the plugin (session-start, copy-guard)

Maintenance
  db push             Set up or update the database
  update              How to update AttentionOS

Options for every command
  -w, --workspace <folder>   Use this workspace instead of the current folder
  --debug                    Show technical details when something fails
  -h, --help                 Help for a command
`;

type Command = (argv: string[], ctx: CliContext) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
  create: (argv) => runCreate(argv),
  doctor: (argv) => runDoctor(argv),
  init: runInit,
  status: runStatus,
  approvals: runApprovals,
  run: runRun,
  worker: runWorker,
  studio: runStudio,
  up: runUp,
  mcp: runMcp,
  db: runDb,
  update: () => runUpdate(),
  hook: runHook,
};

export async function main(argv: string[]): Promise<number> {
  const { command, args, debug, version, workspace } = splitCommand(argv);
  const ctx: CliContext = { debug, workspaceDir: workspace };
  try {
    if (version) {
      ui.out(VERSION);
      return 0;
    }
    if (!command || command === "help") {
      ui.out(HELP);
      return command || argv.includes("--help") || argv.includes("-h") ? 0 : 1;
    }
    const handler = COMMANDS[command];
    if (!handler) throw new UserError(`"${command}" isn't an AttentionOS command.`, "Run `attentionos --help` to see the commands.");
    return await handler(args, ctx);
  } catch (err) {
    return reportError(err, debug);
  }
}

export async function createMain(argv: string[]): Promise<number> {
  try {
    return runCreate(argv);
  } catch (err) {
    return reportError(err, splitCommand(argv).debug);
  }
}
