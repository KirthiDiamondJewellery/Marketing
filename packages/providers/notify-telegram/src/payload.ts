import { extname } from "node:path";
import type { NotifyAction, OutboundMessage } from "@attentionos/core";
import { stripMarkdown, toTelegramMarkdownV2 } from "./markdown.ts";
import { refFooter } from "./refs.ts";

/**
 * Pure payload building: turns one OutboundMessage into the Bot API calls that deliver it.
 * Kept free of I/O so tests can assert exact payloads.
 */

export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
/** Callback data is limited to 64 bytes by Telegram. */
export const CALLBACK_DATA_LIMIT = 64;
/** Bot API upload limits. */
export const UPLOAD_LIMITS = { photo: 10 * 1024 * 1024, other: 50 * 1024 * 1024 };

export type FileField = "video" | "photo" | "document" | "audio";

export type TelegramCall = {
  method: "sendMessage" | "sendVideo" | "sendPhoto" | "sendDocument" | "sendAudio";
  params: Record<string, unknown>;
  /** Present for uploads: sent as multipart/form-data under `field`. */
  file?: { field: FileField; localPath: string };
};

export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const PHOTO = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const AUDIO = new Set([".mp3", ".m4a", ".ogg", ".wav"]);

export function fileFieldFor(localPath: string): FileField {
  const ext = extname(localPath).toLowerCase();
  if (VIDEO.has(ext)) return "video";
  if (PHOTO.has(ext)) return "photo";
  if (AUDIO.has(ext)) return "audio";
  return "document";
}

const METHOD_FOR: Record<FileField, TelegramCall["method"]> = {
  video: "sendVideo",
  photo: "sendPhoto",
  document: "sendDocument",
  audio: "sendAudio",
};

/** Up to three buttons per row; danger actions get their own row so they're harder to hit by accident. */
export function buildKeyboard(actions: NotifyAction[] | undefined): InlineKeyboard | undefined {
  if (!actions?.length) return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  let row: { text: string; callback_data: string }[] = [];
  const danger: { text: string; callback_data: string }[] = [];
  for (const a of actions) {
    if (Buffer.byteLength(a.id, "utf8") > CALLBACK_DATA_LIMIT) {
      throw new Error(`action id "${a.id.slice(0, 20)}…" is longer than Telegram's ${CALLBACK_DATA_LIMIT}-byte limit`);
    }
    const button = { text: a.label, callback_data: a.id };
    if (a.style === "danger") {
      danger.push(button);
      continue;
    }
    row.push(button);
    if (row.length === 3) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  if (danger.length) rows.push(danger);
  return { inline_keyboard: rows };
}

/** Splits long text on paragraph, then line, then hard boundaries. Works on source text, before rendering. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

type Rendered = { text: string; parseMode?: "MarkdownV2" };

function render(source: string, markdown: boolean): Rendered {
  return markdown ? { text: toTelegramMarkdownV2(source), parseMode: "MarkdownV2" } : { text: source };
}

/** Source text with the ref footer appended (the footer is how replies find their thread). */
export function withFooter(msg: OutboundMessage): string {
  const body = msg.text.trimEnd();
  return msg.ref ? `${body}\n\n${refFooter(msg.ref)}` : body;
}

/**
 * Plans the calls for one message:
 * - no attachments: one sendMessage per chunk, buttons on the last chunk;
 * - one attachment and a short text: one upload with the text as caption and the buttons;
 * - otherwise: the text first (with buttons), then each file with its own caption.
 * Captions of extra files repeat the ref footer so a reply to the file still finds its thread.
 */
export function planSend(chatId: string, msg: OutboundMessage, opts: { quiet?: boolean } = {}): TelegramCall[] {
  const markdown = msg.format === "markdown";
  const keyboard = buildKeyboard(msg.actions);
  const source = withFooter(msg);
  const common = {
    chat_id: chatId,
    ...(opts.quiet || msg.priority === "low" ? { disable_notification: true } : {}),
  };
  const attachments = msg.attachments ?? [];
  const calls: TelegramCall[] = [];

  // Telegram measures caption length after entity parsing, i.e. the text the reader sees.
  const visibleLength = markdown ? stripMarkdown(source).length : source.length;
  if (attachments.length === 1 && visibleLength <= CAPTION_LIMIT) {
    const [file] = attachments;
    const field = fileFieldFor(file!.localPath);
    const r = render(source, markdown);
    calls.push({
      method: METHOD_FOR[field],
      params: {
        ...common,
        caption: r.text,
        ...(r.parseMode ? { parse_mode: r.parseMode } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(field === "video" ? { supports_streaming: true } : {}),
      },
      file: { field, localPath: file!.localPath },
    });
    return calls;
  }

  // Escaping can roughly double the length of MarkdownV2 text, so chunk the source conservatively.
  const chunks = chunkText(source, markdown ? Math.floor(TEXT_LIMIT / 2) : TEXT_LIMIT);
  chunks.forEach((chunk, i) => {
    const r = render(chunk, markdown);
    const last = i === chunks.length - 1;
    calls.push({
      method: "sendMessage",
      params: {
        ...common,
        text: r.text,
        ...(r.parseMode ? { parse_mode: r.parseMode } : {}),
        link_preview_options: { is_disabled: true },
        ...(last && keyboard ? { reply_markup: keyboard } : {}),
      },
    });
  });

  for (const file of attachments) {
    const field = fileFieldFor(file.localPath);
    const caption = [file.caption?.trim(), msg.ref ? refFooter(msg.ref) : undefined].filter(Boolean).join("\n\n");
    const r = caption ? render(caption.slice(0, CAPTION_LIMIT), markdown) : undefined;
    calls.push({
      method: METHOD_FOR[field],
      params: {
        ...common,
        ...(r ? { caption: r.text } : {}),
        ...(r?.parseMode ? { parse_mode: r.parseMode } : {}),
        ...(field === "video" ? { supports_streaming: true } : {}),
      },
      file: { field, localPath: file.localPath },
    });
  }
  return calls;
}
