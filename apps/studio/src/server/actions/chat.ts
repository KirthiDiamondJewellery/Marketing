"use server";

import { requireSession } from "@/server/auth";
import { randomUUID } from "node:crypto";
import { enqueueRun } from "@attentionos/db";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { parse } from "@/server/validate";
import type { ActionResult } from "./approvals";

/** Job and input shape owned by modules/ops (chiefOfStaffJob). */
const CHIEF_OF_STAFF_JOB_ID = "ops.chief-of-staff";

/**
 * Sends a message to the Chief of Staff from Studio: records it in `messages` (channel "studio") and queues
 * ops.chief-of-staff, which answers through the outbox with dedupe key `cos:<messageId>`.
 */
export async function sendChatAction(rawText: string): Promise<ActionResult & { messageId?: string; runId?: string }> {
  await requireSession();
  const text = parse(z.string().max(100_000), rawText);
  if (text === undefined) return { ok: false, error: typeof rawText === "string" ? "That's a long one. Keep it under 4,000 characters." : "Write a message first." };
  const clean = text.trim();
  if (!clean) return { ok: false, error: "Write a message first." };
  if (clean.length > 4000) return { ok: false, error: "That's a long one. Keep it under 4,000 characters." };
  const ws = workspace();
  const messageId = `studio-${randomUUID()}`;
  const at = new Date().toISOString();
  try {
    await ws.sql`
      insert into messages (workspace_id, channel, direction, dedupe_key, body, status)
      values (${ws.id}, 'studio', 'in', ${`in:${messageId}`}, ${ws.sql.json({ from: "owner", text: clean, messageId, at } as never)}, 'received')`;
    const { id } = await enqueueRun(ws.sql, {
      workspaceId: ws.id,
      jobId: CHIEF_OF_STAFF_JOB_ID,
      agent: "chief_of_staff",
      trigger: "chat",
      createdBy: "user:studio",
      dedupeKey: `chat:studio:${messageId}`,
      input: { text: clean, channel: "studio", messageId },
      maxAttempts: 2,
    });
    return { ok: true, messageId, runId: id };
  } catch (e) {
    console.error("[studio] chat send failed:", e);
    return { ok: false, error: "Couldn't send that. Check the database connection and try again." };
  }
}

/** Fresh chat state for the quick-open panel and live updates. */
export async function loadChatAction(): Promise<import("@/server/queries/chat").ChatState> {
  await requireSession();
  const { getChat } = await import("@/server/queries/chat");
  return getChat();
}
