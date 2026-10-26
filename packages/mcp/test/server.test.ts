import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, defineTool, loadBrandKit, parseConfig, silentLogger, ToolError, type BrandKit, type WorkspaceContext } from "@attentionos/core";
import { ensureWorkspace } from "@attentionos/db";
import { createTestDatabase } from "@attentionos/db/testing";
import { workspacePaths } from "@attentionos/runtime";
import { appendLesson, createMcpServer, createSetupMcpServer, hasLesson } from "../src/index.ts";

const demoModule = defineModule({
  manifest: {
    id: "demo", name: "Demo", description: "test module", agent: "copywriter", tier: "default", level: 1,
    dependsOn: [], requiredProviders: [], optionalProviders: [], schedules: {}, requiresAcknowledgement: [],
  },
  jobs: [],
  tools: [
    defineTool({
      name: "demo_save_note",
      description: "Saves a note.",
      input: z.object({ text: z.string().min(1), tags: z.array(z.string()).default([]) }),
      handler: async ({ actor }, input) => ({ saved: true, by: actor, tags: input.tags, nothing: null }),
    }),
    defineTool({
      name: "demo_read",
      description: "Reads.",
      input: z.object({}),
      annotations: { readOnly: true },
      handler: async () => ({ ok: true }),
    }),
    defineTool({
      name: "demo_refuse",
      description: "Always refuses.",
      input: z.object({}),
      handler: async () => {
        throw new ToolError("That keyword is already used.", "Pick another keyword.");
      },
    }),
  ],
});

describe("MCP server", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let ws: WorkspaceContext;
  let client: Client;

  beforeAll(async () => {
    db = await createTestDatabase("attentionos_test_o1_mcp");
    const root = mkdtempSync(join(tmpdir(), "aos-mcp-"));
    mkdirSync(join(root, "brand", "knowledge"), { recursive: true });
    writeFileSync(join(root, "brand", "brand.yaml"), "name: Examplebrand Studio\n");
    writeFileSync(join(root, "brand", "voice.md"), "# Voice\nPlain, warm, specific.\n");
    writeFileSync(join(root, "brand", "knowledge", "pricing.md"), "# Pricing\n");
    const config = parseConfig({ workspace: { name: "Examplebrand Studio", timezone: "America/Chicago" } });
    const { id } = await ensureWorkspace(db.sql, { name: "Examplebrand Studio", slug: "examplebrand", timezone: "America/Chicago" });
    const paths = workspacePaths(root);
    let brand: BrandKit | undefined;
    ws = {
      id, paths, config, sql: db.sql, providers: { trendSources: {} }, log: silentLogger,
      brand: () => (brand ??= loadBrandKit(paths.brand)),
      reloadBrand: () => (brand = loadBrandKit(paths.brand)),
      now: () => new Date("2026-10-10T15:00:00Z"),
      secret: () => undefined,
    };
    const server = createMcpServer(ws, { modules: [demoModule], actor: "user:local" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client?.close();
    await db?.drop();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    const body = res.content[0]!.text;
    return { isError: Boolean(res.isError), body, json: () => JSON.parse(body) as Record<string, unknown> };
  };

  it("registers core tools and module tools with JSON schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(expect.arrayContaining([
      "core_status", "core_brand_kit", "core_append_lesson", "core_request_approval", "core_list_approvals", "core_decide_approval", "core_log_progress",
      "demo_save_note", "demo_read", "demo_refuse",
    ]));
    const save = tools.find((t) => t.name === "demo_save_note")!;
    expect(save.inputSchema.properties).toHaveProperty("text");
    expect(save.inputSchema.properties).toHaveProperty("_actor");
    expect(tools.find((t) => t.name === "demo_read")!.annotations?.readOnlyHint).toBe(true);
  });

  it("attributes writes to the per-call actor and logs an activity event", async () => {
    const res = await call("demo_save_note", { text: "hello", _actor: "agent:copywriter" });
    expect(res.isError).toBe(false);
    expect(res.json()).toEqual({ saved: true, by: "agent:copywriter", tags: [] });
    const def = await call("demo_save_note", { text: "again" });
    expect(def.json().by).toBe("user:local");
    await call("demo_read");
    const events = await db.sql`select agent, kind, message, data from agent_events where workspace_id = ${ws.id} order by id`;
    expect(events.map((e) => [e.agent, e.kind, e.message])).toEqual([
      ["copywriter", "tool", "Used demo_save_note"],
      ["user:local", "tool", "Used demo_save_note"],
    ]);
    const bad = await call("demo_save_note", { text: "x", _actor: "agent:intern" });
    expect(bad.isError).toBe(true);
    expect(bad.body).toMatch(/not a valid actor/);
  });

  it("returns ToolError and validation errors as error results with hints", async () => {
    const refused = await call("demo_refuse");
    expect(refused).toMatchObject({ isError: true });
    expect(refused.body).toBe("Error: That keyword is already used.\nHint: Pick another keyword.");
    const invalid = await call("demo_save_note", { text: "" });
    expect(invalid.isError).toBe(true);
  });

  it("reads Brand Kit files safely", async () => {
    const list = (await call("core_brand_kit")).json();
    expect(list.files).toEqual(["brand.yaml", "knowledge/pricing.md", "voice.md"]);
    expect((await call("core_brand_kit", { file: "voice" })).json().content).toMatch(/Plain, warm/);
    expect((await call("core_brand_kit", { file: "knowledge/pricing" })).json().file).toBe("brand/knowledge/pricing.md");
    expect((await call("core_brand_kit", { file: "../config/attentionos.config.ts" })).isError).toBe(true);
    expect((await call("core_brand_kit", { file: "offers" })).body).toMatch(/doesn't exist yet/);
  });

  it("appends dated lessons with evidence and skips duplicates", async () => {
    const args = { rule: "Never open with a question about price.", evidence: "ap-3 rejected: 'What does a remodel cost?'", source: "approval ap-3", scope: "scripting" };
    const first = (await call("core_append_lesson", { ...args, _actor: "user:local" })).json();
    expect(first).toMatchObject({ saved: true, file: "brand/lessons.md" });
    const second = (await call("core_append_lesson", { ...args, rule: "never open with a question about price" })).json();
    expect(second).toMatchObject({ saved: false, duplicate: true });
    const content = readFileSync(ws.paths.lessons, "utf8");
    expect(content).toMatch(/^# Lessons/);
    expect(content).toContain("- **2026-10-10** [scripting] Never open with a question about price.");
    expect(content).toContain("  - Evidence: ap-3 rejected:");
    expect(content).toContain("  - Source: approval ap-3 · by user:local");
    expect(ws.brand().docs.lessons).toContain("question about price");
  });

  it("runs the approvals flow and keeps decisions human-only", async () => {
    const req = (await call("core_request_approval", { kind: "script", subjectType: "content", summary: "Script for Thursday", preview: { hook: "We moved a wall in a day." }, _actor: "agent:copywriter" })).json();
    expect(req).toMatchObject({ status: "pending", agent: "copywriter", created: true });
    const listed = (await call("core_list_approvals")).json();
    expect((listed.approvals as unknown[]).length).toBe(1);
    const denied = await call("core_decide_approval", { ref: req.ref, decision: "approved", _actor: "agent:copywriter" });
    expect(denied.isError).toBe(true);
    expect(denied.body).toMatch(/Only a person/);
    const decided = (await call("core_decide_approval", { ref: req.ref, decision: "rejected", note: "Too long" })).json();
    expect(decided).toMatchObject({ status: "rejected", decidedBy: "user:local" });
    expect(decided.next).toMatch(/core_append_lesson/);
    const status = (await call("core_status")).json();
    expect(status).toMatchObject({ workspace: { name: "Examplebrand Studio" }, modules: { on: ["demo"] }, approvals: { pending: 0 } });
  });

  it("logs progress lines", async () => {
    await call("core_log_progress", { message: "Drafted 3 hooks for the kitchen reel", _actor: "agent:copywriter" });
    const [row] = await db.sql`select agent, kind from agent_events where workspace_id = ${ws.id} and message like 'Drafted 3 hooks%'`;
    expect(row).toMatchObject({ agent: "copywriter", kind: "progress" });
  });

  it("locks the actor for Autopilot runs", async () => {
    const server = createMcpServer(ws, { modules: [demoModule], actor: "agent:publisher", lockActor: true, toolFilter: (n) => n.startsWith("demo_") });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t2", version: "1" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["demo_read", "demo_refuse", "demo_save_note"]);
    expect(tools[0]!.inputSchema.properties ?? {}).not.toHaveProperty("_actor");
    const res = (await c.callTool({ name: "demo_save_note", arguments: { text: "x", _actor: "user:someone" } })) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0]!.text).by).toBe("agent:publisher");
    await c.close();
  });

  it("serves a setup-only status when no workspace is loaded", async () => {
    const server = createSetupMcpServer({ message: "No AttentionOS workspace found here.", fix: "Start AttentionOS with ./aos start" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t3", version: "1" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const res = (await c.callTool({ name: "core_status", arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ready: false });
    await c.close();
  });
});

describe("lessons file", () => {
  it("creates the file with a header and detects duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-lessons-"));
    const path = join(dir, "brand", "lessons.md");
    const l = { rule: "Keep hooks under 12 words", evidence: "x", actor: "user:local", date: "2026-10-10" };
    expect(appendLesson(path, l).added).toBe(true);
    expect(appendLesson(path, { ...l, rule: "Keep hooks under 12 words." }).added).toBe(false);
    expect(hasLesson(readFileSync(path, "utf8"), "keep hooks under 12 words")).toBe(true);
  });
});
