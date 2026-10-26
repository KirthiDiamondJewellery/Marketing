import { ToolError } from "@attentionos/core";
import { ApprovalError, MigrationError, SeedError } from "@attentionos/db";
import { RunnerError } from "@attentionos/runner";
import { WorkspaceError } from "@attentionos/runtime";
import { CronError } from "@attentionos/worker";
import { ui } from "./ui.ts";

/** A problem the user can fix; printed without a stack trace. */
export class UserError extends Error {
  constructor(message: string, public readonly fix?: string) {
    super(message);
    this.name = "UserError";
  }
}

const KNOWN = [UserError, WorkspaceError, RunnerError, MigrationError, SeedError, ApprovalError, CronError, ToolError];

/** Prints an error in plain language and returns the exit code. Stack traces only with --debug. */
export function reportError(err: unknown, debug: boolean): number {
  const known = KNOWN.some((k) => err instanceof k);
  if (known) {
    const e = err as Error & { fix?: string; hint?: string };
    ui.error(e.message, e.fix ?? e.hint);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    ui.error(`Something went wrong: ${message}`, debug ? undefined : "Run the command again with --debug to see the details.");
  }
  if (debug && err instanceof Error && err.stack) process.stderr.write(`\n${err.stack}\n`);
  return 1;
}
