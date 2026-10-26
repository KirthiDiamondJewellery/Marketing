"use client";
import Link from "next/link";
import { useMemo } from "react";
import { motion } from "motion/react";
import { useLive } from "@/lib/use-live";
import { cn } from "@/components/ui";
import { clock, relTime } from "@/components/shell/format";
import { useNow } from "@/components/shell/use-now";

type Ev = { id: number; ts: string; kind: string; message: string; runId: string | null };

/** This agent's own stream: server history merged with live events as they arrive. */
export function AgentActivity({ agent, initial, tz }: { agent: string; initial: Ev[]; tz?: string }) {
  const { events } = useLive();
  const now = useNow(15_000);
  const list = useMemo(() => {
    const map = new Map<number, Ev>();
    for (const e of initial) map.set(e.id, e);
    for (const e of events) if (e.agent === agent) map.set(e.id, { id: e.id, ts: e.ts, kind: e.kind, message: e.message, runId: e.runId });
    return [...map.values()].filter((e) => e.kind !== "tool").sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 14);
  }, [initial, events, agent]);
  const firstIds = useMemo(() => new Set(initial.map((e) => e.id)), [initial]);
  if (!list.length) return <p className="text-small text-fg-2">Nothing yet. Steps show up here live while this agent works.</p>;
  return (
    <ol className="relative flex flex-col">
      <span aria-hidden className="absolute bottom-2 left-[3px] top-2 w-px bg-border" />
      {list.map((e) => (
        <motion.li key={e.id} initial={firstIds.has(e.id) ? false : { opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="relative flex gap-4 py-2 pl-5">
          <span aria-hidden className={cn("absolute left-0 top-[15px] size-[7px] rounded-full border border-bg", e.kind === "error" ? "bg-danger" : e.kind === "approval" ? "bg-brand" : "bg-border-strong")} />
          <div className="min-w-0 flex-1">
            <p className="text-small text-fg">{e.message}</p>
            <div className="mt-0.5 flex gap-2 text-caption text-fg-3" suppressHydrationWarning>
              <span title={clock(e.ts, tz)} suppressHydrationWarning>{relTime(e.ts, now)}</span>
              {e.runId ? (
                <Link href={`/activity/runs/${e.runId}`} className="hover:text-fg">
                  Details
                </Link>
              ) : null}
            </div>
          </div>
        </motion.li>
      ))}
    </ol>
  );
}
