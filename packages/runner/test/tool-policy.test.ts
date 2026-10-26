import { describe, expect, it } from "vitest";
import { CONTENT_TOOL, DENIED_NATIVE_TOOLS, effectiveTools } from "../src/tool-policy.ts";
import { cliArgs } from "../src/claude-cli.ts";

describe("shared agent tool policy", () => {
  it("replaces filesystem discovery with bounded MCP content access", () => {
    const allowedTools = effectiveTools(["Read", "Glob", "Grep", "Bash(cat:*)", "Write", "Agent", "WebSearch", "mcp__attentionos__scripting_save_hooks"]);
    expect(allowedTools).toEqual(["WebSearch", "mcp__attentionos__scripting_save_hooks", CONTENT_TOOL]);
    const args = cliArgs({ tools: ["WebSearch"], allowedTools, disallowedTools: DENIED_NATIVE_TOOLS, settingSources: [] });
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain(CONTENT_TOOL);
    expect(args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--setting-sources"))).toEqual(DENIED_NATIVE_TOOLS);
  });
  it("does not grant content access to tool-less jobs", () => { expect(effectiveTools([])).toEqual([]); });
});
