import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseConfig, ProviderError, silentLogger } from "@attentionos/core";
import { describe, expect, it } from "vitest";
import {
  buildButtons,
  create,
  decodeCursor,
  encodeCursor,
  escapeDiscord,
  interactionResponse,
  messagesToInbound,
  parseActionMap,
  parseInteraction,
  planSend,
  reactionCandidates,
  toDiscordMarkdown,
  verifyInteraction,
} from "../src/index.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const OWNER = "1100000000000000001";
const BOT = "1000000000000000099";
const CHANNEL = "1200000000000000001";
const secrets = (s: Record<string, string>) => (name: string) => s[name];

describe("markdown", () => {
  it("maps the shared subset to Discord markdown", () => {
    expect(toDiscordMarkdown("*3 scripts* for _Thursday_, see [plan](https://examplebrand.example/plan) or run `brief`")).toBe(
      "**3 scripts** for *Thursday*, see [plan](<https://examplebrand.example/plan>) or run `brief`",
    );
  });

  it("escapes stray markdown so text renders literally", () => {
    expect(escapeDiscord("2*3 ~ok~ @a_b_c\n# not a heading\n- not a list")).toBe("2\\*3 \\~ok\\~ @a\\_b\\_c\n\\# not a heading\n\\- not a list");
  });
});

describe("payload building", () => {
  const actions = [
    { id: "approve:ap-7", label: "Approve", style: "primary" as const },
    { id: "reject:ap-7", label: "Reject", style: "danger" as const },
  ];

  it("reactions mode: adds a hint line, the action map footer and the reactions to add", () => {
    const [p] = planSend({ text: "Copywriter drafted Thursday's script.", ref: "ap-7", actions }, "reactions");
    expect(p!.payload.content).toBe("Copywriter drafted Thursday's script.\n\nReact to choose: ✅ approve · ❌ reject\n\nref ap-7");
    expect(p!.payload.embeds).toEqual([{ footer: { text: "actions ✅=approve:ap-7 ❌=reject:ap-7" } }]);
    expect(p!.reactions).toEqual(["✅", "❌"]);
    expect(p!.payload.components).toBeUndefined();
    expect(p!.payload.allowed_mentions).toEqual({ parse: [] });
    expect(parseActionMap(p!.payload.embeds![0]!.footer!.text)).toEqual(new Map([["✅", "approve:ap-7"], ["❌", "reject:ap-7"]]));
  });

  it("buttons mode: renders components with styles and no reactions", () => {
    const [p] = planSend({ text: "Script ready", actions }, "buttons");
    expect(p!.payload.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Approve", custom_id: "approve:ap-7" },
          { type: 2, style: 4, label: "Reject", custom_id: "reject:ap-7" },
        ],
      },
    ]);
    expect(p!.reactions).toEqual([]);
  });

  it("wraps buttons into rows of five", () => {
    const rows = buildButtons(Array.from({ length: 7 }, (_, i) => ({ id: `pick:${i}`, label: `Option ${i}` })));
    expect(rows.map((r) => r.components.length)).toEqual([5, 2]);
  });

  it("declares attachments for multipart upload on the last message", () => {
    const planned = planSend({ text: "x ".repeat(1500), attachments: [{ localPath: "media/renders/rf-12-v2.mp4", caption: "Cut 2" }], priority: "low" }, "reactions");
    expect(planned.length).toBe(2);
    expect(planned[0]!.files).toEqual([]);
    expect(planned[1]!.payload.attachments).toEqual([{ id: 0, filename: "rf-12-v2.mp4", description: "Cut 2" }]);
    expect(planned.every((p) => p.payload.flags === 4096)).toBe(true);
    expect(planned.every((p) => p.payload.content.length <= 2000)).toBe(true);
  });
});

describe("inbound", () => {
  it("returns new owner messages oldest first, with reply refs and attachments", () => {
    const r = messagesToInbound(fixture("messages-after.json"), "1300000000000000009", { ownerId: OWNER, botUserId: BOT });
    expect(r.newestId).toBe("1300000000000000013");
    expect(r.messages).toEqual([
      {
        channel: "discord",
        messageId: "1300000000000000011",
        text: "make it warmer",
        from: OWNER,
        at: "2026-10-13T14:01:00.000000+00:00",
        replyToRef: "rf-123 v2",
        attachments: [{ url: "https://cdn.discordapp.example/attachments/take4.mp4", kind: "video", fileName: "take4.mp4" }],
      },
      {
        channel: "discord",
        messageId: "1300000000000000012",
        text: "rf-123 v2 trim the intro and add captions earlier",
        from: OWNER,
        at: "2026-10-13T14:02:00.000000+00:00",
      },
    ]);
  });

  it("finds reactions from people, not the bot's own", () => {
    expect(reactionCandidates(fixture("messages-recent.json"), [])).toEqual([
      { messageId: "1300000000000000008", emoji: "✅", actionId: "approve:ap-7", ref: "ap-7" },
    ]);
    expect(reactionCandidates(fixture("messages-recent.json"), ["1300000000000000008"])).toEqual([]);
  });

  it("round-trips the cursor and tolerates garbage", () => {
    expect(decodeCursor(encodeCursor({ after: "13", done: ["1", "2"] }))).toEqual({ after: "13", done: ["1", "2"] });
    expect(decodeCursor("not-base64-json")).toEqual({ done: [] });
  });
});

describe("interactions", () => {
  it("verifies Ed25519 signatures", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
    const body = JSON.stringify({ type: 1 });
    const ts = "1791900000";
    const sig = sign(null, Buffer.from(ts + body), privateKey).toString("hex");
    expect(verifyInteraction(raw, sig, ts, body)).toBe(true);
    expect(verifyInteraction(raw, sig, ts, body + " ")).toBe(false);
    expect(verifyInteraction("zz", sig, ts, body)).toBe(false);
  });

  it("maps a button press from the owner to an actionId", () => {
    const now = new Date("2026-10-13T15:00:05Z");
    const parsed = parseInteraction(fixture("interaction-button.json"), { ownerId: OWNER, channelId: CHANNEL }, now);
    expect(parsed).toEqual({
      kind: "action",
      channelId: CHANNEL,
      message: { channel: "discord", messageId: "ix:1500000000000000001", text: "", from: OWNER, at: now.toISOString(), actionId: "approve:ap-9", replyToRef: "ap-9" },
    });
    expect(interactionResponse(parsed)).toEqual({ type: 7, data: { components: [] } });
  });

  it("answers pings and refuses presses from other people", () => {
    expect(parseInteraction({ id: "1", type: 1 }, {})).toEqual({ kind: "ping" });
    const other = parseInteraction(fixture("interaction-button.json"), { ownerId: "999" });
    expect(other.kind).toBe("ignored");
    expect(interactionResponse(other)).toMatchObject({ type: 4, data: { flags: 64 } });
  });
});

describe("notifier", () => {
  const config = parseConfig({});

  function router(routes: Record<string, unknown>) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const fn = async (url: string, init?: RequestInit) => {
      const path = url.replace("https://discord.com/api/v10", "");
      calls.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
      const key = Object.keys(routes).find((k) => {
        const [m, p] = k.split(" ");
        return m === (init?.method ?? "GET") && path.startsWith(p!);
      });
      if (!key) return new Response(JSON.stringify({ message: "Unknown", code: 0 }), { status: 404 });
      const body = routes[key];
      return body === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status: 200 });
    };
    return { fn, calls };
  }

  const env = { DISCORD_BOT_TOKEN: "not-a-real-token", DISCORD_CHANNEL_ID: CHANNEL, DISCORD_OWNER_ID: OWNER };

  it("posts a message and adds one reaction per action", async () => {
    const r = router({ [`POST /channels/${CHANNEL}/messages`]: { id: "1300000000000000030" }, "PUT /channels/": null });
    const n = create({ secret: secrets(env), config, log: silentLogger, fetch: r.fn });
    expect(n.actionMode).toBe("reactions");
    await expect(n.send({ text: "Approve?", actions: [{ id: "approve:ap-1", label: "Approve" }] })).resolves.toEqual({ messageId: "1300000000000000030" });
    expect(r.calls.map((c) => `${c.method} ${decodeURIComponent(c.path)}`)).toEqual([
      `POST /channels/${CHANNEL}/messages`,
      `PUT /channels/${CHANNEL}/messages/1300000000000000030/reactions/✅/@me`,
    ]);
  });

  it("switches to buttons when a public key is configured", () => {
    const n = create({ secret: secrets({ ...env, DISCORD_PUBLIC_KEY: "ab" }), config, log: silentLogger });
    expect(n.actionMode).toBe("buttons");
  });

  it("first poll starts at the newest message without replaying history", async () => {
    const r = router({
      "GET /users/@me": { id: BOT },
      [`GET /channels/${CHANNEL}/messages?limit=1`]: [fixture("messages-after.json")[3]],
      [`GET /channels/${CHANNEL}/messages?limit=50`]: [],
    });
    const n = create({ secret: secrets(env), config, log: silentLogger, fetch: r.fn });
    const first = await n.receive();
    expect(first.messages).toEqual([]);
    expect(decodeCursor(first.cursor).after).toBe("1300000000000000013");
  });

  it("polls new messages and reactions, then remembers handled reactions", async () => {
    const r = router({
      "GET /users/@me": { id: BOT },
      [`GET /channels/${CHANNEL}/messages?after=`]: fixture("messages-after.json"),
      [`GET /channels/${CHANNEL}/messages?limit=50`]: fixture("messages-recent.json"),
      [`GET /channels/${CHANNEL}/messages/1300000000000000008/reactions/`]: fixture("reaction-users.json"),
    });
    const n = create({ secret: secrets(env), config, log: silentLogger, fetch: r.fn });
    const res = await n.receive(encodeCursor({ after: "1300000000000000009", done: [] }));
    expect(res.messages.map((m) => m.actionId ?? m.text)).toEqual(["make it warmer", "rf-123 v2 trim the intro and add captions earlier", "approve:ap-7"]);
    expect(res.messages[2]).toMatchObject({ messageId: "rx:1300000000000000008", from: OWNER, replyToRef: "ap-7" });
    expect(decodeCursor(res.cursor)).toEqual({ after: "1300000000000000013", done: ["1300000000000000008"] });
  });

  it("maps errors to ProviderError codes", async () => {
    const r = router({});
    const n = create({ secret: secrets(env), config, log: silentLogger, fetch: r.fn });
    const err = await n.send({ text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("not_found");
  });

  it("reports missing setup in plain language", async () => {
    const n = create({ secret: secrets({}), config, log: silentLogger });
    expect((await n.health()).fix).toMatch(/developer portal/);
  });
});
