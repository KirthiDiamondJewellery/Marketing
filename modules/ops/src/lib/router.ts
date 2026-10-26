import type { InboundMessage } from "@attentionos/core";
import { parseQuietInput, type QuietWindow } from "./quiet-hours.ts";
import { normalizeApprovalRef, parseActionId, parseRef, type Decision } from "./refs.ts";

/**
 * Chat routing, pure: what does an inbound Telegram/Discord message ask for?
 *
 *   button "approve:ap-7"                  → decide ap-7
 *   "approve ap-7", "reject ap-7 too long" → decide, with an optional note
 *   reply to an approval with "yes" / text → approve, or request changes with the text as the note
 *   "rf-123 v2 tighten the intro"          → revise edit rf-123 from v2 (queues editing.revise)
 *   reply to an edit message with notes    → same, ref and version taken from the message replied to
 *   "brief", "approvals", "quiet 21:30-07:00", "quiet off", "demo on|off", "help"
 *   anything else                          → free text for the Chief of Staff
 */

export type Attachment = NonNullable<InboundMessage["attachments"]>[number];

export type Intent =
  | { type: "decide"; ref: string; decision: Decision; note?: string }
  | { type: "revise_edit"; ref: string; version?: number; notes: string; attachments?: Attachment[] }
  | { type: "brief" }
  | { type: "list_approvals" }
  | { type: "quiet"; window: QuietWindow | null }
  | { type: "demo"; on: boolean }
  | { type: "help" }
  | { type: "chat"; text: string; replyToRef?: string; attachments?: Attachment[] }
  | { type: "invalid"; reply: string }
  | { type: "ignore" };

const YES = /^(approve|approved|yes|y|ok|okay|go|ship it|lgtm|👍|✅)[.!]*$/i;
const NO = /^(reject|rejected|no|n|nope|kill it|👎|❌)[.!]*$/i;

/** Strips a leading "/" and Telegram's "@botname" from commands like "/brief@my_bot". */
function normalizeText(text: string): string {
  return text.trim().replace(/^\/([a-z]+)(?:@\w+)?/i, "$1").replace(/\s+/g, " ").trim();
}

export function routeInbound(msg: Pick<InboundMessage, "text" | "actionId" | "replyToRef" | "attachments">): Intent {
  // 1. Buttons and reactions.
  if (msg.actionId) {
    const a = parseActionId(msg.actionId);
    if (a) return a.decision === "revise" ? { type: "invalid", reply: `Reply to the ${a.ref} message with what you'd like changed.` } : { type: "decide", ref: a.ref, decision: a.decision };
    if (msg.actionId === "brief") return { type: "brief" };
    if (msg.actionId === "approvals") return { type: "list_approvals" };
    return { type: "invalid", reply: "That button has expired. Reply \"approvals\" to see what's waiting." };
  }

  const text = normalizeText(msg.text ?? "");
  const attachments = msg.attachments?.length ? msg.attachments : undefined;
  if (!text && !attachments) return { type: "ignore" };

  // 2. Explicit commands.
  let m = /^(approve|ok|yes)\s+((?:ap)?[\s-]?\d{1,9})(?:\s*[:,-]?\s+(.+))?$/i.exec(text);
  if (m) {
    const ref = normalizeApprovalRef(m[2]!);
    if (ref) return { type: "decide", ref, decision: "approve", ...(m[3] ? { note: m[3].trim() } : {}) };
  }
  m = /^(reject|no)\s+((?:ap)?[\s-]?\d{1,9})(?:\s*[:,-]?\s+(.+))?$/i.exec(text);
  if (m) {
    const ref = normalizeApprovalRef(m[2]!);
    if (ref) return { type: "decide", ref, decision: "reject", ...(m[3] ? { note: m[3].trim() } : {}) };
  }
  m = /^(revise|change|changes)\s+((?:ap)?[\s-]?\d{1,9})\s*[:,-]?\s+(.+)$/i.exec(text);
  if (m) {
    const ref = normalizeApprovalRef(m[2]!);
    if (ref) return { type: "decide", ref, decision: "revise", note: m[3]!.trim() };
  }
  m = /^(rf[\s-]?\d{1,9}(?:\s*v\d{1,4})?)\s*[:,-]?\s+([\s\S]+)$/i.exec(text);
  if (m) {
    const r = parseRef(m[1]);
    if (r?.kind === "rf") return { type: "revise_edit", ref: r.ref, ...(r.version ? { version: r.version } : {}), notes: m[2]!.trim(), ...(attachments ? { attachments } : {}) };
  }

  // 3. Replies to one of our messages.
  const replied = parseRef(msg.replyToRef);
  if (replied?.kind === "rf") {
    if (!text && !attachments) return { type: "ignore" };
    return {
      type: "revise_edit",
      ref: replied.ref,
      ...(replied.version ? { version: replied.version } : {}),
      notes: text || "New take attached.",
      ...(attachments ? { attachments } : {}),
    };
  }
  if (replied?.kind === "ap" && text) {
    if (YES.test(text)) return { type: "decide", ref: replied.ref, decision: "approve" };
    if (NO.test(text)) return { type: "decide", ref: replied.ref, decision: "reject" };
    return { type: "decide", ref: replied.ref, decision: "revise", note: text };
  }

  // 4. Short commands.
  const lower = text.toLowerCase();
  if (/^(brief|morning brief|today|start)$/.test(lower)) return { type: "brief" };
  if (/^(approvals?|queue|pending|waiting)$/.test(lower)) return { type: "list_approvals" };
  if (/^(help|commands|\?)$/.test(lower)) return { type: "help" };
  m = /^demo(?: mode)?\s+(on|off)$/i.exec(lower);
  if (m) return { type: "demo", on: m[1] === "on" };
  m = /^quiet(?: hours)?\s+(.+)$/i.exec(lower);
  if (m) {
    try {
      return { type: "quiet", window: parseQuietInput(m[1]!) };
    } catch (e) {
      return { type: "invalid", reply: e instanceof Error ? e.message : "Use a range like 21:30-07:00, or off." };
    }
  }

  // 5. Everything else goes to the Chief of Staff.
  return { type: "chat", text, ...(msg.replyToRef ? { replyToRef: msg.replyToRef } : {}), ...(attachments ? { attachments } : {}) };
}

export const HELP_TEXT = [
  "*Here's what you can send me*",
  "`brief`: today's brief",
  "`approvals`: what's waiting for you",
  "`approve ap-7` or `reject ap-7 too long`: decide, with an optional note",
  "Reply to an approval with your notes to request changes",
  "`rf-12 v2 tighten the intro`, or reply to an edit with notes or a new take: revise a video",
  "`quiet 21:30-07:00` or `quiet off`: quiet hours",
  "`demo on` / `demo off`: hide names for filming",
  "Anything else goes to your Chief of Staff.",
].join("\n");
