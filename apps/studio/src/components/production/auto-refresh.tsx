"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useLive } from "@/lib/use-live";

/**
 * Keeps a server-rendered production page fresh while work is in flight: refreshes when the given agents (the Art Director
 * and the Publisher by default) report progress (live stream), and every `everyMs` as a fallback. Idle pages don't poll.
 */
export function AutoRefresh({ active, everyMs = 4000, agents = ["art_director", "publisher"] }: { active: boolean; everyMs?: number; agents?: string[] }) {
  const router = useRouter();
  const { onEvent } = useLive();
  const last = useRef(0);
  const watched = agents.join(",");
  useEffect(() => {
    const list = watched.split(",");
    const kick = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last.current < 1500) return;
      last.current = now;
      router.refresh();
    };
    const off = onEvent((e) => {
      const agent = (e as { agent?: string }).agent ?? "";
      if (list.includes(agent) || agent.startsWith("user:")) kick();
    });
    const t = active ? setInterval(kick, everyMs) : null;
    return () => {
      off();
      if (t) clearInterval(t);
    };
  }, [active, everyMs, onEvent, router, watched]);
  return null;
}
