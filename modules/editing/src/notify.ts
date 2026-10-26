import type { OutboundMessage, WorkspaceContext } from "@attentionos/core";

/**
 * Queues a message in the channel-agnostic outbox (`messages`); the ops module delivers it through the configured
 * notifier. Idempotent by dedupe key.
 */
export async function notify(ws: WorkspaceContext, msg: OutboundMessage): Promise<boolean> {
  const channel = ws.providers.notifier?.id ?? ws.config.providers.notifier;
  const rows = await ws.sql`
    insert into messages (workspace_id, channel, direction, dedupe_key, ref, body, status)
    values (${ws.id}, ${channel}, 'out', ${msg.dedupeKey ?? null}, ${msg.ref ?? null}, ${ws.sql.json(msg as never)}, 'queued')
    on conflict do nothing
    returning id`;
  return rows.length > 0;
}
