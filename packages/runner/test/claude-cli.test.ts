import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCliQuery, cliArgs } from "../src/claude-cli.ts";

describe("cliArgs", () => {
  it("maps SDK options onto Claude Code flags", () => {
    const args = cliArgs({
      model: "claude-sonnet-5",
      maxTurns: 12,
      permissionMode: "dontAsk",
      resume: "sess-1",
      tools: ["Read", "Glob"],
      allowedTools: ["Read", "mcp__attentionos__core_log_progress"],
      disallowedTools: ["Bash(rm:*)"],
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: "be brief" },
      mcpServers: { attentionos: { type: "stdio", command: "node", args: ["cli.js", "mcp"], env: { ATTENTIONOS_ACTOR: "agent:analyst" } } },
      outputFormat: { type: "json_schema", schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } },
    } as never);
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("be brief");
    expect(args).toContain("--strict-mcp-config");
    const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
    expect(mcp.mcpServers.attentionos.command).toBe("node");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual({ type: "object" });
  });

  it("gives toolless runs no tools and no MCP servers", () => {
    const args = cliArgs({ tools: [], mcpServers: {}, systemPrompt: "json only", persistSession: false } as never);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: {} });
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("json only");
    expect(args).toContain("--no-session-persistence");
  });

  it("passes the reasoning effort only when a job or agent sets one", () => {
    expect(cliArgs({ effort: "medium" } as never)).toEqual(expect.arrayContaining(["--effort", "medium"]));
    expect(cliArgs({} as never)).not.toContain("--effort");
  });

  it("never passes an in-process MCP server to the CLI", () => {
    const args = cliArgs({ mcpServers: { attentionos: { type: "sdk", name: "attentionos", instance: {} } } } as never);
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: {} });
  });
});

function fakeClaude(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aos-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("claudeCliQuery", () => {
  it("streams Claude Code's stream-json messages", async () => {
    const bin = fakeClaude(`
      const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
      out({ type: "system", subtype: "init", session_id: "s-1", apiKeySource: "none" });
      process.stdout.write("not json\\n");
      out({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } });
      out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-1", num_turns: 2, total_cost_usd: 0.01 });
    `);
    const seen: string[] = [];
    for await (const m of claudeCliQuery({ bin })({ prompt: "x", options: {} })) seen.push(m.type);
    expect(seen).toEqual(["system", "assistant", "result"]);
  });

  it("sends the prompt on stdin, never in argv, so a large prompt fits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-claude-out-"));
    const report = join(dir, "report.json");
    const bin = fakeClaude(`
      const chunks = [];
      process.stdin.on("data", (c) => chunks.push(c));
      process.stdin.on("end", () => {
        const stdin = Buffer.concat(chunks).toString();
        require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({ argv: process.argv.slice(2), stdinLength: stdin.length, stdinTail: stdin.slice(-12) }));
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s", num_turns: 1, total_cost_usd: 0 }) + "\\n");
      });
    `);
    const prompt = `${"a".repeat(210_000)}-end-marker`;
    const seen: string[] = [];
    for await (const m of claudeCliQuery({ bin })({ prompt, options: {} })) seen.push(m.type);
    expect(seen).toEqual(["result"]);
    const got = JSON.parse(readFileSync(report, "utf8")) as { argv: string[]; stdinLength: number; stdinTail: string };
    expect(got.stdinLength).toBe(prompt.length);
    expect(got.stdinTail).toBe("a-end-marker");
    expect(got.argv[0]).toBe("-p");
    expect(got.argv.some((a) => a.length > 100_000 || a.includes("end-marker"))).toBe(false);
  });

  it("explains a missing binary in plain language", async () => {
    const run = async () => {
      for await (const _ of claudeCliQuery({ bin: "/nonexistent/claude" })({ prompt: "x", options: {} })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/isn't installed/);
  });

  it("surfaces a crash with the end of stderr", async () => {
    const bin = fakeClaude(`process.stderr.write("Not logged in\\n"); process.exit(1);`);
    const run = async () => {
      for await (const _ of claudeCliQuery({ bin })({ prompt: "x", options: {} })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/Not logged in/);
  });
});
