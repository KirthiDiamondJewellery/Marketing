import { parseCommand } from "../args.ts";
import { UserError } from "../errors.ts";
import { ui } from "../ui.ts";
import type { CliContext } from "../workspace.ts";
import { DEFAULT_STUDIO_PORT, serveStudio, tailscaleStatus, type TailscaleInfo } from "./studio.ts";

export const UP_HELP = `Run AttentionOS around the clock: Studio and the Autopilot worker in one process.

Usage
  attentionos up [--host <addr>] [--port 4747] [--no-webhooks] [--webhook-port 8787] [--concurrency 2]

Where Studio listens
  With Tailscale running, on this machine's Tailscale address, so only your own devices can open it.
  Without Tailscale, on 127.0.0.1 (this machine only).
  Away from 127.0.0.1, Studio asks for an access key. The first run creates one, saves it to .env as
  ATTENTIONOS_STUDIO_TOKEN and prints it once.

Options
  --host <addr>       Listen somewhere else. 0.0.0.0 or a public address also needs --allow-public.
  --allow-public      Allow 0.0.0.0 or a public address (inside Docker behind a Tailscale sidecar, or a firewall)
  --open              Open Studio in your browser
  --no-webhooks       Don't start the webhook receiver
  --webhook-port <n>  Port for webhooks (default 8787)
  --concurrency <n>   Jobs at once (default 2)

The Docker stack runs this for you and keeps it running: see docs/install.md.
`;

/** Where `up` listens by default: the Tailscale IPv4 when Tailscale is up, else loopback. */
export function defaultUpHost(ts: TailscaleInfo | null): string {
  return ts?.running && ts.ipv4 ? ts.ipv4 : "127.0.0.1";
}

export async function runUp(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseCommand("up", argv, {
    port: { type: "string" },
    host: { type: "string" },
    open: { type: "boolean", default: false },
    "allow-public": { type: "boolean", default: false },
    "no-webhooks": { type: "boolean", default: false },
    "webhook-port": { type: "string" },
    concurrency: { type: "string" },
  });
  if (values.help) {
    ui.out(UP_HELP);
    return 0;
  }
  const webhookPort = values["no-webhooks"] ? null : values["webhook-port"] !== undefined ? Number(values["webhook-port"]) : undefined;
  if (typeof webhookPort === "number" && !(Number.isInteger(webhookPort) && webhookPort > 0 && webhookPort < 65536)) throw new UserError("--webhook-port must be a port number, e.g. 8787.");
  const concurrency = values.concurrency !== undefined ? Number(values.concurrency) : undefined;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 16)) throw new UserError("--concurrency must be between 1 and 16.");

  const tailscale = await tailscaleStatus();
  const host = (values.host as string | undefined) ?? defaultUpHost(tailscale);
  const notes: string[] = [];
  if (!values.host && !tailscale?.running) {
    notes.push(
      tailscale
        ? "Tailscale is installed but not connected, so Studio only listens on this computer. Run `tailscale up`, then restart."
        : "Tailscale isn't installed, so Studio only listens on this computer. Install it (tailscale.com/download) to open Studio from your phone.",
    );
  }
  return serveStudio(ctx, {
    host,
    port: values.port !== undefined ? Number(values.port) : DEFAULT_STUDIO_PORT,
    open: Boolean(values.open),
    worker: true,
    allowPublic: Boolean(values["allow-public"]),
    webhookPort,
    concurrency,
    title: "AttentionOS is up",
    tailscale,
    notes,
  });
}
