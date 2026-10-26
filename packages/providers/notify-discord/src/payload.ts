import { basename } from "node:path";
import type { NotifyAction, OutboundMessage } from "@attentionos/core";
import { toDiscordMarkdown } from "./markdown.ts";
import { refFooter } from "./refs.ts";

/**
 * Pure payload building for Discord channel messages.
 *
 * Two ways to show actions:
 * - "buttons": message components. A press is an interaction that Discord delivers ONLY to an interactions
 *   endpoint (the Autopilot worker), so this mode needs DISCORD_PUBLIC_KEY and a public URL.
 * - "reactions" (default): the bot adds one reaction per action and the user reacts. Reactions can be read
 *   by polling, so no public URL is needed. The emoji-to-action map rides in the embed footer so any process
 *   can resolve a reaction later.
 */

export const CONTENT_LIMIT = 2000;
export const CUSTOM_ID_LIMIT = 100;
export const MAX_FILES = 10;
/** Default upload limit for bots in servers without boosts. */
export const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

export type ActionMode = "buttons" | "reactions";

export type DiscordButton = { type: 2; style: 1 | 2 | 4; label: string; custom_id: string };
export type DiscordActionRow = { type: 1; components: DiscordButton[] };

export type DiscordMessagePayload = {
  content: string;
  allowed_mentions: { parse: [] };
  components?: DiscordActionRow[];
  embeds?: { description?: string; footer?: { text: string } }[];
  attachments?: { id: number; filename: string; description?: string }[];
  flags?: number;
};

export type PlannedMessage = {
  payload: DiscordMessagePayload;
  files: { localPath: string; filename: string }[];
  /** Reactions to add after posting (reactions mode). */
  reactions: string[];
};

const STYLE: Record<NonNullable<NotifyAction["style"]>, 1 | 2 | 4> = { primary: 1, default: 2, danger: 4 };

/** Approve/reject/revise get familiar emoji; anything else is numbered. */
const VERB_EMOJI: Record<string, string> = { approve: "✅", reject: "❌", revise: "✏️", skip: "⏭️", post: "🚀" };
const NUMBERED = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

export const ACTION_MAP_PREFIX = "actions ";

export function emojiFor(actions: NotifyAction[]): Map<string, NotifyAction> {
  const map = new Map<string, NotifyAction>();
  let n = 0;
  for (const a of actions) {
    const verb = a.id.split(/[:\s]/)[0]?.toLowerCase() ?? "";
    let emoji = VERB_EMOJI[verb];
    if (!emoji || map.has(emoji)) emoji = NUMBERED[n++];
    if (!emoji) break; // more than 9 actions: the rest stay typed-only
    map.set(emoji, a);
  }
  return map;
}

/** Footer text: `actions ✅=approve:ap-7 ❌=reject:ap-7`. Parsed back by `parseActionMap`. */
export function actionMapFooter(map: Map<string, NotifyAction>): string {
  return ACTION_MAP_PREFIX + [...map].map(([emoji, a]) => `${emoji}=${a.id}`).join(" ");
}

export function parseActionMap(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!text?.startsWith(ACTION_MAP_PREFIX)) return out;
  for (const part of text.slice(ACTION_MAP_PREFIX.length).split(" ")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

export function buildButtons(actions: NotifyAction[]): DiscordActionRow[] {
  const rows: DiscordActionRow[] = [];
  for (const a of actions.slice(0, 25)) {
    if (a.id.length > CUSTOM_ID_LIMIT) throw new Error(`action id "${a.id.slice(0, 20)}…" is longer than Discord's ${CUSTOM_ID_LIMIT}-character limit`);
    let row = rows[rows.length - 1];
    if (!row || row.components.length === 5) {
      row = { type: 1, components: [] };
      rows.push(row);
    }
    row.components.push({ type: 2, style: STYLE[a.style ?? "default"], label: a.label.slice(0, 80), custom_id: a.id });
  }
  return rows;
}

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

/**
 * Plans the messages for one OutboundMessage. Actions and files go on the last message; the ref footer is
 * the last line of the text so a reply to any part finds the thread.
 */
export function planSend(msg: OutboundMessage, mode: ActionMode): PlannedMessage[] {
  const markdown = msg.format === "markdown";
  const actions = msg.actions ?? [];
  const map = mode === "reactions" ? emojiFor(actions) : new Map<string, NotifyAction>();

  let body = msg.text.trimEnd();
  if (map.size) {
    const hint = [...map].map(([emoji, a]) => `${emoji} ${a.label.toLowerCase()}`).join(" · ");
    body += `\n\nReact to choose: ${hint}`;
  }
  if (msg.ref) body += `\n\n${refFooter(msg.ref)}`;

  // Escaping adds characters, so leave headroom when chunking markdown source.
  const chunks = chunkText(body, markdown ? 1600 : CONTENT_LIMIT);
  const files = (msg.attachments ?? []).slice(0, MAX_FILES);
  if ((msg.attachments ?? []).length > MAX_FILES) throw new Error(`Discord accepts at most ${MAX_FILES} files per message`);

  return chunks.map((chunk, i) => {
    const last = i === chunks.length - 1;
    const payload: DiscordMessagePayload = {
      content: markdown ? toDiscordMarkdown(chunk) : chunk,
      allowed_mentions: { parse: [] },
    };
    if (msg.priority === "low") payload.flags = 4096; // SUPPRESS_NOTIFICATIONS
    const planned: PlannedMessage = { payload, files: [], reactions: [] };
    if (!last) return planned;
    if (mode === "buttons" && actions.length) payload.components = buildButtons(actions);
    if (map.size) {
      payload.embeds = [{ footer: { text: actionMapFooter(map) } }];
      planned.reactions = [...map.keys()];
    }
    if (files.length) {
      planned.files = files.map((f) => ({ localPath: f.localPath, filename: basename(f.localPath) }));
      payload.attachments = files.map((f, id) => ({ id, filename: basename(f.localPath), ...(f.caption ? { description: f.caption.slice(0, 1024) } : {}) }));
    }
    return planned;
  });
}
