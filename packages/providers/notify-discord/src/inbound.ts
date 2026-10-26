import { createPublicKey, verify } from "node:crypto";
import type { InboundMessage } from "@attentionos/core";
import { z } from "zod";
import { parseActionMap } from "./payload.ts";
import { extractRef } from "./refs.ts";

/** The parts of Discord message and interaction objects we read. */

const author = z.looseObject({ id: z.string(), bot: z.boolean().optional(), username: z.string().optional() });
const attachment = z.looseObject({ id: z.string(), url: z.string(), filename: z.string().optional(), content_type: z.string().optional() });
const reaction = z.looseObject({ count: z.number(), me: z.boolean().optional(), emoji: z.looseObject({ id: z.string().nullable().optional(), name: z.string().nullable() }) });

const baseMessage = z.looseObject({
  id: z.string(),
  channel_id: z.string().optional(),
  content: z.string().default(""),
  timestamp: z.string(),
  author,
  attachments: z.array(attachment).default([]),
  embeds: z.array(z.looseObject({ footer: z.looseObject({ text: z.string() }).optional() })).default([]),
  reactions: z.array(reaction).optional(),
});
export const discordMessageSchema = baseMessage.extend({ referenced_message: baseMessage.nullable().optional() });
export type DiscordMessage = z.infer<typeof discordMessageSchema>;

/** Snowflakes are 64-bit; compare as BigInt. */
export function snowflakeGt(a: string, b: string | undefined): boolean {
  if (!b) return true;
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
}

function kindOf(contentType: string | undefined): "video" | "image" | "audio" | "file" {
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("audio/")) return "audio";
  return "file";
}

/** Cursor state. Encoded as base64url JSON so callers can store it as an opaque string. */
export type DiscordCursor = { after?: string; done: string[] };

export function encodeCursor(c: DiscordCursor): string {
  return Buffer.from(JSON.stringify({ a: c.after, d: c.done.slice(-100) })).toString("base64url");
}

export function decodeCursor(raw: string | undefined): DiscordCursor {
  if (!raw) return { done: [] };
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { a?: unknown; d?: unknown };
    return {
      ...(typeof v.a === "string" ? { after: v.a } : {}),
      done: Array.isArray(v.d) ? v.d.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return { done: [] };
  }
}

export type MessageFilter = { ownerId?: string; botUserId?: string };

/** True when a message comes from the person we take instructions from. */
export function isFromOwner(m: Pick<DiscordMessage, "author">, f: MessageFilter): boolean {
  if (m.author.bot) return false;
  if (f.botUserId && m.author.id === f.botUserId) return false;
  return f.ownerId ? m.author.id === f.ownerId : true;
}

/** Pure: new human messages (oldest first) since `after`, as InboundMessages. */
export function messagesToInbound(raw: unknown[], after: string | undefined, f: MessageFilter): { messages: InboundMessage[]; newestId?: string } {
  const parsed = raw.map((r) => discordMessageSchema.safeParse(r)).flatMap((r) => (r.success ? [r.data] : []));
  parsed.sort((a, b) => (snowflakeGt(a.id, b.id) ? 1 : -1));
  let newestId = after;
  const messages: InboundMessage[] = [];
  for (const m of parsed) {
    if (!snowflakeGt(m.id, after)) continue;
    if (snowflakeGt(m.id, newestId)) newestId = m.id;
    if (!isFromOwner(m, f)) continue;
    const ref = m.referenced_message ? extractRef(m.referenced_message.content) : undefined;
    messages.push({
      channel: "discord",
      messageId: m.id,
      text: m.content.trim(),
      from: m.author.id,
      at: m.timestamp,
      ...(ref ? { replyToRef: ref } : {}),
      ...(m.attachments.length
        ? { attachments: m.attachments.map((a) => ({ url: a.url, kind: kindOf(a.content_type), ...(a.filename ? { fileName: a.filename } : {}) })) }
        : {}),
    });
  }
  return { messages, ...(newestId ? { newestId } : {}) };
}

export type ReactionCandidate = { messageId: string; emoji: string; actionId: string; ref?: string };

/**
 * Pure: our recent messages that someone else has reacted to with a mapped emoji. The bot's own reaction
 * counts as one (`me: true`), so a count above that means a person reacted. The caller then confirms WHO
 * reacted before acting.
 */
export function reactionCandidates(raw: unknown[], done: string[]): ReactionCandidate[] {
  const out: ReactionCandidate[] = [];
  const skip = new Set(done);
  for (const r of raw) {
    const p = discordMessageSchema.safeParse(r);
    if (!p.success || skip.has(p.data.id)) continue;
    const m = p.data;
    const map = parseActionMap(m.embeds.find((e) => e.footer)?.footer?.text);
    if (!map.size || !m.reactions?.length) continue;
    for (const rx of m.reactions) {
      const emoji = rx.emoji.name ?? "";
      const actionId = map.get(emoji);
      if (!actionId) continue;
      if (rx.count > (rx.me ? 1 : 0)) {
        const ref = extractRef(m.content);
        out.push({ messageId: m.id, emoji, actionId, ...(ref ? { ref } : {}) });
        break; // one decision per message; the first mapped reaction wins
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interactions (buttons mode, delivered to the Autopilot worker's endpoint)
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verifies Discord's Ed25519 request signature. Reject the request (401) when this returns false. */
export function verifyInteraction(publicKeyHex: string, signatureHex: string, timestamp: string, rawBody: string | Buffer): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    const message = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8")]);
    return verify(null, message, key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

const interactionSchema = z.looseObject({
  id: z.string(),
  type: z.number(),
  channel_id: z.string().optional(),
  data: z.looseObject({ custom_id: z.string().optional() }).optional(),
  member: z.looseObject({ user: author }).optional(),
  user: author.optional(),
  message: baseMessage.optional(),
});

export type ParsedInteraction =
  | { kind: "ping" }
  | { kind: "action"; message: InboundMessage; channelId?: string }
  | { kind: "ignored"; reason: string };

/** Pure: maps an interaction payload to an InboundMessage with `actionId`. */
export function parseInteraction(body: unknown, f: MessageFilter & { channelId?: string }, now: Date = new Date()): ParsedInteraction {
  const p = interactionSchema.safeParse(body);
  if (!p.success) return { kind: "ignored", reason: "not an interaction" };
  const i = p.data;
  if (i.type === 1) return { kind: "ping" };
  if (i.type !== 3 || !i.data?.custom_id) return { kind: "ignored", reason: "not a button press" };
  if (f.channelId && i.channel_id && i.channel_id !== f.channelId) return { kind: "ignored", reason: "another channel" };
  const user = i.member?.user ?? i.user;
  if (!user || !isFromOwner({ author: user }, f)) return { kind: "ignored", reason: "not the owner" };
  const ref = extractRef(i.message?.content);
  return {
    kind: "action",
    ...(i.channel_id ? { channelId: i.channel_id } : {}),
    message: {
      channel: "discord",
      messageId: `ix:${i.id}`,
      text: "",
      from: user.id,
      at: now.toISOString(),
      actionId: i.data.custom_id,
      ...(ref ? { replyToRef: ref } : {}),
    },
  };
}

/**
 * The HTTP response body for an interaction: PONG for pings; for a button press, update the message in
 * place and remove its buttons so it can't be pressed twice.
 */
export function interactionResponse(parsed: ParsedInteraction): unknown {
  if (parsed.kind === "ping") return { type: 1 };
  if (parsed.kind === "action") return { type: 7, data: { components: [] } };
  // Ephemeral: only the person who pressed sees it.
  return { type: 4, data: { content: "Only the workspace owner can use these buttons.", flags: 64 } };
}
