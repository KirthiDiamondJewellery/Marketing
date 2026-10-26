import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ProviderError,
  type AttentionOSConfig,
  type InboundMessage,
  type Logger,
  type Notifier,
  type OutboundMessage,
  type ProviderHealth,
} from "@attentionos/core";
import { TelegramClient, type FetchLike } from "./client.ts";
import { planSend } from "./payload.ts";
import { chatsFromUpdates, FILE_URL_PREFIX, parseUpdates } from "./updates.ts";

export { escapeMarkdownV2, toTelegramMarkdownV2 } from "./markdown.ts";
export { buildKeyboard, chunkText, planSend, type TelegramCall } from "./payload.ts";
export { extractRef, normalizeRef, refFooter } from "./refs.ts";
export { chatsFromUpdates, parseUpdates, FILE_URL_PREFIX } from "./updates.ts";

export type CreateOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
  /** Injectable for tests. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** getUpdates long-poll seconds. 0 (default) returns at once, which suits a job that runs every minute. */
  pollTimeoutS?: number;
};

export interface TelegramNotifier extends Notifier {
  readonly id: "telegram";
  /** Saves a file the user sent (an `InboundMessage.attachments[].url` starting with `telegram:file/`). */
  download(url: string, destPath: string): Promise<{ localPath: string }>;
  /** Chats that recently messaged the bot, to help the user find TELEGRAM_CHAT_ID during setup. */
  discoverChats(): Promise<{ id: string; type?: string; title?: string; username?: string }[]>;
}

const NOT_CONFIGURED_FIX =
  "Create a bot with @BotFather, put its token in TELEGRAM_BOT_TOKEN in your workspace .env, send the bot a message, then run `attentionos doctor --fix` to fill in TELEGRAM_CHAT_ID.";

/** Telegram notifier (the default). Long-polling only, so no public URL is needed. */
export function create(opts: CreateOptions): TelegramNotifier {
  const token = opts.secret("TELEGRAM_BOT_TOKEN")?.trim();
  const chatId = opts.secret("TELEGRAM_CHAT_ID")?.trim();
  const log = opts.log.child({ provider: "telegram" });
  const client = token
    ? new TelegramClient({ token, log, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) })
    : undefined;

  const requireClient = (): TelegramClient => {
    if (!client) throw new ProviderError("telegram", "auth", `TELEGRAM_BOT_TOKEN is not set. ${NOT_CONFIGURED_FIX}`);
    return client;
  };
  const requireChat = (): string => {
    if (!chatId) throw new ProviderError("telegram", "invalid_request", `TELEGRAM_CHAT_ID is not set. ${NOT_CONFIGURED_FIX}`);
    return chatId;
  };

  return {
    id: "telegram",

    async health(): Promise<ProviderHealth> {
      if (!client) return { ok: false, detail: "Telegram bot token is missing", fix: NOT_CONFIGURED_FIX };
      try {
        const me = await client.call<{ username?: string }>("getMe");
        if (!chatId) return { ok: false, detail: `Connected as @${me.username ?? "your bot"}, but no chat is set`, fix: NOT_CONFIGURED_FIX };
        await client.call("getChat", { chat_id: chatId });
        return { ok: true, detail: `Connected as @${me.username ?? "your bot"}` };
      } catch (e) {
        const err = e instanceof ProviderError ? e : undefined;
        if (err?.code === "auth") return { ok: false, detail: "Telegram rejected the bot token", fix: "Copy the token again from @BotFather into TELEGRAM_BOT_TOKEN." };
        if (err?.code === "not_found" || err?.code === "invalid_request") {
          return { ok: false, detail: "The bot can't see your chat", fix: "Open your bot in Telegram, press Start, then run `attentionos doctor --fix`." };
        }
        return { ok: false, detail: "Telegram didn't respond", fix: "Check your internet connection and try again." };
      }
    },

    async send(msg: OutboundMessage): Promise<{ messageId: string }> {
      const c = requireClient();
      const calls = planSend(requireChat(), msg);
      let firstId: string | undefined;
      for (const call of calls) {
        const sent = await c.send<{ message_id: number }>(call);
        firstId ??= String(sent.message_id);
      }
      log.debug("sent", { calls: calls.length, ref: msg.ref });
      return { messageId: firstId ?? "" };
    },

    async receive(cursor?: string): Promise<{ messages: InboundMessage[]; cursor: string }> {
      const c = requireClient();
      const chat = requireChat();
      const raw = await c.call<unknown[]>(
        "getUpdates",
        {
          ...(cursor ? { offset: Number(cursor) } : {}),
          timeout: opts.pollTimeoutS ?? 0,
          allowed_updates: ["message", "callback_query"],
        },
        { timeoutMs: ((opts.pollTimeoutS ?? 0) + 15) * 1000 },
      );
      const parsed = parseUpdates(raw, chat, cursor);
      // Best effort: stop button spinners and remove buttons that were pressed, so nothing is decided twice.
      await Promise.allSettled([
        ...parsed.callbackIds.map((id) => c.call("answerCallbackQuery", { callback_query_id: id, text: "Got it" })),
        ...parsed.pressed.map((p) =>
          c.call("editMessageReplyMarkup", { chat_id: p.chatId, message_id: p.messageId, reply_markup: { inline_keyboard: [] } }),
        ),
      ]);
      if (parsed.ignored) log.debug("ignored updates from other chats", { count: parsed.ignored });
      return { messages: parsed.messages, cursor: parsed.cursor };
    },

    async download(url: string, destPath: string) {
      if (!url.startsWith(FILE_URL_PREFIX)) throw new ProviderError("telegram", "invalid_request", "not a Telegram file reference");
      const bytes = await requireClient().download(url.slice(FILE_URL_PREFIX.length));
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, bytes);
      return { localPath: destPath };
    },

    async discoverChats() {
      const raw = await requireClient().call<unknown[]>("getUpdates", { timeout: 0, allowed_updates: ["message"] });
      return chatsFromUpdates(raw);
    },
  };
}

export default create;
