import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireJob, runJob } from "@attentionos/runner";
import { parseCommand } from "../args.ts";
import { UserError } from "../errors.ts";
import { ui } from "../ui.ts";
import { openWorkspace, printModuleWarnings, type CliContext } from "../workspace.ts";

export const RUN_HELP = `Run one job now and wait for it.

Usage
  attentionos run <job-id> [--input '<json>' | --input @file.json]

Data jobs (sync, scoring, rendering) run right here. AI jobs run on your Claude Code login (claude -p),
or on ANTHROPIC_API_KEY when the config sets runner.engine = "api".
Example: attentionos run research.own-sync --input '{"limit": 20}'
`;

export function parseInputFlag(value: string | undefined): unknown {
  if (value === undefined) return {};
  const text = value.startsWith("@") ? readInputFile(value.slice(1)) : value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UserError("--input isn't valid JSON.", `Example: --input '{"limit": 20}' (single quotes around the JSON).`);
  }
}

function readInputFile(path: string): string {
  const full = resolve(path);
  if (!existsSync(full)) throw new UserError(`Input file not found: ${path}`);
  return readFileSync(full, "utf8");
}

export async function runRun(argv: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand("run", argv, { input: { type: "string", short: "i" } });
  if (values.help || !positionals[0]) {
    ui.out(RUN_HELP);
    return values.help ? 0 : 1;
  }
  const input = parseInputFlag(values.input as string | undefined);
  const { ws, modules } = await openWorkspace(ctx);
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    printModuleWarnings(modules, true);
    const job = requireJob(modules.modules, positionals[0]);
    ui.out(`${ui.dim("…")} ${job.description}`);
    const result = await runJob(ws, job, input, { modules: modules.modules, signal: controller.signal, actor: "user:local", owner: `cli:${process.pid}` });
    if (result.status === "succeeded" || result.status === "waiting_approval") {
      ui.ok(result.status === "waiting_approval" ? "Done. Waiting for your approval" : "Done", result.costUsd ? `$${result.costUsd.toFixed(2)}` : undefined);
      if (result.output !== undefined && result.output !== null) ui.out(JSON.stringify(result.output, null, 2));
      return 0;
    }
    if (result.status === "deferred") {
      ui.ok("Waiting", `${(result.output as { waiting?: string } | undefined)?.waiting ?? "it will start when what it needs is ready"}. It's back in the queue; Autopilot (attentionos worker) picks it up.`);
      return 0;
    }
    ui.fail(result.status === "cancelled" ? "Stopped" : "That didn't work", result.error);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    await ws.close();
  }
}
