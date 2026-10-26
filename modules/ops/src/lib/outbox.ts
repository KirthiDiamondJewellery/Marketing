import { isAbsolute, relative, resolve } from "node:path";
import { ProviderError, type OutboundMessage, type WorkspaceContext } from "@attentionos/core";
import { opsSettings } from "../settings.ts";
import { alertDecision, alertKey, alertText } from "./alerts.ts";
import { mayDeliver, quietUntil } from "./quiet-hours.ts";
import { asJson, loadMasker, quietWindow } from "./store.ts";

/**
 * The channel-agnostic outbox (`messages` table). Everything that wants to reach the owner enqueues here;
 * `ops.dispatch-outbox` delivers through the configured notifier. Dedupe keys make enqueueing idempotent.
 */

export type OutboxBody = OutboundMessage & { _attempts?: number };

export function notifierChannel(ws: WorkspaceContext): string {
  return ws.providers.notifier?.id ?? ws.config.providers.notifier;
}

/** Queues a message. Returns null when a message with the same dedupe key was already queued or sent. */
export async function enqueueMessage(ws: WorkspaceContext, msg: OutboundMessage): Promise<{ id: number } | null> {
  const channel = notifierChannel(ws);
  const rows = await ws.sql<{ id: number }[]>`
    insert into messages (workspace_id, channel, direction, dedupe_key, ref, body, status)
    values (${ws.id}, ${channel}, 'out', ${msg.dedupeKey ?? null}, ${msg.ref ?? null}, ${asJson(ws.sql, msg)}, 'queued')
    on conflict do nothing
    returning id`;
  const row = rows[0];
  return row ? { id: Number(row.id) } : null;
}

/**
 * Raises an alert at most once per dedupe window (alert_log). Repeats inside the window are counted and the
 * next alert mentions them. Returns whether a message was queued.
 */
export async function raiseAlert(
  ws: WorkspaceContext,
  alert: { key: string; text: string; priority?: "normal" | "high"; windowMinutes?: number },
): Promise<{ sent: boolean; suppressed: number }> {
  const key = alertKey(alert.key);
  const windowMs = (alert.windowMinutes ?? opsSettings(ws.config).alertDedupeMinutes) * 60_000;
  const now = ws.now();
  const decision = await ws.sql.begin(async (tx) => {
    const rows = await tx<{ last_sent_at: Date; count: number }[]>`
      select last_sent_at, count from alert_log where workspace_id = ${ws.id} and key = ${key} for update`;
    const prev = rows[0] ? { lastSentAt: new Date(rows[0].last_sent_at), count: Number(rows[0].count) } : null;
    const d = alertDecision(prev, now, windowMs);
    await tx`
      insert into alert_log (workspace_id, key, last_sent_at, count)
      values (${ws.id}, ${key}, ${d.next.lastSentAt}, ${d.next.count})
      on conflict (workspace_id, key) do update set last_sent_at = excluded.last_sent_at, count = excluded.count`;
    return d;
  });
  if (!decision.send) return { sent: false, suppressed: decision.suppressed };
  await enqueueMessage(ws, {
    text: alertText(alert.text, decision.suppressed),
    format: "markdown",
    priority: alert.priority ?? "normal",
    dedupeKey: `alert:${key}:${now.toISOString().slice(0, 16)}`,
  });
  return { sent: true, suppressed: decision.suppressed };
}

export type DispatchResult = { sent: number; failed: number; held: number; retrying: number; heldUntil?: string };

const TRANSIENT = new Set(["rate_limited", "upstream"]);

/** Resolves attachment paths against the workspace and refuses anything outside it. */
function resolveAttachments(ws: WorkspaceContext, msg: OutboundMessage): OutboundMessage {
  if (!msg.attachments?.length) return msg;
  const root = resolve(ws.paths.root);
  const attachments = msg.attachments.flatMap((a) => {
    const full = isAbsolute(a.localPath) ? resolve(a.localPath) : resolve(root, a.localPath);
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      ws.log.warn("outbox: dropped an attachment outside the workspace");
      return [];
    }
    return [{ ...a, localPath: full }];
  });
  return { ...msg, attachments };
}

/**
 * Delivers queued messages. Each row is claimed in its own transaction (FOR UPDATE SKIP LOCKED), so two
 * dispatchers never send the same message. During quiet hours only high-priority messages go out; the rest
 * wait. In demo mode, other people's names are masked on the way out.
 */
export async function dispatchOutbox(ws: WorkspaceContext, opts: { limit?: number } = {}): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, failed: 0, held: 0, retrying: 0 };
  const notifier = ws.providers.notifier;
  if (!notifier) return result;
  const settings = opsSettings(ws.config);
  const tz = ws.config.workspace.timezone;
  const now = ws.now();
  const window = await quietWindow(ws);
  const masker = await loadMasker(ws);
  const channel = notifierChannel(ws);

  const candidates = await ws.sql<{ id: number; body: OutboxBody }[]>`
    select id, body from messages
     where workspace_id = ${ws.id} and channel = ${channel} and direction = 'out' and status = 'queued'
     order by id
     limit ${opts.limit ?? settings.dispatchBatch * 3}`;

  let attempted = 0;
  for (const c of candidates) {
    if (attempted >= (opts.limit ?? settings.dispatchBatch)) break;
    if (!mayDeliver(c.body.priority, now, tz, window)) {
      result.held++;
      continue;
    }
    attempted++;
    await ws.sql.begin(async (tx) => {
      const rows = await tx<{ id: number; body: OutboxBody }[]>`
        select id, body from messages where id = ${c.id} and workspace_id = ${ws.id} and status = 'queued' for update skip locked`;
      const row = rows[0];
      if (!row) return;
      const { _attempts, ...body } = row.body;
      const attempts = (_attempts ?? 0) + 1;
      const outgoing = resolveAttachments(ws, masker.on ? { ...body, text: masker.text(body.text) } : body);
      try {
        const sent = await deliver(ws, outgoing);
        await tx`update messages set status = 'sent', sent_at = now(), provider_message_id = ${sent.messageId}, error = null where workspace_id = ${ws.id} and id = ${row.id}`;
        result.sent++;
      } catch (e) {
        const code = e instanceof ProviderError ? e.code : undefined;
        const message = e instanceof Error ? e.message : String(e);
        const retry = (code === undefined || TRANSIENT.has(code)) && attempts < settings.maxSendAttempts;
        await tx`
          update messages
             set status = ${retry ? "queued" : "failed"}, error = ${message.slice(0, 500)},
                 body = ${asJson(tx as never, { ...body, _attempts: attempts })}
           where workspace_id = ${ws.id} and id = ${row.id}`;
        if (retry) result.retrying++;
        else result.failed++;
        ws.log.warn("outbox: delivery failed", { id: row.id, code, retry });
      }
    });
  }
  if (result.held) {
    const until = quietUntil(now, tz, window);
    if (until) result.heldUntil = until.toISOString();
  }
  return result;
}

/**
 * Sends one message. If the channel refuses an attachment (too large, wrong type), the text still goes out
 * with a note saying where the file is, rather than failing the whole message.
 */
async function deliver(ws: WorkspaceContext, msg: OutboundMessage): Promise<{ messageId: string }> {
  const notifier = ws.providers.notifier!;
  try {
    return await notifier.send(msg);
  } catch (e) {
    if (!(e instanceof ProviderError) || e.code !== "invalid_request" || !msg.attachments?.length) throw e;
    const where = msg.attachments.map((a) => relative(ws.paths.root, a.localPath)).join(", ");
    const { attachments: _dropped, ...rest } = msg;
    return notifier.send({ ...rest, text: `${msg.text}\n\n(The file couldn't be sent here. It's in your workspace at ${where}.)` });
  }
}
