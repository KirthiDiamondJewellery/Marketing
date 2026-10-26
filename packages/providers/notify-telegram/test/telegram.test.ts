import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, ProviderError, silentLogger } from "@attentionos/core";
import { describe, expect, it } from "vitest";
import { buildKeyboard, chunkText, create, escapeMarkdownV2, extractRef, parseUpdates, planSend, toTelegramMarkdownV2 } from "../src/index.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

type Recorded = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<{ status?: number; body: unknown } | ((url: string) => { status?: number; body: unknown })>) {
  const calls: Recorded[] = [];
  let i = 0;
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    const r = typeof next === "function" ? next(url) : next;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

const secrets = (s: Record<string, string>) => (name: string) => s[name];
const TOKEN = "123456:TEST-token-not-real";
const method = (c: Recorded) => c.url.split("/").pop();
const bodyOf = (c: Recorded) => JSON.parse(String(c.init?.body));

describe("markdown", () => {
  it("escapes every MarkdownV2 reserved character in plain text", () => {
    expect(escapeMarkdownV2("Budget: $1.5k (est.) - see #3!")).toBe("Budget: $1\\.5k \\(est\\.\\) \\- see \\#3\\!");
  });

  it("keeps the supported subset and escapes the rest", () => {
    expect(toTelegramMarkdownV2("*3 scripts* ready for _Thursday_. Run `brief` or [open](https://examplebrand.example/a_b).")).toBe(
      "*3 scripts* ready for _Thursday_\\. Run `brief` or [open](https://examplebrand.example/a_b)\\.",
    );
  });

  it("does not treat snake_case words as italics", () => {
    expect(toTelegramMarkdownV2("job editing_revise_v2 done")).toBe("job editing\\_revise\\_v2 done");
  });
});

describe("payload building", () => {
  it("puts approve/reject buttons on the message and danger actions on their own row", () => {
    const kb = buildKeyboard([
      { id: "approve:ap-7", label: "Approve", style: "primary" },
      { id: "reject:ap-7", label: "Reject", style: "danger" },
      { id: "revise:ap-7", label: "Request changes" },
    ]);
    expect(kb).toEqual({
      inline_keyboard: [
        [
          { text: "Approve", callback_data: "approve:ap-7" },
          { text: "Request changes", callback_data: "revise:ap-7" },
        ],
        [{ text: "Reject", callback_data: "reject:ap-7" }],
      ],
    });
  });

  it("rejects action ids over Telegram's 64-byte limit", () => {
    expect(() => buildKeyboard([{ id: "x".repeat(65), label: "Too long" }])).toThrow(/64-byte/);
  });

  it("builds a markdown message with the ref footer and buttons", () => {
    const [call, ...rest] = planSend("4242", {
      text: "*Copywriter* drafted Thursday's script.",
      format: "markdown",
      ref: "ap-7",
      actions: [{ id: "approve:ap-7", label: "Approve" }],
    });
    expect(rest).toEqual([]);
    expect(call).toMatchObject({
      method: "sendMessage",
      params: {
        chat_id: "4242",
        parse_mode: "MarkdownV2",
        text: "*Copywriter* drafted Thursday's script\\.\n\nref ap\\-7",
        reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: "approve:ap-7" }]] },
      },
    });
  });

  it("sends a single video with the text as caption", () => {
    const calls = planSend("4242", { text: "Cut 2 is ready.", ref: "rf-123 v2", attachments: [{ localPath: "media/renders/rf-123-v2.mp4" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "sendVideo",
      params: { caption: "Cut 2 is ready.\n\nref rf-123 v2", supports_streaming: true },
      file: { field: "video", localPath: "media/renders/rf-123-v2.mp4" },
    });
  });

  it("sends long text first, then each file with the ref in its caption", () => {
    const calls = planSend("4242", {
      text: "x".repeat(1500),
      ref: "rf-9",
      attachments: [{ localPath: "a.pdf", caption: "Guide" }, { localPath: "b.png" }],
      priority: "low",
    });
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "sendDocument", "sendPhoto"]);
    expect(calls[1]!.params.caption).toBe("Guide\n\nref rf-9");
    expect(calls[2]!.params.caption).toBe("ref rf-9");
    expect(calls.every((c) => c.params.disable_notification === true)).toBe(true);
  });

  it("chunks very long text and keeps buttons on the last chunk", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} `.repeat(20)).join("\n\n");
    const calls = planSend("4242", { text, actions: [{ id: "ok", label: "OK" }] });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.slice(0, -1).every((c) => !("reply_markup" in c.params))).toBe(true);
    expect(calls.at(-1)!.params.reply_markup).toBeDefined();
    expect(calls.every((c) => String(c.params.text).length <= 4096)).toBe(true);
    expect(chunkText("short", 10)).toEqual(["short"]);
  });
});

describe("refs", () => {
  it("reads the footer first, then known ref tokens", () => {
    expect(extractRef("Cut ready\n\nref rf-123 v2")).toBe("rf-123 v2");
    expect(extractRef("About AP-7 and rf-12 V3 please")).toBe("rf-12 v3");
    expect(extractRef("top-10 kitchen ideas")).toBeUndefined();
  });
});

describe("parseUpdates", () => {
  const raw = fixture("get-updates.json").result as unknown[];
  const parsed = parseUpdates(raw, "4242", undefined, new Date("2026-10-13T12:00:00Z"));

  it("maps a reply to an edit message to replyToRef", () => {
    expect(parsed.messages[0]).toEqual({
      channel: "telegram",
      messageId: "310",
      text: "make the hook punchier and cut the intro",
      from: "4242",
      at: new Date(1791900000 * 1000).toISOString(),
      replyToRef: "rf-123 v2",
    });
  });

  it("maps a button press to actionId and remembers it for acknowledgement", () => {
    expect(parsed.messages[1]).toMatchObject({ actionId: "approve:ap-7", replyToRef: "ap-7", at: "2026-10-13T12:00:00.000Z" });
    expect(parsed.callbackIds).toEqual(["55501"]);
    expect(parsed.pressed).toEqual([{ chatId: 4242, messageId: 305 }]);
  });

  it("ignores other chats and unsupported updates but advances the cursor", () => {
    expect(parsed.messages.map((m) => m.messageId)).toEqual(["310", "cb:55501", "311"]);
    expect(parsed.ignored).toBe(2);
    expect(parsed.cursor).toBe("9006");
  });

  it("references attachments without exposing the bot token", () => {
    expect(parsed.messages[2]!.attachments).toEqual([{ url: "telegram:file/BAACAgQAAxkBAAIBvideo", kind: "video", fileName: "take3.mp4" }]);
  });

  it("keeps the previous cursor when nothing new arrived", () => {
    expect(parseUpdates([], "4242", "9006").cursor).toBe("9006");
  });
});

describe("notifier", () => {
  const config = parseConfig({});

  it("sends via the Bot API and returns the first message id", async () => {
    const f = fakeFetch([{ body: fixture("send-message-ok.json") }]);
    const n = create({ secret: secrets({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "4242" }), config, log: silentLogger, fetch: f.fn });
    await expect(n.send({ text: "Hello" })).resolves.toEqual({ messageId: "412" });
    expect(method(f.calls[0]!)).toBe("sendMessage");
    expect(bodyOf(f.calls[0]!)).toMatchObject({ chat_id: "4242", text: "Hello" });
  });

  it("uploads attachments as multipart form data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    const file = join(dir, "cut.mp4");
    writeFileSync(file, "fake video bytes");
    const f = fakeFetch([{ body: fixture("send-message-ok.json") }]);
    const n = create({ secret: secrets({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "4242" }), config, log: silentLogger, fetch: f.fn });
    await n.send({ text: "Cut 2", attachments: [{ localPath: file }] });
    const form = f.calls[0]!.init!.body as FormData;
    expect(method(f.calls[0]!)).toBe("sendVideo");
    expect(form.get("caption")).toBe("Cut 2");
    expect(form.get("video")).toBeInstanceOf(Blob);
  });

  it("receives updates, acknowledges presses and returns the next cursor", async () => {
    const f = fakeFetch([(url) => (url.endsWith("/getUpdates") ? { body: fixture("get-updates.json") } : { body: { ok: true, result: true } })]);
    const n = create({ secret: secrets({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "4242" }), config, log: silentLogger, fetch: f.fn });
    const r = await n.receive("9001");
    expect(r.cursor).toBe("9006");
    expect(r.messages).toHaveLength(3);
    expect(bodyOf(f.calls[0]!)).toMatchObject({ offset: 9001, timeout: 0 });
    expect(f.calls.map(method)).toEqual(["getUpdates", "answerCallbackQuery", "editMessageReplyMarkup"]);
  });

  it("retries a 429 after retry_after", async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429, body: fixture("rate-limited.json") }, { body: fixture("send-message-ok.json") }]);
    const n = create({
      secret: secrets({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "4242" }),
      config,
      log: silentLogger,
      fetch: f.fn,
      sleep: async (ms) => void waits.push(ms),
    });
    await n.send({ text: "Hello" });
    expect(waits).toEqual([3000]);
  });

  it("maps a bad token to an auth error without leaking it", async () => {
    const f = fakeFetch([{ status: 401, body: fixture("unauthorized.json") }]);
    const n = create({ secret: secrets({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "4242" }), config, log: silentLogger, fetch: f.fn });
    const err = await n.send({ text: "Hello" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("auth");
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it("reports missing setup in plain language", async () => {
    const n = create({ secret: secrets({}), config, log: silentLogger });
    const h = await n.health();
    expect(h.ok).toBe(false);
    expect(h.fix).toMatch(/BotFather/);
    await expect(n.send({ text: "x" })).rejects.toMatchObject({ code: "auth" });
  });
});
