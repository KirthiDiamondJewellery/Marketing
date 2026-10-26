import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSql, loadBrandKit, type AttentionOSConfig, type ProviderBase, type Sql } from "@attentionos/core";
import { collectMigrations, coreMigrationsDir, migrationStatus, runMigrations, seedAgents } from "@attentionos/db";
import {
  buildProviderRegistry,
  createSecrets,
  findWorkspaceRoot,
  importOptional,
  loadConfigFile,
  readDotenv,
  resolveModules,
  resolveWorkspaceId,
  workspacePaths,
  type ModuleResolution,
} from "@attentionos/runtime";
import { parseCommand } from "../args.ts";
import { findAsset } from "../assets.ts";
import { confirm, exec, run } from "../shell.ts";
import { ui } from "../ui.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type CheckResult = { status: CheckStatus; label: string; detail?: string; fix?: string };

// 22.18 is the first 22.x that runs TypeScript without flags (the copy-guard hook relies on it).
const MIN_NODE = [22, 18] as const;

export function nodeVersionOk(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function print(r: CheckResult): void {
  const fn = r.status === "pass" ? ui.ok : r.status === "warn" ? ui.warn : r.status === "fail" ? ui.fail : ui.skip;
  fn(r.label, r.detail);
  if (r.fix && r.status !== "pass") ui.fix(r.fix);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)));
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

type MediaState = { dir: string | null; synced: boolean; model?: { installed: boolean; path?: string } };

async function mediaPyState(): Promise<MediaState> {
  const dir = findAsset("media-py");
  if (!dir) return { dir: null, synced: false };
  const version = await exec("uv", ["run", "--project", dir, "--no-sync", "attentionos-media", "version"], { timeoutMs: 30_000 });
  if (!version.ok) return { dir, synced: false };
  const paths = await exec("uv", ["run", "--project", dir, "--no-sync", "attentionos-media", "models", "path"], { input: "{}", timeoutMs: 30_000 });
  try {
    const out = JSON.parse(paths.stdout.trim().split("\n").pop() ?? "{}") as { paths?: Record<string, { installed: boolean; path: string }> };
    const first = Object.values(out.paths ?? {})[0];
    return { dir, synced: true, model: first ? { installed: first.installed, path: first.path } : undefined };
  } catch {
    return { dir, synced: true };
  }
}

type MediaJson = { error?: { message?: string; fix?: string }; text?: string; words?: unknown[]; durationS?: number };

async function mediaPy(dir: string, args: string[], input: unknown, timeoutMs: number): Promise<MediaJson> {
  const r = await exec("uv", ["run", "--project", dir, "--no-sync", "attentionos-media", ...args], { input: JSON.stringify(input), timeoutMs });
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as MediaJson;
  } catch {
    return { error: { message: r.stderr.trim().split("\n").pop() || "no answer from the media tools" } };
  }
}

/**
 * Transcribes a short sample clip end to end. With macOS `say` the clip is real speech and must produce words;
 * elsewhere media-py synthesises a speech-like clip and the check is that transcription runs.
 */
export async function speechTest(mediaDir: string): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), "aos-speech-"));
  try {
    let clip = join(dir, "sample.aiff");
    const spoken = process.platform === "darwin" && (await exec("say", ["-o", clip, "AttentionOS speech test, one two three."])).ok;
    if (!spoken) {
      clip = join(dir, "sample.wav");
      const made = await mediaPy(mediaDir, ["synth"], { output: clip, video: false, leadS: 0.3, tailS: 0.3, script: [{ word: "test", dur: 0.4 }, { pause: 0.2 }, { word: "clip", dur: 0.5 }] }, 60_000);
      if (made.error) return { status: "fail", label: "Speech test", detail: `couldn't make the sample clip: ${made.error.message}`, fix: made.error.fix };
    }
    const started = Date.now();
    const out = await mediaPy(mediaDir, ["asr"], { path: clip }, 180_000);
    if (out.error) return { status: "fail", label: "Speech test failed", detail: out.error.message, fix: out.error.fix ?? "Rerun doctor; if it still fails, see docs/providers/whispercpp.md" };
    if (spoken && !(out.text ?? "").trim()) return { status: "fail", label: "Speech test heard nothing", fix: "Rerun doctor; if it still fails, see docs/providers/whispercpp.md" };
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    return { status: "pass", label: "Transcribed the sample clip", detail: spoken ? `"${(out.text ?? "").trim().slice(0, 60)}" in ${secs}s` : `in ${secs}s` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const DOCTOR_HELP = `Check your AttentionOS setup and explain how to fix anything missing.

Usage
  attentionos doctor [--fix] [--yes]

Options
  --fix    Fix what can be fixed here: install uv and yt-dlp, set up the database, prepare media tools,
           download the speech model, save your Telegram chat id
  --yes    Answer yes to every question (for scripts)
  --test-crm  Send one clearly marked test lead to your CRM so you can map the fields
`;

export async function runDoctor(argv: string[]): Promise<number> {
  const { values } = parseCommand("doctor", argv, {
    fix: { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
    "test-crm": { type: "boolean", default: false },
  });
  if (values.help) {
    ui.out(DOCTOR_HELP);
    return 0;
  }
  const fix = Boolean(values.fix);
  const yes = Boolean(values.yes);
  const results: CheckResult[] = [];
  const report = (r: CheckResult) => {
    results.push(r);
    print(r);
  };

  ui.title("Tools on this computer");
  report(
    nodeVersionOk()
      ? { status: "pass", label: `Node.js ${process.versions.node}` }
      : { status: "fail", label: `Node.js ${process.versions.node} is too old`, fix: "Install Node.js 22 or newer from nodejs.org (the LTS download)." },
  );
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const r = await exec(bin, ["-version"]);
    report(
      r.ok
        ? { status: "pass", label: bin, detail: r.stdout.split("\n")[0]?.split(" ").slice(0, 3).join(" ") }
        : { status: "warn", label: `${bin} not found (needed for editing, level 2)`, fix: process.platform === "darwin" ? "brew install ffmpeg" : "Install ffmpeg with your package manager, e.g. sudo apt install ffmpeg" },
    );
  }
  let uv = await exec("uv", ["--version"]);
  if (!uv.ok && fix && process.platform !== "win32" && (await confirm("Install uv (the Python tool manager) from astral.sh?", { yes }))) {
    await run("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]);
    uv = await exec("uv", ["--version"]);
    if (!uv.ok) ui.warn("uv was installed but isn't on your PATH yet", "open a new terminal and run doctor again");
  }
  report(uv.ok ? { status: "pass", label: "uv", detail: uv.stdout.trim() } : { status: "warn", label: "uv not found (needed for editing, level 2)", fix: "attentionos doctor --fix installs it" });

  let ytdlp = await exec("yt-dlp", ["--version"]);
  if (!ytdlp.ok && fix && uv.ok && (await confirm("Install yt-dlp (downloads TikTok and YouTube posts for research) with uv?", { yes }))) {
    await run("uv", ["tool", "install", "yt-dlp"]);
    ytdlp = await exec("yt-dlp", ["--version"]);
    if (!ytdlp.ok) ui.warn("yt-dlp was installed but isn't on your PATH yet", "run `uv tool update-shell`, open a new terminal and run doctor again");
  }
  report(
    ytdlp.ok
      ? { status: "pass", label: "yt-dlp", detail: ytdlp.stdout.trim() }
      : { status: "warn", label: "yt-dlp not found (TikTok and YouTube research, teardowns)", fix: uv.ok ? "attentionos doctor --fix installs it" : "Install uv first (doctor --fix), or: pip install yt-dlp" },
  );

  if (uv.ok) {
    let media = await mediaPyState();
    if (media.dir && !media.synced && fix && (await confirm("Set up the media tools (Python packages, a few minutes)?", { yes, fallback: false }))) {
      await run("uv", ["sync", "--project", media.dir]);
      media = await mediaPyState();
    }
    if (!media.dir) report({ status: "skip", label: "Media tools", detail: "not shipped with this install" });
    else report(media.synced ? { status: "pass", label: "Media tools (media-py)" } : { status: "warn", label: "Media tools aren't set up", fix: "attentionos doctor --fix" });
    if (media.synced && media.model && !media.model.installed && fix && (await confirm("Download the speech-to-text model (about 500 MB)?", { yes }))) {
      await run("uv", ["run", "--project", media.dir!, "attentionos-media", "models", "download"]);
      media = await mediaPyState();
    }
    if (media.synced && media.model) {
      report(media.model.installed ? { status: "pass", label: "Speech-to-text model" } : { status: "warn", label: "Speech-to-text model not downloaded", fix: "attentionos doctor --fix (about 500 MB)" });
      report(media.model.installed ? await speechTest(media.dir!) : { status: "skip", label: "Speech test", detail: "skipped until the speech model is downloaded" });
    }
  }

  const claude = await exec("claude", ["--version"]);
  report(
    claude.ok
      ? { status: "pass", label: "Claude Code", detail: claude.stdout.trim() }
      : { status: "fail", label: "Claude Code not found", fix: "Install it: npm install -g @anthropic-ai/claude-code (then run `claude` once to sign in)" },
  );
  if (claude.ok) {
    // The default engine runs your agents on this login (`claude -p`), so it must be signed in.
    const auth = await exec("claude", ["auth", "status"]);
    let loggedIn = false;
    try {
      loggedIn = Boolean((JSON.parse(auth.stdout) as { loggedIn?: boolean }).loggedIn);
    } catch {
      loggedIn = false;
    }
    report(
      loggedIn
        ? { status: "pass", label: "Claude Code is signed in", detail: "your agents run on this login" }
        : {
            status: "fail",
            label: "Claude Code isn't signed in",
            // In the Docker install the sign-in token lives in the stack's .env; `./aos claude-login` makes and saves one.
            fix: process.env.ATTENTIONOS_CONTAINER === "1" ? "From your AttentionOS folder run ./aos claude-login and approve in the browser" : "Run `claude` once and sign in with your Claude account",
          },
    );
  }

  ui.title("Workspace");
  const root = findWorkspaceRoot((values.workspace as string | undefined) ?? process.cwd());
  if (!root) {
    report({ status: "fail", label: "No workspace in this folder", fix: "cd into your workspace folder (the stack's workspace/), or start AttentionOS with ./aos start to create one" });
    return summary(results);
  }
  const paths = workspacePaths(root);
  if (!existsSync(join(root, ".env")) && existsSync(join(root, ".env.example")) && fix) copyFileSync(join(root, ".env.example"), join(root, ".env"));
  const secret = createSecrets(readDotenv(root));
  report(existsSync(join(root, ".env")) ? { status: "pass", label: ".env file" } : { status: "fail", label: "No .env file", fix: "Copy .env.example to .env and fill in DATABASE_URL" });

  let config: AttentionOSConfig | null = null;
  try {
    config = await loadConfigFile(paths.config);
    report({ status: "pass", label: "Settings (config/attentionos.config.ts)", detail: `${config.mode} mode, preset ${config.workspace.preset}` });
  } catch (err) {
    report({ status: "fail", label: "Settings have a problem", detail: (err as Error).message, fix: (err as { fix?: string }).fix });
  }
  try {
    const kit = loadBrandKit(paths.brand);
    const missing = ["voice", "icp", "offers", "pillars"].filter((d) => !kit.docs[d]?.trim());
    report(missing.length ? { status: "warn", label: "Brand Kit is incomplete", detail: `missing ${missing.join(", ")}`, fix: "Run /attention:init in Claude Code" } : { status: "pass", label: "Brand Kit", detail: kit.brand.name });
  } catch (err) {
    report({ status: "fail", label: "Brand Kit has a problem", detail: (err as Error).message, fix: "Fix the file named above, or run /attention:init in Claude Code" });
  }

  let modules: ModuleResolution | null = null;
  if (config) {
    modules = await resolveModules(config, { search: { workspaceRoot: root } });
    const errors = modules.problems.filter((p) => p.severity === "error");
    report(errors.length ? { status: "fail", label: "Modules", detail: errors.map((e) => e.message).join(" "), fix: errors[0]?.fix } : { status: "pass", label: "Modules", detail: modules.modules.map((m) => m.manifest.id).join(", ") || "none installed" });
    for (const w of modules.problems.filter((p) => p.severity === "warning")) report({ status: "warn", label: w.message, fix: w.fix });
  }

  ui.title("Database");
  const url = secret("DATABASE_URL");
  if (!url) {
    report({ status: "fail", label: "DATABASE_URL is not set", fix: "Add DATABASE_URL to .env: a Postgres connection string (postgresql://user:password@host:5432/db). The Docker install sets it for you" });
  } else {
    const sql: Sql = createSql(url, { max: 2 });
    try {
      const ping = await withTimeout(sql`select 1`.then(() => true).catch((e: unknown) => e as Error), 15_000);
      if (ping !== true) {
        report({ status: "fail", label: "Can't reach the database", detail: ping === "timeout" ? "timed out" : (ping as Error).message, fix: process.env.ATTENTIONOS_CONTAINER === "1" ? "Restart AttentionOS: ./aos restart (from your AttentionOS folder)" : "Check DATABASE_URL in .env and that the database is running (for development: pnpm db:start)" });
      } else {
        report({ status: "pass", label: "Database connection" });
        const moduleDirs = (modules?.modules ?? []).filter((m) => m.migrationsDir).map((m) => ({ dir: m.migrationsDir!, source: m.manifest.id }));
        const files = collectMigrations([{ dir: coreMigrationsDir(), source: "core" }, ...moduleDirs]);
        let status = await migrationStatus(sql, files);
        if (status.pending.length && fix) {
          await runMigrations(sql, { moduleDirs });
          if (config) {
            const ws = await resolveWorkspaceId(sql, config, true);
            await seedAgents(sql, ws.id, config);
          }
          status = await migrationStatus(sql, files);
        }
        if (status.changed.length) report({ status: "fail", label: "Database changes were edited after they ran", detail: status.changed.map((c) => c.name).join(", "), fix: "Restore the original migration files (reinstall attentionos)" });
        else if (status.pending.length) report({ status: "fail", label: `${status.pending.length} database update(s) not applied`, fix: "attentionos db push (or doctor --fix)" });
        else report({ status: "pass", label: "Database is up to date", detail: `${status.applied.length} migrations` });
      }
    } finally {
      await sql.end({ timeout: 2 });
    }
  }

  if (config) {
    ui.title("Services");
    const { providers, diagnostics } = await buildProviderRegistry(config, { config, secret, log: silent, search: { workspaceRoot: root }, mediaDir: paths.media, trendKinds: [] });
    const checked = new Set<unknown>();
    for (const d of diagnostics) {
      if (d.status === "none") continue;
      const label = `${d.kind}: ${d.choice}`;
      if (d.status === "not_installed") {
        report({ status: "fail", label: `${label} isn't installed`, fix: `npm install ${d.package} in this folder` });
        continue;
      }
      if (d.status === "failed") {
        report({ status: "fail", label: `${label} failed to start`, detail: d.detail });
        continue;
      }
      const instance = (providers as Record<string, unknown>)[d.kind] as ProviderBase | undefined;
      if (!instance || checked.has(instance)) continue;
      checked.add(instance);
      const health = await withTimeout(instance.health().catch((e: unknown) => ({ ok: false, detail: (e as Error).message, fix: undefined })), 15_000);
      if (health === "timeout") report({ status: "warn", label, detail: "didn't answer in 15 s" });
      else report(health.ok ? { status: "pass", label, detail: health.detail } : { status: "fail", label, detail: health.detail, fix: health.fix });
    }
    if (config.providers.notifier === "telegram") {
      const token = secret("TELEGRAM_BOT_TOKEN");
      let chat = secret("TELEGRAM_CHAT_ID");
      const notifier = providers.notifier as (ProviderBase & { discoverChats?: () => Promise<{ id: string; type?: string }[]> }) | undefined;
      if (token && !chat && notifier?.discoverChats) {
        const chats = await notifier.discoverChats().catch(() => []);
        const pick = chats.find((c) => c.type === "private") ?? chats[0];
        if (!pick) {
          ui.warn("No messages to your Telegram bot yet", "send it any message, then run doctor again");
        } else if (await confirm(`Found your Telegram chat (${pick.id}). Save it as TELEGRAM_CHAT_ID in .env?`, { yes: yes || fix })) {
          setEnvValue(join(root, ".env"), "TELEGRAM_CHAT_ID", pick.id);
          chat = pick.id;
          ui.ok("Saved TELEGRAM_CHAT_ID to .env");
        } else {
          ui.fix(`Your chat id is ${pick.id}: add TELEGRAM_CHAT_ID=${pick.id} to .env`);
        }
      }
      if (!notifier || !token || !chat) {
        report(
          token && chat
            ? { status: "pass", label: "Telegram bot token and chat id" }
            : { status: "warn", label: `Telegram ${token ? "chat id" : "bot token"} missing`, fix: token ? "Message your bot once, then run attentionos doctor --fix" : "Create a bot with @BotFather and put the token in .env as TELEGRAM_BOT_TOKEN" },
        );
      }
    }
    if (providers.crm) {
      // Never sent silently: only with --test-crm, or when the user says yes during --fix.
      const wanted = Boolean(values["test-crm"]) || (fix && (await confirm("Send one clearly marked test lead to your CRM so you can map the fields?", { fallback: false })));
      if (!wanted) ui.skip(`CRM: ${config.providers.crm}`, "run doctor --test-crm to send a test lead");
      if (wanted) {
        const sent = await providers.crm.upsertLead(TEST_LEAD).then((r) => ({ ok: true as const, id: r.id }), (e: unknown) => ({ ok: false as const, error: (e as Error).message }));
        report(sent.ok ? { status: "pass", label: "Sent a test lead to your CRM", detail: `look for "${TEST_LEAD.name}"` } : { status: "fail", label: "The test lead didn't arrive", detail: sent.error, fix: "Check the CRM settings in .env (see docs/providers/crm.md)" });
      }
    }
    if (config.runner.engine === "api") {
      report(secret("ANTHROPIC_API_KEY") ? { status: "pass", label: "Anthropic API key (API engine)" } : { status: "fail", label: "The API engine needs ANTHROPIC_API_KEY", fix: 'Add it to .env, or set runner: { engine: "claude-code" } to use your Claude Code login' });
      const sdk = await importOptional("@anthropic-ai/claude-agent-sdk", { workspaceRoot: root, engineRoot: null });
      report(sdk.ok ? { status: "pass", label: "Claude Agent SDK" } : { status: "fail", label: "Claude Agent SDK isn't installed", fix: "npm install @anthropic-ai/claude-agent-sdk in this folder" });
    }
  }
  return summary(results);
}

/** Sets KEY=value in a .env file, replacing an existing (even empty) line or appending one. */
export function setEnvValue(path: string, key: string, value: string): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(path, re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
}

/** No real person's data: clearly a test, safe to delete. */
export const TEST_LEAD = {
  name: "AttentionOS test lead",
  email: "test-lead@example.com",
  source: "attentionos doctor",
  keyword: "TEST",
  utmContent: "doctor_test",
  temperature: "cold" as const,
  notes: "Sent by `attentionos doctor` to check the connection. Safe to delete.",
};

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function summary(results: CheckResult[]): number {
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  ui.out();
  if (failed) ui.out(`${failed} problem${failed === 1 ? "" : "s"} to fix${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}. Follow the arrows above, then run ${ui.code("attentionos doctor")} again.`);
  else if (warned) ui.out(`Ready, with ${warned} warning${warned === 1 ? "" : "s"} for later setup levels.`);
  else ui.out("Everything looks good.");
  ui.out();
  return failed ? 1 : 0;
}
