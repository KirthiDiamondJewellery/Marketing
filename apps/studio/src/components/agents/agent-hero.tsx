"use client";
import type { ReactNode } from "react";
import type { AgentKey } from "@attentionos/core";
import { useLive } from "@/lib/use-live";
import { cn } from "@/components/ui";
import { AgentMonogram } from "@/motion";
import { humanLabel } from "@/components/shell/format";
import { AGENT_INFO } from "./meta";

/** Profile header: 64px monogram with its live ring, name, role and what it's doing this second. */
export function AgentHero({ agent, actions }: { agent: AgentKey; actions?: ReactNode }) {
  const { snapshot } = useLive();
  const info = AGENT_INFO[agent];
  const live = snapshot?.agents.find((a) => a.key === agent);
  const state = live?.state ?? "idle";
  return (
    <header className="flex flex-col gap-6 sm:flex-row sm:items-center">
      <span data-agent-anchor={agent}>
        <AgentMonogram agent={{ monogram: info.monogram, name: info.name, state }} size={64} badge={live?.pendingApprovals || undefined} />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-h1 font-medium tracking-[-0.01em] text-fg">{info.name}</h1>
        <p className="mt-0.5 text-body text-fg-2">{info.role}</p>
        <p className={cn("mt-2 flex items-center gap-2 text-small", state === "blocked" ? "text-danger" : "text-fg")}>
          <span aria-hidden className={cn("size-1.5 rounded-full", state === "working" ? "signal-pulse bg-brand" : state === "waiting" ? "bg-brand" : state === "blocked" ? "bg-danger" : "bg-fg-3")} />
          {state === "idle" ? "Between tasks" : humanLabel(live?.label)}
        </p>
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </header>
  );
}
