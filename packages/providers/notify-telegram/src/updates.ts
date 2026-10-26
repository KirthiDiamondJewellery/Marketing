import type { InboundMessage } from "@attentionos/core";
import { z } from "zod";
import { extractRef } from "./refs.ts";

/** The parts of a Bot API Update we read. Unknown fields pass through untouched. */

const user = z.looseObject({ id: z.number(), is_bot: z.boolean().optional(), username: z.string().optional(), first_name: z.string().optional() });
const chat = z.looseObject({ id: z.number(), type: z.string().optional() });
const fileRef = z.looseObject({ file_id: z.string(), file_name: z.string().optional(), file_size: z.number().optional() });

const baseMessage = z.looseObject({
  message_id: z.number(),
  date: z.number(),
  chat,
  from: user.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  video: fileRef.optional(),
  video_note: fileRef.optional(),
  document: fileRef.optional(),
  audio: fileRef.optional(),
  voice: fileRef.optional(),
  photo: z.array(fileRef).optional(),
});

export const telegramMessageSchema = baseMessage.extend({ reply_to_message: baseMessage.optional() });
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

export const telegramUpdateSchema = z.looseObject({
  update_id: z.number(),
  message: telegramMessageSchema.optional(),
  callback_query: z
    .looseObject({
      id: z.string(),
      from: user,
      data: z.string().optional(),
      message: baseMessage.optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

/** Inbound attachments are referenced by a token-free URL; `download()` resolves it. */
export const FILE_URL_PREFIX = "telegram:file/";

function attachmentsOf(m: TelegramMessage): InboundMessage["attachments"] {
  const out: NonNullable<InboundMessage["attachments"]> = [];
  const add = (f: { file_id: string; file_name?: string } | undefined, kind: "video" | "image" | "audio" | "file") => {
    if (f) out.push({ url: `${FILE_URL_PREFIX}${f.file_id}`, kind, ...(f.file_name ? { fileName: f.file_name } : {}) });
  };
  add(m.video, "video");
  add(m.video_note, "video");
  add(m.document, "file");
  add(m.audio, "audio");
  add(m.voice, "audio");
  if (m.photo?.length) add(m.photo[m.photo.length - 1], "image"); // largest size is last
  return out.length ? out : undefined;
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export type ParsedUpdates = {
  messages: InboundMessage[];
  /** Callback query ids to acknowledge (stops the button's loading spinner). */
  callbackIds: string[];
  /** Messages whose buttons should be removed after a press: [chatId, messageId]. */
  pressed: { chatId: number; messageId: number }[];
  /** Next getUpdates offset. */
  cursor: string;
  ignored: number;
};

/**
 * Pure: converts raw updates into InboundMessages. Only the configured chat is accepted; anything else
 * (another chat, a group the bot was added to, a stranger who found the bot) is ignored but still
 * advances the cursor so it isn't fetched again.
 */
export function parseUpdates(raw: unknown[], chatId: string, previousCursor?: string, now: Date = new Date()): ParsedUpdates {
  const messages: InboundMessage[] = [];
  const callbackIds: string[] = [];
  const pressed: ParsedUpdates["pressed"] = [];
  let maxId = previousCursor ? Number(previousCursor) - 1 : -1;
  let ignored = 0;

  for (const item of raw) {
    const parsed = telegramUpdateSchema.safeParse(item);
    if (!parsed.success) {
      const id = (item as { update_id?: unknown })?.update_id;
      if (typeof id === "number") maxId = Math.max(maxId, id);
      ignored++;
      continue;
    }
    const u = parsed.data;
    maxId = Math.max(maxId, u.update_id);

    if (u.callback_query) {
      const cq = u.callback_query;
      callbackIds.push(cq.id);
      const fromChat = cq.message?.chat.id;
      if (fromChat === undefined || String(fromChat) !== chatId || !cq.data) {
        ignored++;
        continue;
      }
      const ref = extractRef(cq.message?.text ?? cq.message?.caption);
      messages.push({
        channel: "telegram",
        messageId: `cb:${cq.id}`,
        text: "",
        from: String(cq.from.id),
        // Button presses carry no timestamp of their own.
        at: now.toISOString(),
        actionId: cq.data,
        ...(ref ? { replyToRef: ref } : {}),
      });
      if (cq.message) pressed.push({ chatId: fromChat, messageId: cq.message.message_id });
      continue;
    }

    const m = u.message;
    if (!m || String(m.chat.id) !== chatId || m.from?.is_bot) {
      ignored++;
      continue;
    }
    const replied = m.reply_to_message;
    const ref = replied ? extractRef(replied.text ?? replied.caption) : undefined;
    const attachments = attachmentsOf(m);
    messages.push({
      channel: "telegram",
      messageId: String(m.message_id),
      text: (m.text ?? m.caption ?? "").trim(),
      from: String(m.from?.id ?? m.chat.id),
      at: iso(m.date),
      ...(ref ? { replyToRef: ref } : {}),
      ...(attachments ? { attachments } : {}),
    });
  }

  const cursor = maxId >= 0 ? String(maxId + 1) : (previousCursor ?? "0");
  return { messages, callbackIds, pressed, cursor, ignored };
}

/** Chats that have messaged the bot, for setup ("send your bot a message, then run doctor --fix"). */
export function chatsFromUpdates(raw: unknown[]): { id: string; type?: string; title?: string; username?: string }[] {
  const seen = new Map<string, { id: string; type?: string; title?: string; username?: string }>();
  for (const item of raw) {
    const u = telegramUpdateSchema.safeParse(item);
    const c = u.success ? u.data.message?.chat : undefined;
    if (!c) continue;
    const extra = c as { title?: unknown; username?: unknown };
    seen.set(String(c.id), {
      id: String(c.id),
      ...(c.type ? { type: c.type } : {}),
      ...(typeof extra.title === "string" ? { title: extra.title } : {}),
      ...(typeof extra.username === "string" ? { username: extra.username } : {}),
    });
  }
  return [...seen.values()];
}
