import type { Sql } from "@attentionos/core";
import { recordAgentEvents, type AgentEventInput, type AgentEventKind } from "@attentionos/db";

const MAX_MESSAGE = 2000;

export const truncate = (s: string, n = MAX_MESSAGE) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Buffers run events and writes them in small batches so a chatty run doesn't do one insert per token block. */
export class EventSink {
  private buffer: AgentEventInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly sql: Sql,
    private readonly base: { workspaceId: string; agent: string; runId: string },
    private readonly onError: (err: unknown) => void = () => {},
    private readonly flushMs = 750,
  ) {}

  push(kind: AgentEventKind, message: string, data?: Record<string, unknown>): void {
    this.buffer.push({ ...this.base, kind, message: truncate(message), data: data ?? null });
    if (this.buffer.length >= 20) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.flushMs);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (!batch.length) return this.flushing;
    this.flushing = this.flushing.then(() => recordAgentEvents(this.sql, batch).catch(this.onError));
    return this.flushing;
  }
}
