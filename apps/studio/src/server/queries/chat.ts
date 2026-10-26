import "server-only";
import { workspace } from "@/server/workspace";

export type ChatMessage = {
  id: number;
  direction: "in" | "out";
  channel: string;
  text: string;
  status: string;
  at: string;
  messageId: string | null;
  /** For replies from the Chief of Staff: the Studio message they answer. */
  replyTo: string | null;
};

export type ChatPending = { runId: string; messageId: string; status: "queued" | "running" | "failed"; error: string | null; at: string };

export type ChatState = {
  messages: ChatMessage[];
  pending: ChatPending[];
  mode: "copilot" | "autopilot";
};

export async function getChat(limit = 80): Promise<ChatState> {
  const ws = workspace();
  const sql = ws.sql;
  const rows = await sql<{ id: string; direction: "in" | "out"; channel: string; body: Record<string, unknown>; status: string; created_at: Date; dedupe_key: string | null }[]>`
    select id, direction, channel, body, status, created_at, dedupe_key from (
      select * from messages where workspace_id = ${ws.id} order by created_at desc, id desc limit ${limit}
    ) m order by created_at asc, id asc`;
  const messages = rows.map<ChatMessage>((r) => {
    const body = r.body ?? {};
    const dedupe = r.dedupe_key ?? (typeof body.dedupeKey === "string" ? body.dedupeKey : null);
    return {
      id: Number(r.id),
      direction: r.direction,
      channel: r.channel,
      text: typeof body.text === "string" ? body.text : "",
      status: r.status,
      at: r.created_at.toISOString(),
      messageId: typeof body.messageId === "string" ? body.messageId : null,
      replyTo: dedupe?.startsWith("cos:") ? dedupe.slice(4) : null,
    };
  });
  const pendingRows = await sql<{ id: string; status: "queued" | "running" | "failed"; error: string | null; input: Record<string, unknown>; created_at: Date }[]>`
    select id, status, error, input, created_at from agent_runs
     where workspace_id = ${ws.id} and job_id = 'ops.chief-of-staff'
       and (status in ('queued', 'running') or (status = 'failed' and finished_at > now() - interval '1 hour'))
       and input->>'channel' = 'studio'
     order by created_at asc`;
  const answered = new Set(messages.map((m) => m.replyTo).filter(Boolean));
  return {
    messages,
    pending: pendingRows
      .filter((p) => typeof p.input?.messageId === "string" && !answered.has(p.input.messageId as string))
      .map((p) => ({ runId: p.id, messageId: p.input.messageId as string, status: p.status, error: p.error, at: p.created_at.toISOString() })),
    mode: ws.config.mode,
  };
}
