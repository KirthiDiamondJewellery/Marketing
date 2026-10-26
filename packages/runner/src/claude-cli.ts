import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "./llm.ts";

/**
 * A QueryFn backed by the user's own Claude Code CLI (`claude -p --output-format stream-json`), the same way a
 * person would run Claude Code headless on their machine. Its stream-json lines are the SDK's message shapes, so
 * runLlmJob treats both engines identically.
 *
 * MCP servers must be `stdio` (an in-process server can't cross the process boundary).
 *
 * The prompt goes in on stdin, not argv: Linux rejects a single argument over 128 KiB (E2BIG), and argv is visible
 * to every user on the machine through `ps`.
 */
export type ClaudeCliOptions = { bin?: string };

export type StdioMcp = { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/** Maps Agent SDK options onto Claude Code CLI flags (the prompt itself is written to stdin). Exported for tests. */
export function cliArgs(o: Options): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", String(o.effort));
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.resume) args.push("--resume", o.resume);
  if (o.persistSession === false) args.push("--no-session-persistence");

  const tools = (o as { tools?: string[] }).tools;
  if (Array.isArray(tools)) args.push("--tools", tools.length ? tools.join(",") : "");
  if (o.allowedTools?.length) args.push("--allowedTools", ...o.allowedTools);
  if (o.disallowedTools?.length) args.push("--disallowedTools", ...o.disallowedTools);
  if (o.settingSources) args.push("--setting-sources", o.settingSources.join(","));

  const sp = o.systemPrompt;
  if (typeof sp === "string") args.push("--system-prompt", sp);
  else if (sp && typeof sp === "object" && "append" in sp && sp.append) args.push("--append-system-prompt", sp.append);

  const servers = (o.mcpServers ?? {}) as Record<string, StdioMcp | { type: string }>;
  const stdio = Object.fromEntries(Object.entries(servers).filter(([, s]) => s.type === "stdio"));
  args.push("--mcp-config", JSON.stringify({ mcpServers: stdio }), "--strict-mcp-config");

  const format = o.outputFormat as { type?: string; schema?: unknown } | undefined;
  if (format?.type === "json_schema" && format.schema) {
    // Claude Code rejects the draft 2020-12 `$schema` marker that z.toJSONSchema adds.
    const { $schema: _drop, ...schema } = format.schema as Record<string, unknown>;
    args.push("--json-schema", JSON.stringify(schema));
  }
  return args;
}

export function claudeCliQuery(cli: ClaudeCliOptions = {}): QueryFn {
  return async function* query({ prompt, options = {} }): AsyncIterable<SDKMessage> {
    const bin = cli.bin ?? "claude";
    const child = spawn(bin, cliArgs(options), {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // `claude -p` with no prompt argument reads the prompt from stdin until EOF. A child that dies before reading it
    // gives EPIPE here; the exit code and stderr below explain the failure, so swallow the write error.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    const abort = () => child.kill("SIGTERM");
    options.abortController?.signal.addEventListener("abort", abort, { once: true });
    const stderr: string[] = [];
    child.stderr.on("data", (d: Buffer) => {
      const line = d.toString();
      stderr.push(line);
      options.stderr?.(line);
    });
    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("close", (code) => resolve({ code }));
    });

    let sawResult = false;
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let msg: SDKMessage;
        try {
          msg = JSON.parse(trimmed) as SDKMessage;
        } catch {
          continue;
        }
        if (msg.type === "result") sawResult = true;
        yield msg;
      }
    } finally {
      options.abortController?.signal.removeEventListener("abort", abort);
      if (child.exitCode === null) child.kill("SIGTERM");
    }

    const { code, error } = await exited;
    if (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new Error(missing ? `Claude Code isn't installed or isn't on PATH (looked for "${bin}").` : error.message);
    }
    if (!sawResult && code !== 0 && !options.abortController?.signal.aborted) {
      const tail = stderr.join("").trim().split("\n").slice(-3).join(" ");
      throw new Error(`Claude Code exited with code ${code}${tail ? `: ${tail}` : ""}`);
    }
  };
}
