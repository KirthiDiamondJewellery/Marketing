import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, silentLogger } from "@attentionos/core";
import { describe, expect, it } from "vitest";
import { create, renderConsole } from "../src/index.ts";

const config = parseConfig({});
const now = () => new Date("2026-10-13T12:00:00Z");

describe("console notifier", () => {
  it("prints messages with ref, files and actions", async () => {
    const out: string[] = [];
    const n = create({ secret: () => undefined, config, log: silentLogger, write: (t) => out.push(t), now });
    await n.send({ text: "Cut 2 ready", ref: "rf-12 v2", attachments: [{ localPath: "media/renders/a.mp4" }], actions: [{ id: "approve:ap-1", label: "Approve" }] });
    expect(out[0]).toBe("── message console-1 · rf-12 v2\nCut 2 ready\n[file] media/renders/a.mp4\n[actions] Approve = approve:ap-1\n");
    expect(n.sent).toHaveLength(1);
    expect(renderConsole({ text: "x", priority: "high" }, "m")).toContain("· high");
  });

  it("returns injected messages once", async () => {
    const n = create({ secret: () => undefined, config, log: silentLogger, write: () => {}, now });
    n.inject({ text: "approve ap-7" });
    expect((await n.receive()).messages.map((m) => m.text)).toEqual(["approve ap-7"]);
    expect((await n.receive()).messages).toEqual([]);
  });

  it("reads new JSON lines from the inbox file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-"));
    const file = join(dir, "inbox.jsonl");
    writeFileSync(file, '{"text":"brief"}\nnot json\n');
    const n = create({ secret: (k) => (k === "ATTENTIONOS_CONSOLE_INBOX" ? file : undefined), config, log: silentLogger, write: () => {}, now });
    const first = await n.receive();
    expect(first.messages.map((m) => m.text)).toEqual(["brief"]);
    appendFileSync(file, '{"actionId":"approve:ap-7"}\n');
    const second = await n.receive(first.cursor);
    expect(second.messages).toEqual([{ channel: "console", messageId: "file-3", text: "", from: "console", at: now().toISOString(), actionId: "approve:ap-7" }]);
  });
});
