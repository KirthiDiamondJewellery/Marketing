import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { createJiti } from "jiti";
import { configSchema, type AttentionOSConfig } from "@attentionos/core";

/**
 * Settings: reading and safely editing the workspace's `config/attentionos.config.ts` and `.env`.
 *
 * The config is TypeScript the user owns, so Studio never rewrites it wholesale. It edits one literal at a time
 * (a string, number or boolean at a known path), re-loads the edited file the way the CLI does (jiti) into a temp copy,
 * validates it with the config schema, checks the value landed where intended, and only then swaps the file in.
 * Anything it can't edit unambiguously (a value set by a variable, a spread, duplicate keys) is refused with a hint
 * to edit the file by hand.
 *
 * No `server-only` import: tests import this file directly. Only server code imports it.
 */

export const CONFIG_REL = "config/attentionos.config.ts";

// ───────────────────────────── Config source scanner ─────────────────────────────

type Tok = { t: "punct" | "str" | "num" | "ident" | "tpl" | "other"; v: string; s: number; e: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const s = i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") i++;
        if (src[i] === "\n") break;
        i++;
      }
      i++;
      out.push({ t: "str", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (c === "`") {
      const s = i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (depth === 0 && src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (depth > 0 && src[i] === "}") depth--;
        i++;
      }
      i++;
      out.push({ t: "tpl", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const s = i;
      while (i < n && /[0-9a-fA-FxXoObBeE._]/.test(src[i]!)) {
        if ((src[i] === "e" || src[i] === "E") && (src[i + 1] === "-" || src[i + 1] === "+")) i++;
        i++;
      }
      out.push({ t: "num", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i]!)) i++;
      out.push({ t: "ident", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
      out.push({ t: "punct", v: "...", s: i, e: i + 3 });
      i += 3;
      continue;
    }
    out.push({ t: "{}[](),:".includes(c) ? "punct" : "other", v: c, s: i, e: i + 1 });
    i++;
  }
  return out;
}

type ObjInfo = { open: number; close: number; dynamic: boolean; count: number };
type Entry = { start: number; end: number; tokens: Tok[] };
type ScanResult = { objects: Map<string, ObjInfo[]>; entries: Map<string, Entry[]> };

function unquote(tok: Tok): string | null {
  if (tok.t === "ident") return tok.v;
  if (tok.t === "str") {
    try {
      return tok.v.startsWith("'") ? (JSON.parse(`"${tok.v.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string) : (JSON.parse(tok.v) as string);
    } catch {
      return null;
    }
  }
  if (tok.t === "num") return tok.v;
  return null;
}

function skipBalanced(toks: Tok[], i: number): number {
  const open = toks[i]!.v;
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0;
  for (; i < toks.length; i++) {
    const v = toks[i]!.t === "punct" ? toks[i]!.v : "";
    if (v === "{" || v === "[" || v === "(") depth++;
    else if (v === "}" || v === "]" || v === ")") {
      depth--;
      if (depth === 0) {
        if (v !== close) return -1;
        return i;
      }
    }
  }
  return -1;
}

/** Finds the object literal passed to `defineConfig(...)` or exported as default. */
function findRoot(toks: Tok[]): number[] {
  const roots: number[] = [];
  for (let i = 0; i < toks.length - 2; i++) {
    const a = toks[i]!;
    const b = toks[i + 1]!;
    const c = toks[i + 2]!;
    if (a.t === "ident" && a.v === "defineConfig" && b.v === "(" && c.v === "{") roots.push(i + 2);
    else if (a.t === "ident" && a.v === "default" && toks[i - 1]?.v === "export" && b.v === "{") roots.push(i + 1);
  }
  return roots;
}

function scanObject(toks: Tok[], i: number, path: string[], res: ScanResult): number {
  const key = path.join(".");
  const info: ObjInfo = { open: i, close: -1, dynamic: false, count: 0 };
  const list = res.objects.get(key) ?? [];
  list.push(info);
  res.objects.set(key, list);
  i++;
  while (i < toks.length) {
    const tok = toks[i]!;
    if (tok.v === "}" && tok.t === "punct") {
      info.close = i;
      return i;
    }
    if (tok.v === "," && tok.t === "punct") {
      i++;
      continue;
    }
    // Spread, computed key, method or shorthand: the object's contents aren't plain data.
    const name = unquote(tok);
    if (tok.v === "..." || tok.v === "[" || name === null || toks[i + 1]?.v !== ":") {
      info.dynamic = true;
      // Skip to the next comma or closing brace at this depth.
      while (i < toks.length && !(toks[i]!.t === "punct" && (toks[i]!.v === "," || toks[i]!.v === "}"))) {
        if (toks[i]!.t === "punct" && "{[(".includes(toks[i]!.v)) {
          const j = skipBalanced(toks, i);
          if (j === -1) throw new Error("unbalanced");
          i = j;
        }
        i++;
      }
      continue;
    }
    info.count++;
    i += 2; // key and colon
    const valueTok = toks[i];
    if (!valueTok) throw new Error("unexpected end");
    const childPath = [...path, name];
    if (valueTok.t === "punct" && valueTok.v === "{") {
      i = scanObject(toks, i, childPath, res) + 1;
      continue;
    }
    const startIdx = i;
    while (i < toks.length && !(toks[i]!.t === "punct" && (toks[i]!.v === "," || toks[i]!.v === "}"))) {
      if (toks[i]!.t === "punct" && "{[(".includes(toks[i]!.v)) {
        const j = skipBalanced(toks, i);
        if (j === -1) throw new Error("unbalanced");
        i = j;
      }
      i++;
    }
    const valueToks = toks.slice(startIdx, i);
    const entryKey = childPath.join(".");
    const entries = res.entries.get(entryKey) ?? [];
    entries.push({ start: valueToks[0]!.s, end: valueToks.at(-1)!.e, tokens: valueToks });
    res.entries.set(entryKey, entries);
  }
  throw new Error("unclosed object");
}

function scanConfig(src: string): ScanResult | string {
  const toks = lex(src);
  const roots = findRoot(toks);
  if (roots.length !== 1) return roots.length ? "the file exports more than one settings object" : "couldn't find `defineConfig({ ... })` in the file";
  const res: ScanResult = { objects: new Map(), entries: new Map() };
  try {
    scanObject(toks, roots[0]!, [], res);
  } catch {
    return "couldn't read the structure of the file";
  }
  return res;
}

export type Scalar = string | number | boolean;

function literal(value: Scalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("not a finite number");
    return String(value);
  }
  return value ? "true" : "false";
}

function isScalarLiteral(tokens: Tok[]): boolean {
  if (tokens.length === 1) {
    const t = tokens[0]!;
    return t.t === "str" || t.t === "num" || (t.t === "ident" && (t.v === "true" || t.v === "false"));
  }
  return tokens.length === 2 && tokens[0]!.v === "-" && tokens[1]!.t === "num";
}

function keyText(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

function nested(keys: string[], value: Scalar): string {
  const [first, ...rest] = keys;
  return rest.length ? `${keyText(first!)}: { ${nested(rest, value)} }` : `${keyText(first!)}: ${literal(value)}`;
}

export type EditResult = { ok: true; source: string } | { ok: false; reason: string };

const HAND_EDIT = `Edit ${CONFIG_REL} by hand, then run \`attentionos doctor\`.`;

/**
 * Sets one scalar at `path` (e.g. ["budgets", "dailyUsd"]) by replacing its literal in the source, or by inserting it
 * into the closest existing parent object. Comments, formatting and every other line are left untouched.
 */
export function editConfigSource(source: string, path: string[], value: Scalar): EditResult {
  if (!path.length || path.some((p) => !p)) return { ok: false, reason: "Empty setting path." };
  const scan = scanConfig(source);
  if (typeof scan === "string") return { ok: false, reason: `Studio ${scan}. ${HAND_EDIT}` };
  const full = path.join(".");

  // Every object along the way must be plain data, or a spread could override what we write.
  for (let d = 0; d < path.length; d++) {
    const objs = scan.objects.get(path.slice(0, d).join("."));
    if (objs && objs.length > 1) return { ok: false, reason: `"${path.slice(0, d).join(".") || "the settings object"}" appears more than once. ${HAND_EDIT}` };
    if (objs?.[0]?.dynamic) return { ok: false, reason: `"${path.slice(0, d).join(".") || "the settings object"}" is built with code (a spread or a variable). ${HAND_EDIT}` };
  }

  const entries = scan.entries.get(full) ?? [];
  if (entries.length > 1) return { ok: false, reason: `"${full}" is set more than once. ${HAND_EDIT}` };
  if (scan.objects.has(full)) return { ok: false, reason: `"${full}" is a group of settings, not a single value.` };
  if (entries.length === 1) {
    const entry = entries[0]!;
    if (!isScalarLiteral(entry.tokens)) return { ok: false, reason: `"${full}" is set by an expression, not a plain value. ${HAND_EDIT}` };
    return { ok: true, source: source.slice(0, entry.start) + literal(value) + source.slice(entry.end) };
  }

  // Not set yet: insert it into the deepest parent object that exists.
  let depth = path.length - 1;
  while (depth > 0 && !scan.objects.has(path.slice(0, depth).join("."))) {
    if (scan.entries.has(path.slice(0, depth).join("."))) return { ok: false, reason: `"${path.slice(0, depth).join(".")}" isn't a plain object. ${HAND_EDIT}` };
    depth--;
  }
  const parent = scan.objects.get(path.slice(0, depth).join("."))![0]!;
  const toks = lex(source);
  const openTok = toks[parent.open]!;
  const closeTok = toks[parent.close]!;
  const prev = toks[parent.close - 1]!;
  const insertion = nested(path.slice(depth), value);
  const indentOf = (pos: number) => /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", pos - 1) + 1))![0];
  const prevLineEnd = source.indexOf("\n", prev.e);
  const multiline = prevLineEnd !== -1 && prevLineEnd < closeTok.s;
  if (multiline) {
    // On its own line after the last entry (after any trailing comment), indented like its siblings.
    const childIndent = parent.count > 0 ? indentOf(toks[parent.open + 1]!.s) : `${indentOf(closeTok.s)}  `;
    const needsComma = prev !== openTok && !(prev.t === "punct" && prev.v === ",");
    const head = source.slice(0, prev.e) + (needsComma ? "," : "") + source.slice(prev.e, prevLineEnd);
    return { ok: true, source: `${head}\n${childIndent}${insertion},${source.slice(prevLineEnd)}` };
  }
  const inner = source.slice(openTok.e, closeTok.s);
  if (!inner.trim()) return { ok: true, source: `${source.slice(0, openTok.e)} ${insertion} ${source.slice(closeTok.s)}` };
  const trimmedEnd = openTok.e + inner.trimEnd().length;
  const hasComma = source[trimmedEnd - 1] === ",";
  return { ok: true, source: `${source.slice(0, trimmedEnd)}${hasComma ? "" : ","} ${insertion} ${source.slice(closeTok.s)}` };
}

// ───────────────────────────── Loading and validating ─────────────────────────────

const SHIM_SOURCE = "export function defineConfig(config) { return config; }\nexport default defineConfig;\n";
let shimDir: string | undefined;

/**
 * The module `attentionos/config` resolves to while loading a config file. It lives in a private folder made for this
 * process (mkdtemp creates it readable by this user only), and its content is written on every call instead of trusting
 * whatever is already there, so no other user on a shared machine can plant code that Studio would run.
 */
function shim(): string {
  if (!shimDir || !existsSync(shimDir)) {
    const dir = mkdtempSync(join(tmpdir(), "attentionos-studio-"));
    shimDir = dir;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  const file = join(shimDir, "config-shim.mjs");
  writeFileSync(file, SHIM_SOURCE, { mode: 0o600 });
  return file;
}

/** Loads a config file the way the CLI does (jiti, with `attentionos/config` aliased to a shim). */
export async function loadConfigAt(file: string): Promise<{ ok: true; config: AttentionOSConfig; raw: unknown } | { ok: false; error: string }> {
  const s = shim();
  const jiti = createJiti(file, {
    alias: { "attentionos/config": s, "@attentionos/core": s, attentionos: s },
    moduleCache: false,
    fsCache: false,
    interopDefault: true,
  });
  let raw: unknown;
  try {
    raw = await jiti.import(file, { default: true });
  } catch (err) {
    return { ok: false, error: `The file has a syntax error: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}` };
  }
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `The settings don't validate: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown problem"}` };
  }
  return { ok: true, config: parsed.data, raw };
}

export function configPath(root: string): string {
  return join(root, CONFIG_REL);
}

export async function readWorkspaceConfig(root: string) {
  return loadConfigAt(configPath(root));
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export type ConfigEdit = { path: string[]; value: Scalar };
export type ApplyResult = { ok: true; config: AttentionOSConfig } | { ok: false; error: string };

/**
 * Applies edits to the config file: text edits, then a re-load of a temp copy (same folder, so relative imports
 * still resolve), schema validation and a check that every value landed, then an atomic rename over the original.
 */
export async function applyConfigEdits(root: string, edits: ConfigEdit[]): Promise<ApplyResult> {
  const file = configPath(root);
  if (!existsSync(file)) return { ok: false, error: `${CONFIG_REL} wasn't found in ${root}.` };
  const original = readFileSync(file, "utf8");
  let source = original;
  for (const edit of edits) {
    const res = editConfigSource(source, edit.path, edit.value);
    if (!res.ok) return { ok: false, error: res.reason };
    source = res.source;
  }
  if (source === original) {
    const current = await loadConfigAt(file);
    return current.ok ? { ok: true, config: current.config } : { ok: false, error: current.error };
  }
  const temp = join(dirname(file), `.attentionos.config.studio-${randomBytes(4).toString("hex")}.ts`);
  writeFileSync(temp, source, { mode: statSync(file).mode & 0o777 });
  try {
    const loaded = await loadConfigAt(temp);
    if (!loaded.ok) return { ok: false, error: `${loaded.error}. Nothing was changed.` };
    for (const edit of edits) {
      if (!isDeepStrictEqual(getPath(loaded.raw, edit.path), edit.value)) {
        return { ok: false, error: `Studio couldn't confirm "${edit.path.join(".")}" was set. Nothing was changed. ${HAND_EDIT}` };
      }
    }
    // The file must not have changed underneath us while we validated.
    if (readFileSync(file, "utf8") !== original) return { ok: false, error: "The settings file changed while saving. Reload and try again." };
    renameSync(temp, file);
    return { ok: true, config: loaded.config };
  } finally {
    rmSync(temp, { force: true });
  }
}

// ───────────────────────────── What Studio may edit ─────────────────────────────

const ACK_KEYS = ["scrapingTerms", "trialReelsRisk", "automatedDmRisk", "remotionLicense"] as const;

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.includes("/") || tz === "UTC";
  } catch {
    return false;
  }
}

/** Validates a requested edit. Returns the clean value, or a plain-language reason it's refused. */
export function validateSetting(pathStr: string, value: unknown): { ok: true; path: string[]; value: Scalar } | { ok: false; error: string } {
  const path = pathStr.split(".");
  const money = (min: number, max: number) => {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return { ok: false as const, error: `Enter an amount between $${min} and $${max}.` };
    return { ok: true as const, path, value: Math.round(n * 100) / 100 };
  };
  switch (pathStr) {
    case "workspace.name": {
      const v = typeof value === "string" ? value.trim() : "";
      if (!v || v.length > 80 || /[\r\n]/.test(v)) return { ok: false, error: "The name must be 1 to 80 characters on one line." };
      return { ok: true, path, value: v };
    }
    case "workspace.timezone": {
      const v = typeof value === "string" ? value.trim() : "";
      if (!isTimezone(v)) return { ok: false, error: "Use a timezone like America/Chicago or Europe/London." };
      return { ok: true, path, value: v };
    }
    case "mode":
      if (value !== "copilot" && value !== "autopilot") return { ok: false, error: "Mode is copilot or autopilot." };
      return { ok: true, path, value };
    case "budgets.perRunUsd":
    case "budgets.dailyUsd":
      return money(0.01, 1000);
    case "budgets.scrapingMonthlyUsd":
    case "budgets.imagesDailyUsd":
      return money(0, 10000);
  }
  if (/^modules\.[a-z][a-z0-9-]{0,40}\.enabled$/.test(pathStr) || (path[0] === "acknowledgements" && path.length === 2 && (ACK_KEYS as readonly string[]).includes(path[1]!))) {
    if (typeof value !== "boolean") return { ok: false, error: "Expected on or off." };
    return { ok: true, path, value };
  }
  return { ok: false, error: `Studio doesn't edit "${pathStr}". ${HAND_EDIT}` };
}

// ───────────────────────────── .env keys ─────────────────────────────

export type KeyInfo = { name: string; label: string; purpose: string; where: string; editable: boolean };

/** The connection keys Studio shows. Only these can be written from Studio. */
export const KNOWN_KEYS: KeyInfo[] = [
  { name: "DATABASE_URL", label: "Database", purpose: "Where everything is stored.", where: "Supabase → Project settings → Database → Connection string", editable: false },
  { name: "ANTHROPIC_API_KEY", label: "Anthropic API key", purpose: "Optional: only for the API engine (runner.engine = \"api\"), billed per use. Not needed with Claude Code.", where: "console.anthropic.com → API keys", editable: true },
  { name: "ZERNIO_API_KEY", label: "Zernio", purpose: "Publishing, DMs and analytics (the default).", where: "zernio.com → Settings → API", editable: true },
  { name: "BLOTATO_API_KEY", label: "Blotato", purpose: "Publishing, if you chose Blotato instead of Zernio.", where: "blotato.com → Settings → API", editable: true },
  { name: "APIFY_TOKEN", label: "Apify", purpose: "Competitor research.", where: "apify.com → Settings → Integrations", editable: true },
  { name: "IG_ACCESS_TOKEN", label: "Instagram Graph token", purpose: "Instagram research and analytics without Apify.", where: "Meta for Developers → your app → Instagram Graph API", editable: true },
  { name: "IG_USER_ID", label: "Instagram account id", purpose: "Used with the Instagram Graph token.", where: "Meta for Developers → Graph API explorer", editable: true },
  { name: "TELEGRAM_BOT_TOKEN", label: "Telegram bot", purpose: "Morning brief, alerts and approve buttons.", where: "@BotFather in Telegram", editable: true },
  { name: "TELEGRAM_CHAT_ID", label: "Telegram chat id", purpose: "Which chat the bot writes to.", where: "Message your bot once, then run `attentionos doctor --fix`", editable: true },
  { name: "DISCORD_BOT_TOKEN", label: "Discord bot", purpose: "Discord instead of Telegram.", where: "Discord Developer Portal → your app → Bot", editable: true },
  { name: "DISCORD_CHANNEL_ID", label: "Discord channel id", purpose: "Where the bot posts.", where: "Discord → right-click the channel → Copy channel ID", editable: true },
  { name: "OPENAI_API_KEY", label: "OpenAI", purpose: "Only for cloud speech-to-text or generated images.", where: "platform.openai.com → API keys", editable: true },
  { name: "CRM_WEBHOOK_URL", label: "CRM webhook", purpose: "Where new leads are sent.", where: "Your CRM, Zapier, Make or n8n", editable: true },
  { name: "ATTENTIONOS_WEBHOOK_SECRET", label: "Webhook secret", purpose: "Lets the worker verify incoming webhooks.", where: "Your publishing provider's webhook settings", editable: true },
  { name: "ATTENTIONOS_STUDIO_TOKEN", label: "Studio access key", purpose: "Sign-in for Studio when it asks for one (on a server or behind a proxy).", where: "Created by `attentionos up`", editable: false },
];

export type KeyStatus = KeyInfo & { set: boolean; source: "env-file" | "environment" | null };

export function readEnvFile(root: string): Record<string, string> {
  const file = join(root, ".env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) if (typeof v === "string") out[k] = v;
  return out;
}

/** Which keys are set (never their values). The real environment wins over .env, like the CLI. */
export function keyStatuses(root: string, env: NodeJS.ProcessEnv = process.env): KeyStatus[] {
  const file = readEnvFile(root);
  return KNOWN_KEYS.map((k) => {
    if (env[k.name]) return { ...k, set: true, source: "environment" as const };
    if (file[k.name]) return { ...k, set: true, source: "env-file" as const };
    return { ...k, set: false, source: null };
  });
}

function envLiteral(value: string): string {
  if (/^[A-Za-z0-9_\-.:/@+=,~%?&]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  throw new Error("The value can't contain both kinds of quotes.");
}

/**
 * Sets KEY=value in .env text: replaces every active `KEY=` (or `export KEY=`) line in place, or appends one.
 * Comments, blank lines, other keys and line endings are preserved.
 */
export function setEnvKey(text: string, key: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("Keys are capital letters, digits and underscores.");
  if (/[\r\n\0]/.test(value)) throw new Error("The value must be on one line.");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `${key}=${envLiteral(value)}`;
  const lines = text.length ? text.split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const next = lines.map((l) => {
    if (re.test(l)) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (replaced) return next.join(eol);
  const body = text.length && !text.endsWith("\n") ? text + eol : text;
  return `${body}${line}${eol}`;
}

export function writeEnvKey(root: string, key: string, value: string): void {
  if (!KNOWN_KEYS.some((k) => k.name === key && k.editable)) throw new Error(`Studio doesn't set ${key}. Edit .env by hand.`);
  const file = join(root, ".env");
  const existed = existsSync(file);
  const text = existed ? readFileSync(file, "utf8") : "";
  const temp = `${file}.studio-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, setEnvKey(text, key, value), { mode: existed ? statSync(file).mode & 0o777 : 0o600 });
  renameSync(temp, file);
  if (!existed) chmodSync(file, 0o600);
}

// ───────────────────────────── Modules and providers ─────────────────────────────

export type ModuleManifestLite = {
  id: string;
  name: string;
  description: string;
  tier: "core" | "default" | "opt-in";
  level: number;
  dependsOn: string[];
  requiresAcknowledgement: string[];
};

/** The engine's install folder (repo root from source, dist/assets when installed). Set by the CLI. */
export function engineRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ATTENTIONOS_ENGINE_ROOT && existsSync(env.ATTENTIONOS_ENGINE_ROOT)) return env.ATTENTIONOS_ENGINE_ROOT;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "modules"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function listModules(root: string | null = engineRoot()): ModuleManifestLite[] {
  if (!root) return [];
  const dir = join(root, "modules");
  if (!existsSync(dir)) return [];
  const out: ModuleManifestLite[] = [];
  for (const id of readdirSync(dir)) {
    const file = join(dir, id, "module.json");
    if (!existsSync(file)) continue;
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as Partial<ModuleManifestLite>;
      out.push({
        id: m.id ?? id,
        name: m.name ?? id,
        description: m.description ?? "",
        tier: m.tier ?? "default",
        level: m.level ?? 1,
        dependsOn: m.dependsOn ?? [],
        requiresAcknowledgement: m.requiresAcknowledgement ?? [],
      });
    } catch {
      // A broken manifest shows up in doctor; skip it here.
    }
  }
  return out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

/** Same rule as the runtime: core modules are always on, opt-in ones need `enabled: true`, others default to on. */
export function moduleEnabled(m: ModuleManifestLite, config: AttentionOSConfig): boolean {
  const toggle = config.modules[m.id];
  if (m.tier === "core") return true;
  if (m.tier === "opt-in") return Boolean(toggle?.enabled);
  return toggle?.enabled ?? true;
}

/** Keys each provider choice needs in .env (adapters with no key are local tools or files). */
export const PROVIDER_KEYS: Record<string, Record<string, string[]>> = {
  publisher: { zernio: ["ZERNIO_API_KEY"], blotato: ["BLOTATO_API_KEY"], manual: [] },
  inbox: { zernio: ["ZERNIO_API_KEY"], blotato: ["BLOTATO_API_KEY"], none: [] },
  ownAnalytics: { zernio: ["ZERNIO_API_KEY"], iggraph: ["IG_ACCESS_TOKEN", "IG_USER_ID"], blotato: ["BLOTATO_API_KEY"], csv: [] },
  scraper: { apify: ["APIFY_TOKEN"], iggraph: ["IG_ACCESS_TOKEN"], ytdlp: [], none: [] },
  asr: { whispercpp: [], parakeet: [], openai: ["OPENAI_API_KEY"] },
  renderer: { cut: [], motion: [] },
  imageGen: { none: [], openai: ["OPENAI_API_KEY"], gemini: [] },
  notifier: { telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], discord: ["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID"], email: [], console: [] },
  crm: { lite: [], webhook: ["CRM_WEBHOOK_URL"], sheets: [], gohighlevel: [], hubspot: [] },
  storage: { local: [], supabase: [], s3: [] },
};

export const PROVIDER_LABELS: Record<string, string> = {
  publisher: "Publishing",
  inbox: "DMs and comments",
  ownAnalytics: "Your analytics",
  scraper: "Competitor research",
  asr: "Speech to text",
  renderer: "Video renderer",
  imageGen: "Images",
  notifier: "Notifications",
  crm: "Leads (CRM)",
  storage: "File storage",
};
