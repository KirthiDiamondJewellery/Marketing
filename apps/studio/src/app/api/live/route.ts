import { requireSession } from "@/server/auth";
import { buildSnapshot, eventsSince } from "@/server/snapshot";
import { workspace } from "@/server/workspace";
import type { LiveMessage } from "@/lib/live";

export const dynamic = "force-dynamic";

/** Server-sent events: a snapshot every 5s and new agent events every second. */
export async function GET(request: Request) {
  await requireSession();
  const ws = workspace();
  const encoder = new TextEncoder();
  let lastId = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticks = 0;
  // One tick at a time: a slow snapshot query must not pile up behind the next interval for this client.
  let busy = false;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (msg: LiveMessage) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
      const snap = await buildSnapshot(ws);
      lastId = snap.events.at(-1)?.id ?? 0;
      send({ type: "snapshot", data: snap });
      timer = setInterval(async () => {
        if (busy || closed) return;
        busy = true;
        try {
          ticks++;
          const events = await eventsSince(ws, lastId);
          if (closed) return;
          if (events.length) {
            lastId = events.at(-1)!.id;
            send({ type: "events", data: events });
          }
          if (ticks % 5 === 0) {
            const next = await buildSnapshot(ws);
            if (!closed) send({ type: "snapshot", data: next });
          } else controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // Database hiccup: keep the stream open and try again next tick.
        } finally {
          busy = false;
        }
      }, 1000);
      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away: nothing left to clean up.
        }
      });
    },
    cancel() {
      closed = true;
      clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
