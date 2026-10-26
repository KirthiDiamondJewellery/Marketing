import { isAbsolute, relative, resolve } from "node:path";
import { compact, defineTool, ToolError } from "@attentionos/core";
import { z } from "zod";
import { dispatchOutbox, enqueueMessage } from "../lib/outbox.ts";

export const sendNotificationTool = defineTool({
  name: "ops_send_notification",
  description:
    "Sends a message to the owner on their chat channel (Telegram, Discord or console). Messages go through the outbox: a dedupeKey makes sending idempotent, quiet hours hold normal and low priority messages until morning, and demo mode masks names. " +
    "Use the markdown subset *bold*, _italic_, `code`, [link](url). Attach files by workspace-relative path (e.g. media/renders/rf-12-v2.mp4). This only reaches the owner; it never posts publicly.",
  input: z.object({
    text: z.string().min(1).max(8000),
    format: z.enum(["plain", "markdown"]).default("markdown"),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    ref: z.string().max(40).optional().describe('Thread ref so replies come back to it, e.g. "rf-12 v2" or "ap-7"'),
    dedupeKey: z.string().max(200).optional(),
    actions: z.array(z.object({ id: z.string().max(64), label: z.string().max(40), style: z.enum(["primary", "danger", "default"]).optional() })).max(6).optional(),
    attachments: z.array(z.object({ path: z.string(), caption: z.string().max(1000).optional() })).max(5).optional(),
    sendNow: z.boolean().default(true).describe("Deliver right away instead of waiting for the next outbox run"),
  }),
  annotations: { idempotent: true },
  async handler({ ws }, input) {
    const root = resolve(ws.paths.root);
    const attachments = input.attachments?.map((a) => {
      const full = resolve(root, a.path);
      const rel = relative(root, full);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new ToolError(`${a.path} is outside the workspace.`, "Attach files from inside the workspace, such as media/renders/.");
      return { localPath: rel, ...(a.caption ? { caption: a.caption } : {}) };
    });
    const queued = await enqueueMessage(ws, {
      text: input.text,
      format: input.format,
      priority: input.priority,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      ...(input.actions ? { actions: input.actions } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });
    if (!queued) return { status: "duplicate", message: "A message with this dedupeKey was already sent." };
    if (!ws.providers.notifier) return { status: "queued", message: "No chat channel is set up yet; the message will go out once one is connected." };
    const delivery = input.sendNow ? await dispatchOutbox(ws) : undefined;
    const held = delivery && delivery.held > 0 && delivery.sent === 0;
    return compact({
      status: held ? "held" : delivery ? "sent" : "queued",
      message: held ? `Quiet hours: it will arrive after ${delivery.heldUntil ?? "they end"}.` : undefined,
      delivery,
    });
  },
});
