"use client";
import Link from "next/link";
import type { RosterExtra } from "@/server/queries/agents";
import { useLive } from "@/lib/use-live";
import { cn } from "@/components/ui";
import { AgentMonogram } from "@/motion";
import { AUTONOMY_LABEL, humanLabel, relTime, usd } from "@/components/shell/format";
import { useNow } from "@/components/shell/use-now";
import { AGENT_INFO, AGENT_ORDER } from "./meta";

const STATE_TEXT = { working: "Working", waiting: "Waiting on you", idle: "Idle", paused: "Paused", blocked: "Blocked" } as const;

/** The team roster: who does what, what they're doing right now, and how much rope they have. */
export function Roster({ extras }: { extras: RosterExtra[] }) {
  const { snapshot } = useLive();
  const now = useNow();
  const live = new Map((snapshot?.agents ?? []).map((a) => [a.key, a]));
  return (
    <ul className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {AGENT_ORDER.map((key) => {
        const info = AGENT_INFO[key];
        const a = live.get(key);
        const x = extras.find((e) => e.key === key);
        const state = a?.state ?? "idle";
        const label = state === "idle" ? (x?.lastSummary ? x.lastSummary : "Between tasks") : humanLabel(a?.label) || "Idle";
        return (
          <li key={key}>
            <Link
              href={`/agents/${key}`}
              className="group relative flex h-full flex-col rounded-lg border border-border bg-surface-1 p-6 transition-colors duration-[120ms] hover:border-border-strong"
            >
              <div className="flex items-start justify-between gap-3">
                <span data-agent-anchor={key}>
                  <AgentMonogram agent={{ monogram: info.monogram, name: info.name, state }} size={56} badge={a?.pendingApprovals || undefined} />
                </span>
                <span
                  className={cn(
                    "inline-flex h-[22px] items-center gap-1.5 rounded-sm px-2 text-caption font-medium",
                    a?.autonomy === "autopilot" ? "bg-brand-tint text-on-tint" : "bg-surface-3 text-fg-2",
                  )}
                >
                  {a?.autonomy === "autopilot" ? <span aria-hidden className="size-2 rounded-full border-[1.5px] border-current" /> : null}
                  {AUTONOMY_LABEL[a?.autonomy ?? "review_all"]}
                </span>
              </div>
              <h2 className="mt-5 text-h3 font-medium text-fg">{info.name}</h2>
              <p className="text-small text-fg-2">{info.role}</p>
              <div className="mt-4 flex-1">
                <div className={cn("text-caption font-medium", state === "working" || state === "waiting" ? "text-on-tint" : state === "blocked" ? "text-danger" : "text-fg-3")}>
                  {STATE_TEXT[state]}
                </div>
                <p className="mt-0.5 line-clamp-2 text-small text-fg">{label}</p>
              </div>
              <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4 text-caption">
                <div>
                  <dt className="text-fg-3">Today</dt>
                  <dd className="mt-0.5 text-small text-fg tabular">{a?.runs24h ?? 0} {a?.runs24h === 1 ? "task" : "tasks"}</dd>
                </div>
                <div>
                  <dt className="text-fg-3">Spend</dt>
                  <dd className="mt-0.5 text-small text-fg tabular">{usd(a?.costTodayUsd ?? 0, { precise: true })}</dd>
                </div>
                <div>
                  <dt className="text-fg-3">Last done</dt>
                  <dd className="mt-0.5 text-small text-fg tabular" suppressHydrationWarning>{x?.lastRunAt ? relTime(x.lastRunAt, now) : "Not yet"}</dd>
                </div>
              </dl>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
