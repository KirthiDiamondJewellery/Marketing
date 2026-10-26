import { ToolError, type Actor, type InboundMessage, type WorkspaceContext } from "@attentionos/core";
import { SETTING_KEYS } from "../settings.ts";
import { decideApproval, decisionReply, listApprovals } from "./approvals.ts";
import { composeBrief } from "./brief.ts";
import { loadBriefData } from "./brief-data.ts";
import { dispatchOutbox, enqueueMessage, notifierChannel } from "./outbox.ts";
import { HELP_TEXT, routeInbound, type Intent } from "./router.ts";
import { asJson, enqueueRun, getSetting, loadMasker, setSetting } from "./store.ts";

/** Job ids other modules own that chat can trigger. */
export const REVISE_JOB_ID = "editing.revise";
export const CHIEF_OF_STAFF_JOB_ID = "ops.chief-of-staff";

export type Handled = { messageId: string; intent: Intent["type"]; reply?: string };

export type ProcessResult = {
  received: number;
  handled: Handled[];
  /** Free-text messages left for the caller to answer (Copilot mode: Claude answers them in the session). */
  forYou: { from: string; at: string; text: string; replyToRef?: string }[];
};

function chatActor(msg: InboundMessage): Actor {
  return `user:${msg.channel}:${msg.from}`;
}

/** Applies one routed intent. Returns the reply to send back, if any. */
export async function applyIntent(
  ws: WorkspaceContext,
  msg: InboundMessage,
  intent: Intent,
  opts: { enqueueChat: boolean },
): Promise<{ reply?: string; forYou?: boolean }> {
  switch (intent.type) {
    case "ignore":
      return {};
    case "invalid":
      return { reply: intent.reply };
    case "help":
      return { reply: HELP_TEXT };

    case "decide": {
      try {
        const r = await decideApproval(ws, { ref: intent.ref, decision: intent.decision, ...(intent.note ? { note: intent.note } : {}), actor: chatActor(msg) });
        return { reply: decisionReply(r) };
      } catch (e) {
        if (e instanceof ToolError) return { reply: [e.message, e.hint].filter(Boolean).join(" ") };
        throw e;
      }
    }

    case "revise_edit": {
      const rows = await ws.sql<{ ref: string; version: number; status: string }[]>`
        select ref, version, status from edit_jobs where workspace_id = ${ws.id} and ref = ${intent.ref}`;
      const job = rows[0];
      if (!job) return { reply: `I couldn't find ${intent.ref}. Check the ref on the video message and try again.` };
      const fromVersion = intent.version ?? job.version;
      const queued = await enqueueRun(ws, {
        jobId: REVISE_JOB_ID,
        agent: "art_director",
        trigger: "chat",
        createdBy: chatActor(msg),
        dedupeKey: `chat:${msg.channel}:${msg.messageId}`,
        input: {
          ref: intent.ref,
          fromVersion,
          notes: intent.notes,
          ...(intent.attachments ? { attachments: intent.attachments } : {}),
          source: { channel: msg.channel, messageId: msg.messageId },
        },
      });
      if (!queued) return { reply: `${intent.ref}: already working on that.` };
      const extra = intent.attachments?.some((a) => a.kind === "video") ? " with your new take" : " with your notes";
      return { reply: `${intent.ref}: on it. Art Director is re-cutting v${fromVersion}${extra}. You'll get v${fromVersion + 1} here.` };
    }

    case "brief": {
      const masker = await loadMasker(ws);
      const brief = composeBrief(await loadBriefData(ws), { mask: masker.text });
      return { reply: brief.markdown };
    }

    case "list_approvals": {
      const { total, items } = await listApprovals(ws, { status: "pending", limit: 10 });
      if (!total) return { reply: "Nothing is waiting for you. Your agents are on it." };
      const lines = items.map((a) => `• ${a.ref} · ${a.agent}: ${a.summary}`);
      if (total > items.length) lines.push(`and ${total - items.length} more`);
      return { reply: [`*${total} waiting for you*`, ...lines, "", "Reply `approve ap-7` or `reject ap-7 <why>`."].join("\n") };
    }

    case "quiet": {
      const tz = ws.config.workspace.timezone;
      if (!intent.window) {
        await setSetting(ws, SETTING_KEYS.quietHours, { off: true });
        return { reply: "Quiet hours are off. Messages go out as they happen." };
      }
      await setSetting(ws, SETTING_KEYS.quietHours, intent.window);
      return { reply: `Quiet hours set: ${intent.window.start} to ${intent.window.end} (${tz}). Urgent alerts still come through.` };
    }

    case "demo": {
      await setSetting(ws, SETTING_KEYS.demoMode, { on: intent.on });
      return { reply: intent.on ? "Demo mode is on. Names and handles are hidden; numbers stay real." : "Demo mode is off." };
    }

    case "chat": {
      if (!opts.enqueueChat) return { forYou: true };
      await enqueueRun(ws, {
        jobId: CHIEF_OF_STAFF_JOB_ID,
        agent: "chief_of_staff",
        trigger: "chat",
        createdBy: chatActor(msg),
        dedupeKey: `chat:${msg.channel}:${msg.messageId}`,
        input: {
          text: intent.text,
          channel: msg.channel,
          messageId: msg.messageId,
          ...(intent.replyToRef ? { replyToRef: intent.replyToRef } : {}),
          ...(intent.attachments ? { attachments: intent.attachments } : {}),
        },
      });
      return {};
    }
  }
}

/**
 * Pulls new messages from the notifier, records each one (so nothing is handled twice even if the cursor
 * isn't saved), routes it, and queues replies. Replies are delivered right away.
 */
export async function processInbound(ws: WorkspaceContext, opts: { enqueueChat?: boolean } = {}): Promise<ProcessResult> {
  const notifier = ws.providers.notifier;
  const result: ProcessResult = { received: 0, handled: [], forYou: [] };
  if (!notifier) return result;
  const enqueueChat = opts.enqueueChat ?? ws.config.mode === "autopilot";
  const channel = notifierChannel(ws);
  const cursorKey = SETTING_KEYS.inboundCursor(channel);
  const saved = await getSetting<{ cursor?: string }>(ws, cursorKey);
  const { messages, cursor } = await notifier.receive(saved?.cursor);
  result.received = messages.length;

  for (const msg of messages) {
    const recorded = await ws.sql<{ id: number }[]>`
      insert into messages (workspace_id, channel, direction, dedupe_key, ref, body, status)
      values (${ws.id}, ${channel}, 'in', ${`in:${msg.messageId}`}, ${msg.replyToRef ?? null}, ${asJson(ws.sql, msg)}, 'received')
      on conflict do nothing returning id`;
    const row = recorded[0];
    if (!row) continue; // already handled

    const intent = routeInbound(msg);
    let outcome: { reply?: string; forYou?: boolean };
    try {
      outcome = await applyIntent(ws, msg, intent, { enqueueChat });
    } catch (e) {
      ws.log.error("chat: could not handle a message", { error: e instanceof Error ? e.message : String(e), intent: intent.type });
      outcome = { reply: "Something went wrong on my side. Try again in a minute, or run /attention:doctor." };
    }
    if (outcome.forYou && intent.type === "chat") {
      result.forYou.push({ from: msg.from, at: msg.at, text: intent.text, ...(intent.replyToRef ? { replyToRef: intent.replyToRef } : {}) });
    }
    if (outcome.reply) {
      await enqueueMessage(ws, { text: outcome.reply, format: "markdown", dedupeKey: `reply:${msg.messageId}`, priority: "high" });
    }
    await ws.sql`update messages set status = 'handled' where workspace_id = ${ws.id} and id = ${row.id}`;
    result.handled.push({ messageId: msg.messageId, intent: intent.type, ...(outcome.reply ? { reply: outcome.reply } : {}) });
  }

  await setSetting(ws, cursorKey, { cursor });
  if (result.handled.some((h) => h.reply)) await dispatchOutbox(ws);
  return result;
}
