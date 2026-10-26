// Unfinished feature: the live agent stream side panel and its collapsed rail of agent monograms. Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Orbit, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import type { AgentLive, LiveEvent } from "@/lib/live";
import { useLive } from "@/lib/use-live";
import { RelayLayer } from "@/motion";
import { cn } from "@/components/ui";
import { AgentMonogram } from "@/motion";
import { AGENT_ORDER } from "@/components/agents/meta";
import { clock, humanLabel, relTime, who } from "@/components/shell/format";
import { useNow } from "@/components/shell/use-now";
import { usePendingApprovals } from "@/components/shell/decided";

type Entry = {
  key: string;
  agent: string;
  summary: string;
  ts: string;
  needsYou: boolean;
  tone?: "error" | "handoff";
  href?: string;
  event?: LiveEvent;
};

const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
const HIDDEN_KINDS = new Set(["tool", "cost"]);

function orderAgents(agents: AgentLive[]): AgentLive[] {
  return [...agents].sort((a, b) => AGENT_ORDER.indexOf(a.key) - AGENT_ORDER.indexOf(b.key));
}

/** Small monogram for people and the system (not agents). */
function ActorDot({ agent, size = 24 }: { agent: string; size?: 24 | 32 }) {
  const w = who(agent);
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full border border-border-strong text-fg-2"
      style={{ width: size + 8, height: size + 8, padding: 4 }}
    >
      <span className="grid size-full place-items-center rounded-full text-[9px] font-medium">{w.monogram === "You" ? "You" : w.monogram}</span>
    </span>
  );
}

function EntryAvatar({ agent, agents }: { agent: string; agents: AgentLive[] }) {
  const live = agents.find((a) => a.key === agent);
  const w = who(agent);
  if (!w.isAgent) return <ActorDot agent={agent} />;
  return <AgentMonogram agent={{ monogram: w.monogram, name: w.name, state: live?.state === "working" ? "working" : "idle" }} size={24} />;
}

function useEntries(): { needs: Entry[]; log: Entry[] } {
  const { snapshot, events } = useLive();
  const pending = usePendingApprovals(snapshot?.approvals);
  return useMemo(() => {
    const pendingRefs = new Set(pending.map((a) => a.ref));
    const needs: Entry[] = pending
      .map((a) => ({ key: `ap:${a.id}`, agent: a.agent, summary: a.summary, ts: a.requestedAt, needsYou: true, href: `/approvals#${a.ref}` }))
      .sort((a, b) => b.ts.localeCompare(a.ts));
    const log: Entry[] = [];
    for (let i = events.length - 1; i >= 0 && log.length < 60; i--) {
      const e = events[i]!;
      if (HIDDEN_KINDS.has(e.kind)) continue;
      const ref = e.kind === "approval" ? /\bap-\d+\b/.exec(e.message)?.[0] : undefined;
      if (ref && pendingRefs.has(ref)) continue;
      log.push({
        key: `ev:${e.id}`,
        agent: e.agent,
        summary: e.message,
        ts: e.ts,
        needsYou: false,
        ...(e.kind === "error" ? { tone: "error" as const } : e.kind === "handoff" ? { tone: "handoff" as const } : {}),
        event: e,
      });
    }
    log.sort((a, b) => b.ts.localeCompare(a.ts));
    return { needs, log };
  }, [pending, events]);
}

function StreamEntry({ entry, agents, now, fresh, tz }: { entry: Entry; agents: AgentLive[]; now: number; fresh: boolean; tz?: string }) {
  const [open, setOpen] = useState(false);
  const w = who(entry.agent);
  const e = entry.event;
  const body = (
    <>
      <span className="relative mt-[-4px]">
        <EntryAvatar agent={entry.agent} agents={agents} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-caption font-medium text-fg-2">{w.name}</span>
          <span className="ml-auto shrink-0 text-caption text-fg-3 tabular" suppressHydrationWarning>
            {relTime(entry.ts, now)}
          </span>
        </span>
        <span className={cn("mt-0.5 block text-small text-fg", !open && "line-clamp-2", entry.tone === "error" && "text-fg")}>
          {entry.tone === "error" ? <span className="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-danger align-middle" aria-label="Problem" /> : null}
          {entry.summary}
        </span>
      </span>
      {entry.needsYou ? <span aria-label="Needs you" className="absolute right-0 top-[15px] size-1.5 rounded-full bg-brand" /> : null}
    </>
  );
  return (
    <motion.li
      layout="position"
      initial={fresh ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className="list-none"
    >
      {entry.href ? (
        <Link href={entry.href} className="relative flex gap-3 rounded-md py-2.5 pl-1 pr-4 transition-colors duration-[120ms] hover:bg-surface-1">
          {body}
        </Link>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="relative flex w-full gap-3 rounded-md py-2.5 pl-1 pr-1 text-left transition-colors duration-[120ms] hover:bg-surface-1"
          >
            {body}
          </button>
          <AnimatePresence initial={false}>
            {open && e ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                className="overflow-hidden"
              >
                <div className="mb-2 ml-9 rounded-md bg-surface-2 px-3 py-2.5 font-mono text-[12px] leading-[19px] text-fg-2">
                  <div className="text-fg-3">
                    {clock(e.ts, tz)} · {e.kind}
                    {e.to ? ` → ${who(e.to).name.toLowerCase()}` : ""}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-fg">{e.message}</div>
                  {e.runId ? (
                    <Link href={`/activity/runs/${e.runId}`} className="mt-1.5 inline-block text-fg-3 underline decoration-border-strong underline-offset-2 hover:text-fg">
                      run {e.runId.slice(0, 8)}
                    </Link>
                  ) : null}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}
    </motion.li>
  );
}

/** The seven monograms in a row, with relay comets flying between them on every handoff. */
function TeamStrip({ agents }: { agents: AgentLive[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = useState<Record<string, { x: number; y: number }>>({});
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const root = el.getBoundingClientRect();
      const next: Record<string, { x: number; y: number }> = {};
      el.querySelectorAll<HTMLElement>("[data-strip-agent]").forEach((m) => {
        const r = m.getBoundingClientRect();
        next[m.dataset.stripAgent!] = { x: r.left - root.left + r.width / 2, y: r.top - root.top + r.height / 2 };
      });
      setAnchors(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [agents.length]);
  return (
    <div ref={box} className="relative flex items-center justify-between px-1">
      {agents.map((a) => (
        <Link key={a.key} href={`/agents/${a.key}`} data-strip-agent={a.key} data-agent-anchor={a.key} title={`${a.name}: ${humanLabel(a.label)}`} className="rounded-full">
          <AgentMonogram agent={a} size={24} badge={a.pendingApprovals || undefined} />
        </Link>
      ))}
      {Object.keys(anchors).length ? (
        // Comets only: the handoff line itself lands in the activity list below, so the floating summary is hidden here.
        <div className="pointer-events-none absolute inset-0 [&>div>div]:hidden">
          <RelayLayer anchors={anchors} />
        </div>
      ) : null}
    </div>
  );
}

/** The live agent stream (DESIGN §8.3): who's working, what needs you, and everything the team did. */
export function StreamPanel({ onClose, variant = "dock" }: { onClose?: () => void; variant?: "dock" | "sheet" }) {
  const { snapshot, connected } = useLive();
  const now = useNow(15_000);
  const { needs, log } = useEntries();
  const agents = useMemo(() => orderAgents(snapshot?.agents ?? []), [snapshot]);
  const working = agents.filter((a) => a.state === "working" || a.state === "blocked");
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set([...needs, ...log].map((e) => e.key));
  useEffect(() => {
    for (const e of [...needs, ...log]) seen.current!.add(e.key);
  });
  const [showAll, setShowAll] = useState(false);
  const visibleLog = showAll ? log : log.slice(0, 24);
  const tz = snapshot?.workspace.timezone;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[72px] shrink-0 items-center justify-between gap-2 px-5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-h3 font-medium text-fg">Live</h2>
          <span className="flex items-center gap-1.5 text-caption text-fg-3">
            <span aria-hidden className={cn("size-1.5 rounded-full", connected ? "signal-pulse bg-brand" : "bg-fg-3")} />
            {connected ? "Streaming" : "Reconnecting"}
          </span>
        </div>
        {onClose ? (
          <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg" aria-label={variant === "sheet" ? "Close" : "Collapse the agent stream"}>
            {variant === "sheet" ? <X className="size-4" strokeWidth={1.5} /> : <PanelRightClose className="size-4" strokeWidth={1.5} />}
          </button>
        ) : null}
      </div>

      <div className="shrink-0 px-4 pb-4">
        <TeamStrip agents={agents} />
        {working.length ? (
          <ul className="mt-4 flex flex-col gap-2">
            {working.map((a) => (
              <li key={a.key} className="relative flex items-start gap-2.5 rounded-md bg-surface-1 py-2 pl-3.5 pr-3">
                <span aria-hidden className={cn("absolute inset-y-2 left-0 w-[2px] rounded-full", a.state === "blocked" ? "bg-danger" : "signal-pulse bg-brand")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-caption font-medium text-fg-2">{a.name}{a.state === "blocked" ? " · blocked" : ""}</span>
                  <span className="mt-0.5 block line-clamp-2 text-small text-fg">{humanLabel(a.label)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 [scrollbar-width:thin]">
        {needs.length ? (
          <section aria-labelledby="stream-needs" className="mb-5">
            <h3 id="stream-needs" className="mb-1 px-1 text-caption font-medium text-fg-3">
              Needs you <span className="tabular">· {needs.length}</span>
            </h3>
            <ul>
              <AnimatePresence initial={false}>
                {needs.map((e) => (
                  <StreamEntry key={e.key} entry={e} agents={agents} now={now} fresh={!seen.current!.has(e.key)} tz={tz} />
                ))}
              </AnimatePresence>
            </ul>
          </section>
        ) : null}
        <section aria-labelledby="stream-log">
          <h3 id="stream-log" className="mb-1 px-1 text-caption font-medium text-fg-3">
            Activity
          </h3>
          {log.length ? (
            <ul>
              {visibleLog.map((e) => (
                <StreamEntry key={e.key} entry={e} agents={agents} now={now} fresh={!seen.current!.has(e.key)} tz={tz} />
              ))}
            </ul>
          ) : (
            <p className="px-1 py-6 text-small text-fg-3">Nothing yet today. Agents post here the moment they start work.</p>
          )}
          {log.length > visibleLog.length ? (
            <button type="button" onClick={() => setShowAll(true)} className="mt-1 flex items-center gap-1 px-1 text-caption text-fg-3 hover:text-fg">
              <ChevronDown className="size-3.5" strokeWidth={1.5} /> Show {log.length - visibleLog.length} more
            </button>
          ) : null}
        </section>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
        <Link href="/command" className="flex items-center gap-2 text-small text-fg-2 transition-colors hover:text-fg">
          <Orbit className="size-4" strokeWidth={1.5} /> Open command view
        </Link>
        <Link href="/activity" className="text-small text-fg-3 transition-colors hover:text-fg">
          Full log
        </Link>
      </div>
    </div>
  );
}

/** Collapsed stream: a 56px rail of monograms with live state rings (DESIGN §4.1). */
export function StreamRail({ onExpand }: { onExpand: () => void }) {
  const { snapshot } = useLive();
  const agents = useMemo(() => orderAgents(snapshot?.agents ?? []), [snapshot]);
  const pending = usePendingApprovals(snapshot?.approvals).length;
  return (
    <div className="flex h-full flex-col items-center gap-1 py-4">
      <button type="button" onClick={onExpand} className="mb-3 grid size-9 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg" aria-label="Open the agent stream">
        <PanelRightOpen className="size-4" strokeWidth={1.5} />
      </button>
      {agents.map((a) => (
        <button key={a.key} type="button" onClick={onExpand} data-agent-anchor={a.key} title={`${a.name}: ${humanLabel(a.label)}`} className="rounded-full p-1">
          <AgentMonogram agent={a} size={32} badge={a.pendingApprovals || undefined} />
        </button>
      ))}
      <div className="flex-1" />
      {pending ? (
        <Link href="/approvals" title={`${pending} waiting for you`} className="mb-1 grid size-9 place-items-center rounded-md text-caption font-medium text-on-tint tabular hover:bg-surface-2">
          <span className="grid size-6 place-items-center rounded-full bg-brand-tint">{pending}</span>
        </Link>
      ) : null}
      <Link href="/command" title="Open command view" className="grid size-9 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg">
        <Orbit className="size-4" strokeWidth={1.5} />
      </Link>
    </div>
  );
}

