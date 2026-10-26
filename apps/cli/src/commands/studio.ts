import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, relative } from "node:path";
import { loadWorkspace, type LoadedWorkspace, type ModuleResolution } from "@attentionos/runtime";
import { startWorker, type WorkerHandle } from "@attentionos/worker";
import { LIVE_SETTINGS_ENV, SETTINGS_STATUS_FILE, studioEnv, type SettingsStatus } from "../../../studio/src/launch.ts";
import { parseCommand } from "../args.ts";
import { engineRoot, findAsset } from "../assets.ts";
import { createReloader, watchSettings, type ReloadEvent, type SettingsWatcher } from "../live-settings.ts";
import { UserError } from "../errors.ts";
import { exec } from "../shell.ts";
import { ui } from "../ui.ts";
import { cliLogger, openWorkspace, printModuleWarnings, workspaceDir, type CliContext } from "../workspace.ts";
import { setEnvValue } from "./doctor.ts";
import { VERSION } from "./update.ts";

export const DEFAULT_STUDIO_PORT = 4747;
export const MIN_TOKEN_LENGTH = 24;

// ───────────────────────────── Addresses ─────────────────────────────

export type AddressKind = "loopback" | "wildcard" | "tailscale" | "private" | "link-local" | "public";

function ipv4Parts(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map(Number);
}

/** What kind of address Studio would listen on. Hostnames other than localhost and *.ts.net count as public. */
export function classifyHost(host: string): AddressKind {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "*") return "wildcard";
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return "loopback";
  const v4 = ipv4Parts(h.startsWith("::ffff:") ? h.slice(7) : h);
  if (v4) {
    const [a = 0, b = 0] = v4;
    if (a === 127) return "loopback";
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 169 && b === 254) return "link-local";
    return "public";
  }
  if (isIP(h) === 6) {
    if (h.startsWith("fd7a:115c:a1e0:")) return "tailscale";
    if (/^f[cd]/.test(h)) return "private";
    if (/^fe[89ab]/.test(h)) return "link-local";
    return "public";
  }
  if (h.endsWith(".ts.net")) return "tailscale";
  return "public";
}

export function isLoopback(host: string): boolean {
  return classifyHost(host) === "loopback";
}

/**
 * ATTENTIONOS_STUDIO_AUTH, set in .env or the environment:
 * - "local": no sign-in. Only on 127.0.0.1, or inside the Docker setup (ATTENTIONOS_CONTAINER=1) whose compose file
 *   publishes Studio to 127.0.0.1 on the host only. ("none" is accepted as an older name.)
 * - "tailscale": trust the Tailscale-User-Login header from `tailscale serve`. Only when Studio listens on 127.0.0.1,
 *   so the only way in is through Tailscale; the access key still works for devices without a Tailscale login.
 * - "token": always ask for the access key, even on 127.0.0.1.
 * Unset: no sign-in on 127.0.0.1, the access key anywhere else.
 */
export type StudioAuthMode = "local" | "tailscale" | "token";

export function parseStudioAuthMode(raw: string | undefined): StudioAuthMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "local" || v === "none") return "local";
  if (v === "tailscale" || v === "token") return v;
  throw new UserError(`ATTENTIONOS_STUDIO_AUTH is "${raw}", which I don't know.`, "Use local, tailscale or token, or remove it from .env.");
}

export type BindDecision =
  | { ok: true; auth: "none" | "token"; kind: AddressKind; trustTailscale?: true }
  | { ok: false; message: string; fix: string };

function tokenProblem(token: string | undefined): { ok: false; message: string; fix: string } | null {
  if (!token) return { ok: false, message: "Studio needs an access key to listen beyond this computer.", fix: "Run `attentionos up` once to create one, or set ATTENTIONOS_STUDIO_TOKEN in .env." };
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, message: `The access key is too short (${token.length} characters).`, fix: `Use at least ${MIN_TOKEN_LENGTH} random characters, or delete ATTENTIONOS_STUDIO_TOKEN from .env and run \`attentionos up\` to create one.` };
  }
  return null;
}

/**
 * The rules for where Studio may listen:
 * - loopback: no sign-in (unless forced with ATTENTIONOS_STUDIO_AUTH=token);
 * - Tailscale, private LAN or link-local: sign-in with an access key;
 * - every interface (0.0.0.0) or a public address: only with --allow-public AND an access key;
 * - an explicit mode (see StudioAuthMode) narrows these: "local" only on loopback or in the container,
 *   "tailscale" only on loopback.
 */
export function decideBind(input: { host: string; allowPublic: boolean; token?: string; forceAuth?: boolean; mode?: StudioAuthMode; container?: boolean }): BindDecision {
  const kind = classifyHost(input.host);
  const mode = input.mode ?? (input.forceAuth ? "token" : undefined);
  if ((kind === "wildcard" || kind === "public") && !input.allowPublic) {
    return {
      ok: false,
      message: kind === "wildcard" ? "Listening on every network interface (0.0.0.0) can expose Studio to the internet." : `${input.host} looks like a public address, so anyone could reach Studio.`,
      fix: "Use your Tailscale address instead (the default for `attentionos up`), or add --allow-public if a firewall or Tailscale sidecar keeps it private.",
    };
  }
  if (mode === "local") {
    if (kind === "loopback" || (kind === "wildcard" && input.container)) return { ok: true, auth: "none", kind };
    return {
      ok: false,
      message: "Studio can only skip sign-in (ATTENTIONOS_STUDIO_AUTH=local) on 127.0.0.1, or in the Docker setup that publishes it to 127.0.0.1 only.",
      fix: "Remove ATTENTIONOS_STUDIO_AUTH=local to sign in with the access key, or listen on 127.0.0.1.",
    };
  }
  if (mode === "tailscale") {
    if (kind !== "loopback") {
      return {
        ok: false,
        message: "Tailscale sign-in (ATTENTIONOS_STUDIO_AUTH=tailscale) only works when Studio listens on 127.0.0.1 behind `tailscale serve`.",
        fix: "Start it with --host 127.0.0.1 and run `tailscale serve --bg 4747`, or use ATTENTIONOS_STUDIO_AUTH=token.",
      };
    }
    return tokenProblem(input.token) ?? { ok: true, auth: "token", kind, trustTailscale: true };
  }
  if (kind === "loopback" && mode !== "token") return { ok: true, auth: "none", kind };
  return tokenProblem(input.token) ?? { ok: true, auth: "token", kind };
}

// ───────────────────────────── Tailscale ─────────────────────────────

export type TailscaleInfo = { running: boolean; ipv4?: string; ipv6?: string; dnsName?: string; hostName?: string; tailnet?: string };

/** Reads `tailscale status --json`. Tolerates older and newer field layouts. */
export function parseTailscaleStatus(json: string): TailscaleInfo {
  let data: {
    BackendState?: string;
    Self?: { DNSName?: string; HostName?: string; TailscaleIPs?: string[]; Online?: boolean };
    TailscaleIPs?: string[];
    MagicDNSSuffix?: string;
    CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string };
  };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return { running: false };
  }
  const running = data.BackendState === "Running";
  const ips = data.Self?.TailscaleIPs ?? data.TailscaleIPs ?? [];
  const dnsName = data.Self?.DNSName?.replace(/\.$/, "") || undefined;
  return {
    running,
    ipv4: ips.find((ip) => isIP(ip) === 4),
    ipv6: ips.find((ip) => isIP(ip) === 6),
    dnsName,
    hostName: data.Self?.HostName,
    tailnet: data.CurrentTailnet?.Name ?? data.CurrentTailnet?.MagicDNSSuffix ?? data.MagicDNSSuffix,
  };
}

const TAILSCALE_BINS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];

export async function tailscaleStatus(): Promise<TailscaleInfo | null> {
  for (const bin of TAILSCALE_BINS) {
    const r = await exec(bin, ["status", "--json"], { timeoutMs: 5000 });
    if (r.missing) continue;
    if (!r.stdout.trim()) return { running: false };
    return parseTailscaleStatus(r.stdout);
  }
  return null;
}

// ───────────────────────────── URLs ─────────────────────────────

export type StudioUrl = { url: string; label: string };

function hostPart(h: string): string {
  return isIP(h) === 6 ? `[${h}]` : h;
}

/** Every address someone could open, best first. */
export function studioUrls(host: string, port: number, opts: { tailscale?: TailscaleInfo | null; interfaces?: ReturnType<typeof networkInterfaces> } = {}): StudioUrl[] {
  const kind = classifyHost(host);
  const ts = opts.tailscale?.running ? opts.tailscale : null;
  const urls: StudioUrl[] = [];
  const add = (h: string, label: string) => {
    const url = `http://${hostPart(h)}:${port}`;
    if (!urls.some((u) => u.url === url)) urls.push({ url, label });
  };
  if (kind === "loopback") {
    add("localhost", "This computer");
    return urls;
  }
  if (kind === "wildcard") add("localhost", "This computer");
  const tsMatches = ts && (kind === "wildcard" || host === ts.ipv4 || host === ts.ipv6 || host === ts.dnsName);
  if (tsMatches && ts.dnsName) add(ts.dnsName, "Your tailnet (MagicDNS)");
  if (tsMatches && ts.ipv4) add(ts.ipv4, "Your tailnet");
  if (kind === "wildcard") {
    for (const list of Object.values(opts.interfaces ?? networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.internal || a.family !== "IPv4") continue;
        const k = classifyHost(a.address);
        add(a.address, k === "tailscale" ? "Your tailnet" : k === "private" ? "Your local network" : k === "public" ? "Public address" : "Network");
      }
    }
  } else {
    add(host, kind === "tailscale" ? "Your tailnet" : kind === "private" ? "Your local network" : "This address");
  }
  return urls;
}

// ───────────────────────────── Access key ─────────────────────────────

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The access key from the environment or .env; creates and saves one when `create` is set and none exists. */
export function ensureStudioToken(ws: Pick<LoadedWorkspace, "secret" | "paths">, create: boolean): { token?: string; created: boolean } {
  const existing = ws.secret("ATTENTIONOS_STUDIO_TOKEN")?.trim();
  if (existing || !create) return { token: existing, created: false };
  const token = generateToken();
  setEnvValue(join(ws.paths.root, ".env"), "ATTENTIONOS_STUDIO_TOKEN", token);
  return { token, created: true };
}

// ───────────────────────────── Finding the Studio server ─────────────────────────────

export type StudioLaunch = { kind: "standalone"; serverJs: string } | { kind: "dev"; appDir: string; nextBin: string };

/**
 * The installed package ships the standalone build at dist/assets/studio (server.js under apps/studio, as Next lays
 * out monorepo builds). From source: the repo's standalone build when present (unless --dev), else `next dev`.
 */
export function locateStudio(opts: { dev?: boolean } = {}): StudioLaunch {
  const packaged = findAsset("studio/apps/studio/server.js");
  if (packaged && !opts.dev) return { kind: "standalone", serverJs: packaged };
  const appDir = join(engineRoot(), "apps", "studio");
  if (existsSync(join(appDir, "package.json"))) {
    const distDir = process.env.NEXT_DIST_DIR || ".next";
    const standalone = join(appDir, distDir, "standalone", "apps", "studio");
    const serverJs = join(standalone, "server.js");
    if (!opts.dev && existsSync(serverJs)) {
      // Next leaves static files out of standalone builds; copy them in once.
      const staticSrc = join(appDir, distDir, "static");
      const staticDst = join(standalone, distDir, "static");
      if (existsSync(staticSrc) && !existsSync(staticDst)) cpSync(staticSrc, staticDst, { recursive: true });
      if (existsSync(join(appDir, "public")) && !existsSync(join(standalone, "public"))) cpSync(join(appDir, "public"), join(standalone, "public"), { recursive: true });
      return { kind: "standalone", serverJs };
    }
    const nextBin = join(appDir, "node_modules", "next", "dist", "bin", "next");
    if (existsSync(nextBin)) return { kind: "dev", appDir, nextBin };
  }
  throw new UserError("This AttentionOS install doesn't include Studio.", "Rebuild it from your AttentionOS folder: ./aos update");
}

export function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host === "localhost" ? "127.0.0.1" : host, () => srv.close(() => resolve(true)));
  });
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // no browser here (a server): the printed URL is enough
  }
}

// ───────────────────────────── Running ─────────────────────────────

export type ServeOptions = {
  host: string;
  port: number;
  open: boolean;
  worker: boolean;
  allowPublic: boolean;
  dev?: boolean;
  webhookPort?: number | null;
  concurrency?: number;
  title: string;
  tailscale?: TailscaleInfo | null;
  /** Printed as warnings under the addresses. */
  notes?: string[];
};

export async function serveStudio(ctx: CliContext, opts: ServeOptions): Promise<number> {
  const { host, port } = opts;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new UserError("--port must be a port number, e.g. 4747.");

  // The worker needs providers and modules; Studio alone only needs config, .env and the database.
  const open = async (): Promise<OpenedWorkspace> => {
    if (opts.worker) {
      const opened = await openWorkspace(ctx, { logLevel: "info" });
      return { ...opened, close: () => opened.ws.close() };
    }
    const ws = await loadWorkspace(workspaceDir(ctx), { providers: false, log: cliLogger(ctx) });
    return { ws, close: () => ws.close() };
  };
  const first = await open();
  const ws = first.ws;
  const container = process.env.ATTENTIONOS_CONTAINER === "1";
  // ATTENTIONOS_LIVE_SETTINGS=0 turns off applying saved settings without a restart.
  const live = process.env[LIVE_SETTINGS_ENV] !== "0";

  /** How Studio may listen with this workspace's .env, and the part of Studio's env that comes from the workspace. */
  const studioSettings = (w: LoadedWorkspace, create: boolean) => {
    const mode = parseStudioAuthMode(w.secret("ATTENTIONOS_STUDIO_AUTH"));
    // Refuse a public address before creating anything, then make sure a key exists.
    const existing = w.secret("ATTENTIONOS_STUDIO_TOKEN")?.trim();
    const pre = decideBind({ host, allowPublic: opts.allowPublic, token: existing || "x".repeat(MIN_TOKEN_LENGTH), mode, container });
    if (!pre.ok) throw new UserError(pre.message, pre.fix);
    const { token, created } = ensureStudioToken(w, create && pre.auth === "token");
    const bind = decideBind({ host, allowPublic: opts.allowPublic, token, mode, container });
    if (!bind.ok) throw new UserError(bind.message, bind.fix);
    const trustTailscale = bind.trustTailscale === true || w.secret("ATTENTIONOS_STUDIO_TRUST_TAILSCALE") === "1";
    const env: Record<string, string> = {
      ...studioEnv(w),
      ATTENTIONOS_STUDIO_AUTH: bind.auth,
      ATTENTIONOS_STUDIO_TRUST_TAILSCALE: trustTailscale && bind.kind === "loopback" ? "1" : "0",
    };
    if (token) env.ATTENTIONOS_STUDIO_TOKEN = token;
    const tsUsers = w.secret("ATTENTIONOS_STUDIO_TAILSCALE_USERS");
    if (tsUsers) env.ATTENTIONOS_STUDIO_TAILSCALE_USERS = tsUsers;
    return { bind, token, created, trustTailscale, env };
  };

  /** The Studio server that's serving; undefined while it restarts. */
  let child: ChildProcess | undefined;
  const alive = new Set<ChildProcess>();
  let worker: WorkerHandle | undefined;
  let reloader: Reloader | undefined;
  let watcher: SettingsWatcher | undefined;
  let stopping = false;
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => (finish = resolve));

  const killAll = (signal: NodeJS.Signals) => {
    for (const c of alive) c.kill(signal);
  };
  const stop = (reason: string, code = 0) => {
    if (stopping) {
      // A second Ctrl-C: don't wait for open browser connections.
      killAll("SIGKILL");
      return;
    }
    stopping = true;
    watcher?.close();
    if (code === 0) ui.out(`\n  Stopping (${reason})…`);
    killAll("SIGTERM");
    // Open live streams can hold Studio open; don't wait on them for long.
    setTimeout(() => killAll("SIGKILL"), 5_000).unref();
    void (async () => {
      await reloader?.settled();
      killAll("SIGTERM"); // a Studio a settings reload was starting
      await (reloader ? reloader.state().worker : worker)?.stop(reason).catch(() => {});
      finish(code);
    })();
  };

  try {
    const initial = studioSettings(ws, true);
    const { bind, token, created, trustTailscale } = initial;
    if (!(await portFree(port, host))) {
      throw new UserError(`Port ${port} is already in use${port === DEFAULT_STUDIO_PORT ? " (is Studio already running?)" : ""}.`, `Open the Studio that's running, or pick another port: --port ${port + 1}`);
    }

    // The Docker setup knows the address you open (http://localhost:4747 or your tailnet name), which the
    // container's own addresses wouldn't tell you.
    const publicUrl = process.env.ATTENTIONOS_STUDIO_URL?.trim().replace(/\/+$/, "");
    const tailscale = publicUrl ? null : opts.tailscale !== undefined ? opts.tailscale : bind.kind === "loopback" ? null : await tailscaleStatus();
    const urls = publicUrl ? [{ url: publicUrl, label: "Open Studio" }] : studioUrls(host, port, { tailscale });
    if (trustTailscale && bind.kind !== "loopback") ui.warn("Ignoring ATTENTIONOS_STUDIO_TRUST_TAILSCALE: it's only safe when Studio listens on 127.0.0.1 behind `tailscale serve`.");

    // What stays the same for the life of this process; the workspace part comes from studioSettings().
    const fixedEnv: NodeJS.ProcessEnv = {
      ATTENTIONOS_STUDIO_HOST: host,
      ATTENTIONOS_STUDIO_PORT: String(port),
      ATTENTIONOS_STUDIO_URLS: JSON.stringify(urls),
      ATTENTIONOS_ENGINE_ROOT: engineRoot(),
      ATTENTIONOS_VERSION: VERSION,
      ATTENTIONOS_CLI: JSON.stringify([process.execPath, ...process.execArgv, process.argv[1] ?? ""]),
      ATTENTIONOS_WORKER: opts.worker ? "embedded" : "",
      [LIVE_SETTINGS_ENV]: live ? "1" : "0",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(port),
      HOSTNAME: host === "localhost" ? "127.0.0.1" : host,
    };

    const launch = locateStudio({ dev: opts.dev });
    const probe = `http://${hostPart(bind.kind === "wildcard" || bind.kind === "loopback" ? "127.0.0.1" : host)}:${port}`;
    const healthTimeout = launch.kind === "dev" ? 120_000 : 45_000;

    const spawnStudio = (wsEnv: Record<string, string>): ChildProcess => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...fixedEnv, ...wsEnv };
      if (!wsEnv.ATTENTIONOS_STUDIO_TOKEN) delete env.ATTENTIONOS_STUDIO_TOKEN;
      const c =
        launch.kind === "standalone"
          ? spawn(process.execPath, [launch.serverJs], { cwd: dirname(launch.serverJs), env: { ...env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] })
          : spawn(process.execPath, [launch.nextBin, "dev", "-p", String(port), "-H", env.HOSTNAME!], { cwd: launch.appDir, env, stdio: ["ignore", "pipe", "pipe"] });
      alive.add(c);
      // Next prints its own banner; show it only with --debug. Errors always come through.
      c.stdout?.on("data", (d: Buffer) => {
        if (ctx.debug) process.stdout.write(d);
      });
      c.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
      c.once("exit", (code, signal) => {
        alive.delete(c);
        // Only the Studio that's serving counts: one being replaced by a settings reload is meant to stop.
        if (stopping || c !== child) return;
        // Ctrl-C reaches Studio too (same terminal); a clean exit means it's stopping with us.
        if (code === 0 || signal) return stop(signal === "SIGTERM" ? "SIGTERM" : "Ctrl-C");
        ui.error(`Studio stopped unexpectedly (exit code ${code}).`, "Run the command again with --debug to see why.");
        stop("studio exited", 1);
      });
      return c;
    };

    /** Stops the serving Studio, waits for it to exit (freeing the port), then starts one with this env. */
    const restartStudio = async (wsEnv: Record<string, string>) => {
      const old = child;
      child = undefined;
      if (old && old.exitCode === null && old.signalCode === null) {
        const exited = once(old, "exit");
        old.kill("SIGTERM");
        // Open live streams can hold it open; the browser reconnects on its own.
        const kill = setTimeout(() => old.kill("SIGKILL"), 3_000);
        await exited;
        clearTimeout(kill);
      }
      if (stopping) throw new UserError("AttentionOS is stopping.");
      const next = spawnStudio(wsEnv);
      if (!(await waitForHealth(probe, next, healthTimeout)) || stopping) {
        next.kill("SIGKILL");
        throw new UserError("Studio didn't start.", "Run the command again with --debug to see why.");
      }
      child = next;
    };

    const firstChild = spawnStudio(initial.env);
    if (!(await waitForHealth(probe, firstChild, healthTimeout))) {
      throw new UserError("Studio didn't start.", "Run the command again with --debug to see why.");
    }
    child = firstChild;

    const startWorkerFor = (o: OpenedWorkspace) => startWorker({ ws: o.ws, modules: o.modules!.modules, webhookPort: opts.webhookPort, concurrency: opts.concurrency });
    if (opts.worker && first.modules) {
      printModuleWarnings(first.modules);
      worker = await startWorkerFor(first);
    }

    if (live) {
      const files = [ws.paths.config, join(ws.paths.root, ".env")];
      reloader = createReloader<OpenedWorkspace>(
        { ws: first, worker, studioEnv: initial.env },
        {
          load: async () => {
            const next = await open();
            try {
              return { ws: next, studioEnv: studioSettings(next.ws, false).env };
            } catch (err) {
              await next.close();
              throw err;
            }
          },
          refuse: (current, next) =>
            current.ws.id === next.ws.id ? null : { message: "Your settings now point at a different workspace.", fix: "Restart AttentionOS to switch workspaces." },
          startWorker: opts.worker ? startWorkerFor : undefined,
          restartStudio,
          stopping: () => stopping,
          report: (event) => reportReload(event, ws.paths.root, Boolean(opts.worker)),
        },
      );
      const r = reloader;
      watcher = watchSettings({
        files,
        onChange: async (changed) => {
          await r.reload(changed);
        },
        onError: (err) => {
          ui.error(`Studio couldn't restart with your settings: ${err instanceof Error ? err.message : String(err)}`, "Run the command again with --debug to see why.");
          stop("studio exited", 1);
        },
      });
    }

    ui.title(`${opts.title} for ${ws.config.workspace.name}`);
    for (const u of urls) ui.ok(u.label, u.url);
    if (launch.kind === "dev") ui.out(ui.dim("  Running from source with live reload (next dev)."));
    if (bind.auth === "token") {
      if (trustTailscale && bind.kind === "loopback") ui.out(ui.dim("  Devices on your tailnet get in with their Tailscale login; anything else needs the access key."));
      if (created && token) {
        ui.out();
        ui.out(`  ${ui.bold("Your Studio access key")} (shown once, saved to .env as ATTENTIONOS_STUDIO_TOKEN):`);
        ui.out(`    ${ui.code(token)}`);
        ui.out(ui.dim("  Paste it on the sign-in page the first time you open Studio on a device."));
      } else {
        ui.out(ui.dim(container ? "  Sign in with your access key: ./aos access-key prints it." : "  Sign in with your access key: ATTENTIONOS_STUDIO_TOKEN in the workspace .env."));
      }
    }
    if (worker) {
      ui.ok(
        ws.config.mode === "autopilot" ? "Worker: scheduled AI and data jobs, plus anything you ask for" : "Worker: AI jobs when you ask (chat, Run now), scheduled data jobs",
        `AI runs on ${ws.config.runner.engine === "api" ? "your API key" : "your Claude Code login"}`,
      );
      if (worker.webhookUrl) ui.ok("Webhooks", `${worker.webhookUrl}/webhooks/<provider>`);
    }
    for (const note of opts.notes ?? []) ui.warn(note);
    if (live) ui.out(ui.dim("  Settings you save (in Studio or in config/attentionos.config.ts and .env) apply on their own."));
    ui.out(ui.dim("  Press Ctrl-C to stop."));
    if (opts.open) openBrowser(urls[0]!.url);

    process.on("SIGINT", () => stop("Ctrl-C"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGHUP", () => stop("SIGHUP"));
    const exitCode = await finished;
    await Promise.all([...alive].map((c) => once(c, "exit")));
    return exitCode;
  } catch (err) {
    stopping = true;
    watcher?.close();
    killAll("SIGTERM");
    await worker?.stop("startup failed");
    throw err;
  } finally {
    await (reloader?.state().ws ?? first).close();
  }
}

type OpenedWorkspace = { ws: LoadedWorkspace; modules?: ModuleResolution; close(): Promise<void> };
type Reloader = ReturnType<typeof createReloader<OpenedWorkspace>>;

/** Plain-language progress for live settings, plus a note Studio's Settings page reads when they couldn't be applied. */
function reportReload(event: ReloadEvent, root: string, withWorker: boolean): void {
  const statusPath = join(root, ".attentionos", SETTINGS_STATUS_FILE);
  const writeStatus = (message: string, fix?: string) => {
    try {
      mkdirSync(dirname(statusPath), { recursive: true });
      const status: SettingsStatus = { state: "failed", message, ...(fix ? { fix } : {}), at: new Date().toISOString() };
      writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
    } catch {
      // Studio just won't show the note; the terminal has it.
    }
  };
  switch (event.kind) {
    case "applying": {
      try {
        rmSync(statusPath, { force: true });
      } catch {
        // read-only folder: nothing to clear
      }
      const names = event.changed.map((f) => relative(root, f)).join(" and ");
      ui.out(ui.dim(`  ${names} changed. Applying your new settings…`));
      return;
    }
    case "applied":
      ui.ok(
        "Applied your new settings",
        event.workerRestarted && event.studioRestarted ? "Studio and the worker are using them now." : event.workerRestarted ? "The worker is using them now." : event.studioRestarted ? "Studio is using them now." : undefined,
      );
      return;
    case "invalid":
    case "failed":
      ui.warn(`Your new settings weren't applied: ${event.message}`);
      if (event.fix) ui.fix(event.fix);
      ui.out(ui.dim(`  ${withWorker ? "Studio and the worker keep" : "Studio keeps"} running with the previous settings. Save again once it's fixed.`));
      writeStatus(event.message, event.fix);
      return;
    case "aborted":
      return;
  }
}

export const STUDIO_HELP = `Open Studio: the dashboard with the live agent map, approvals, calendar, insights and settings.

Usage
  attentionos studio [--port 4747] [--host 127.0.0.1] [--open] [--worker]

Options
  --port <n>       Port to listen on (default 4747)
  --host <addr>    Address to listen on (default 127.0.0.1, this computer only, no sign-in).
                   Any other address turns on sign-in with an access key (ATTENTIONOS_STUDIO_TOKEN in .env).
  --open           Open Studio in your browser
  --worker         Also run the Autopilot worker in the same process
  --allow-public   Allow 0.0.0.0 or a public address (only behind a firewall or a Tailscale sidecar)

To keep Studio and the worker running on a server or your tailnet, use \`attentionos up\`.
`;

export async function runStudio(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseCommand("studio", argv, {
    port: { type: "string" },
    host: { type: "string" },
    open: { type: "boolean", default: false },
    worker: { type: "boolean", default: false },
    "allow-public": { type: "boolean", default: false },
    dev: { type: "boolean", default: false },
  });
  if (values.help) {
    ui.out(STUDIO_HELP);
    return 0;
  }
  return serveStudio(ctx, {
    host: (values.host as string | undefined) ?? "127.0.0.1",
    port: values.port !== undefined ? Number(values.port) : DEFAULT_STUDIO_PORT,
    open: Boolean(values.open),
    worker: Boolean(values.worker),
    allowPublic: Boolean(values["allow-public"]),
    dev: Boolean(values.dev),
    title: "Studio is running",
  });
}
