import { startWorker } from "@attentionos/worker";
import { parseCommand } from "../args.ts";
import { UserError } from "../errors.ts";
import { ui } from "../ui.ts";
import { openWorkspace, printModuleWarnings, type CliContext } from "../workspace.ts";

export const WORKER_HELP = `Start Autopilot: runs scheduled jobs, queued work and incoming webhooks in the background.

Usage
  attentionos worker [--port 8787] [--no-webhooks] [--concurrency 2] [--user-slots 1]

Work you ask for (chat, uploads, "Ask the AI") goes to the front of the queue and is picked up the moment you ask.
--concurrency sets the jobs it runs at once; --user-slots adds slots only your own requests may use, so they start
right away even while long background jobs run (0 turns that off). Both can also be set in the config (runner).

Keep it running (a terminal, a VPS or Docker). Stop it with Ctrl-C; running jobs are finished or put back in the queue.
`;

export async function runWorker(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseCommand("worker", argv, {
    port: { type: "string" },
    "no-webhooks": { type: "boolean", default: false },
    concurrency: { type: "string" },
    "user-slots": { type: "string" },
  });
  if (values.help) {
    ui.out(WORKER_HELP);
    return 0;
  }
  const port = values["no-webhooks"] ? null : values.port !== undefined ? Number(values.port) : undefined;
  if (port !== undefined && port !== null && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new UserError("--port must be a port number, e.g. 8787.");
  const concurrency = values.concurrency !== undefined ? Number(values.concurrency) : undefined;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 16)) throw new UserError("--concurrency must be between 1 and 16.");
  const userSlots = values["user-slots"] !== undefined ? Number(values["user-slots"]) : undefined;
  if (userSlots !== undefined && !(Number.isInteger(userSlots) && userSlots >= 0 && userSlots <= 4)) throw new UserError("--user-slots must be between 0 and 4.");

  const { ws, modules } = await openWorkspace(ctx, { logLevel: "info" });
  printModuleWarnings(modules);
  const worker = await startWorker({ ws, modules: modules.modules, webhookPort: port, concurrency, userSlots });
  ui.title(`Autopilot is running for ${ws.config.workspace.name}`);
  ui.ok(
    ws.config.mode === "autopilot" ? "Scheduled AI and data jobs" : "AI jobs when you ask (chat, Run now); scheduled data jobs",
    `AI runs on ${ws.config.runner.engine === "api" ? "your API key" : "your Claude Code login"}`,
  );
  if (worker.webhookUrl) ui.ok("Webhooks", `${worker.webhookUrl}/webhooks/<provider>`);
  ui.out(ui.dim("  Press Ctrl-C to stop."));

  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      ui.out(`\n  Stopping (${signal})…`);
      void worker.stop(signal).then(resolve);
    };
    process.once("SIGINT", () => stop("Ctrl-C"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
  await ws.close();
  return 0;
}
