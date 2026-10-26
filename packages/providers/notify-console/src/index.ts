import { existsSync, readFileSync } from "node:fs";
import type { AttentionOSConfig, InboundMessage, Logger, Notifier, OutboundMessage, ProviderHealth } from "@attentionos/core";
import { z } from "zod";

/**
 * Console notifier for development and tests (`providers.notifier: "console"`).
 *
 * - `send` prints a readable block to stderr (stdout is reserved for MCP and CLI output) and keeps a copy in
 *   `sent` for tests.
 * - `receive` returns messages added with `inject()` plus, when ATTENTIONOS_CONSOLE_INBOX names a file, any
 *   JSON lines appended to it, e.g. `{"text":"approve ap-7"}` or `{"actionId":"approve:ap-7"}`.
 *   The cursor is the number of lines already read.
 */

export type CreateOptions = {
  secret(name: string): string | undefined;
  config: AttentionOSConfig;
  log: Logger;
  write?: (text: string) => void;
  now?: () => Date;
};

export interface ConsoleNotifier extends Notifier {
  readonly id: "console";
  readonly sent: (OutboundMessage & { messageId: string })[];
  inject(msg: Partial<InboundMessage> & { text?: string }): InboundMessage;
}

const inboxLine = z.object({
  text: z.string().default(""),
  replyToRef: z.string().optional(),
  actionId: z.string().optional(),
  from: z.string().default("console"),
});

/** Plain-text rendering used by `send`; exported for tests. */
export function renderConsole(msg: OutboundMessage, messageId: string): string {
  const lines = [`── message ${messageId}${msg.ref ? ` · ${msg.ref}` : ""}${msg.priority && msg.priority !== "normal" ? ` · ${msg.priority}` : ""}`];
  lines.push(msg.text.trimEnd());
  for (const a of msg.attachments ?? []) lines.push(`[file] ${a.localPath}${a.caption ? ` (${a.caption})` : ""}`);
  if (msg.actions?.length) lines.push(`[actions] ${msg.actions.map((a) => `${a.label} = ${a.id}`).join("  |  ")}`);
  return lines.join("\n") + "\n";
}

export function create(opts: CreateOptions): ConsoleNotifier {
  const write = opts.write ?? ((t: string) => process.stderr.write(t));
  const now = opts.now ?? (() => new Date());
  const inboxPath = opts.secret("ATTENTIONOS_CONSOLE_INBOX");
  const sent: (OutboundMessage & { messageId: string })[] = [];
  const queue: InboundMessage[] = [];
  let seq = 0;
  let injected = 0;

  return {
    id: "console",
    sent,

    async health(): Promise<ProviderHealth> {
      return { ok: true, detail: "Messages print in this terminal (development only)" };
    },

    async send(msg) {
      const messageId = `console-${++seq}`;
      sent.push({ ...msg, messageId });
      write(renderConsole(msg, messageId));
      return { messageId };
    },

    inject(partial) {
      const msg: InboundMessage = {
        channel: "console",
        messageId: partial.messageId ?? `in-${++injected}`,
        text: partial.text ?? "",
        from: partial.from ?? "console",
        at: partial.at ?? now().toISOString(),
        ...(partial.replyToRef ? { replyToRef: partial.replyToRef } : {}),
        ...(partial.actionId ? { actionId: partial.actionId } : {}),
        ...(partial.attachments ? { attachments: partial.attachments } : {}),
      };
      queue.push(msg);
      return msg;
    },

    async receive(cursor) {
      const messages = queue.splice(0, queue.length);
      let read = Number(cursor ?? "0") || 0;
      if (inboxPath && existsSync(inboxPath)) {
        const lines = readFileSync(inboxPath, "utf8").split("\n").filter((l) => l.trim());
        for (let i = read; i < lines.length; i++) {
          try {
            const p = inboxLine.parse(JSON.parse(lines[i]!));
            messages.push({
              channel: "console",
              messageId: `file-${i + 1}`,
              text: p.text,
              from: p.from,
              at: now().toISOString(),
              ...(p.replyToRef ? { replyToRef: p.replyToRef } : {}),
              ...(p.actionId ? { actionId: p.actionId } : {}),
            });
          } catch {
            opts.log.warn("console inbox: skipped a line that isn't valid JSON", { line: i + 1 });
          }
        }
        read = lines.length;
      }
      return { messages, cursor: String(read) };
    },
  };
}

export default create;
