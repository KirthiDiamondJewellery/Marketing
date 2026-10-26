"use server";

import { requireSession } from "@/server/auth";
import { revalidatePath } from "next/cache";
import { decideApproval, enqueueRun, requestApproval, ApprovalError } from "@attentionos/db";
import { workspace } from "@/server/workspace";
import { z } from "zod";
import { BAD_REQUEST, id as uuid, parse } from "@/server/validate";

/**
 * Inbox mutations. Studio never sends a reply itself: "Approve and send" records the person's approval of the exact
 * text, then queues the Community agent's send-approved job, which sends through the inbox provider.
 */

export type InboxResult = { ok: true; message: string } | { ok: false; error: string };

const ACTOR = "user:studio" as const;

type Item = { id: string; kind: "dm" | "comment"; from_handle: string | null; text: string; draft_reply: string | null; status: string };

const sendInput = z.object({ itemId: uuid, text: z.string().max(20_000) });

export async function approveAndSend(rawItemId: string, rawText: string): Promise<InboxResult> {
  await requireSession();
  const args = parse(sendInput, { itemId: rawItemId, text: rawText });
  if (!args) return { ok: false, error: typeof rawText === "string" && rawText.length > 20_000 ? "That reply is far too long. Keep DMs under 900 characters." : BAD_REQUEST };
  const { itemId, text } = args;
  const ws = workspace();
  const reply = text.replace(/\r\n/g, "\n").trim();
  const [item] = await ws.sql<Item[]>`
    select id, kind, from_handle, text, draft_reply, status from triage_items where workspace_id = ${ws.id} and id = ${itemId}`;
  if (!item) return { ok: false, error: "That conversation is gone." };
  if (item.status === "sent") return { ok: false, error: "That reply was already sent." };
  if (!reply) return { ok: false, error: "Write a reply first." };
  const max = item.kind === "comment" ? 300 : 900;
  if (reply.length > max) return { ok: false, error: `Keep ${item.kind === "comment" ? "comment replies" : "DMs"} under ${max} characters (this one is ${reply.length}).` };

  const who = item.from_handle ? `@${item.from_handle.replace(/^@+/, "")}` : "them";
  const kind = item.kind === "dm" ? "dm_reply" : "comment_reply";
  const preview = { text: reply, to: who, theirMessage: item.text.slice(0, 300), kind: item.kind };
  const summary = `Reply to ${who}${item.kind === "comment" ? " on your post" : ""}: "${reply.slice(0, 80)}${reply.length > 80 ? "…" : ""}"`;

  try {
    await ws.sql`update triage_items set draft_reply = ${reply}, status = 'drafted' where workspace_id = ${ws.id} and id = ${item.id} and status <> 'sent'`;

    // Reuse the approval already waiting for this item (whatever surface created it) instead of adding a duplicate.
    const [pending] = await ws.sql<{ id: string; ref: string; preview: Record<string, unknown> | null }[]>`
      select id, ref, preview from approvals
       where workspace_id = ${ws.id} and status = 'pending' and subject_id = ${item.id} and kind in ('dm_reply', 'comment_reply')
       order by requested_at desc limit 1`;
    let ref: string;
    if (pending) {
      await ws.sql`
        update approvals
           set subject_type = 'triage_items', summary = ${summary},
               preview = coalesce(preview, '{}'::jsonb) || ${ws.sql.json(preview as never)}
         where workspace_id = ${ws.id} and id = ${pending.id}`;
      ref = pending.ref;
    } else {
      // An earlier approval only covers the words it approved: expire it if the text changed.
      await ws.sql`
        update approvals set status = 'expired', decision_note = 'reply text changed after approval'
         where workspace_id = ${ws.id} and subject_id = ${item.id} and kind = ${kind} and status = 'approved'
           and coalesce(preview ->> 'text', '') <> ${reply}`;
      const [already] = await ws.sql<{ ref: string }[]>`
        select ref from approvals where workspace_id = ${ws.id} and subject_id = ${item.id} and kind = ${kind} and status = 'approved' limit 1`;
      if (already) {
        ref = already.ref;
      } else {
        const { approval } = await requestApproval(ws.sql, ws.id, { kind, subjectType: "triage_items", subjectId: item.id, agent: "community", summary, preview });
        ref = approval.ref;
      }
    }
    const [state] = await ws.sql<{ status: string }[]>`select status from approvals where workspace_id = ${ws.id} and ref = ${ref}`;
    if (state?.status === "pending") await decideApproval(ws.sql, ws.id, { refOrId: ref, decision: "approved", actor: ACTOR });
    await enqueueRun(ws.sql, {
      workspaceId: ws.id,
      jobId: "community.send-approved",
      agent: "community",
      input: {},
      trigger: "manual",
      createdBy: ACTOR,
      skipIfActive: true,
    });
  } catch (err) {
    return { ok: false, error: err instanceof ApprovalError ? err.message : `Couldn't approve that reply: ${(err as Error).message}` };
  }
  revalidatePath("/inbox");
  revalidatePath("/approvals");
  return { ok: true, message: `Approved. Community sends the reply to ${who} next.` };
}

export async function ignoreItem(rawItemId: string): Promise<InboxResult> {
  await requireSession();
  const itemId = parse(uuid, rawItemId);
  if (!itemId) return { ok: false, error: "That conversation was already handled." };
  const ws = workspace();
  const [item] = await ws.sql<Item[]>`
    update triage_items set status = 'ignored' where workspace_id = ${ws.id} and id = ${itemId} and status <> 'sent'
    returning id, kind, from_handle, text, draft_reply, status`;
  if (!item) return { ok: false, error: "That conversation was already handled." };
  const pending = await ws.sql<{ ref: string }[]>`
    select ref from approvals where workspace_id = ${ws.id} and status = 'pending' and subject_id = ${item.id} and kind in ('dm_reply', 'comment_reply')`;
  for (const p of pending) {
    await decideApproval(ws.sql, ws.id, { refOrId: p.ref, decision: "rejected", actor: ACTOR, note: "Ignored from the inbox" }).catch((err) => {
      // The item is already ignored; a leftover pending reply only waits in Approvals, where it can still be rejected.
      console.error("[studio] rejecting the reply for an ignored item failed:", err);
    });
  }
  revalidatePath("/inbox");
  revalidatePath("/approvals");
  const who = item.from_handle ? `@${item.from_handle.replace(/^@+/, "")}` : "this conversation";
  return { ok: true, message: `Ignored ${who}` };
}

export async function restoreItem(rawItemId: string): Promise<InboxResult> {
  await requireSession();
  const itemId = parse(uuid, rawItemId);
  if (!itemId) return { ok: false, error: "Only ignored items can be brought back." };
  const ws = workspace();
  const [row] = await ws.sql<{ id: string }[]>`
    update triage_items set status = case when draft_reply is null then 'new' else 'drafted' end
     where workspace_id = ${ws.id} and id = ${itemId} and status = 'ignored' returning id`;
  if (!row) return { ok: false, error: "Only ignored items can be brought back." };
  revalidatePath("/inbox");
  return { ok: true, message: "Back in the inbox" };
}
