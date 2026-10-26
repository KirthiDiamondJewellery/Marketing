// Unfinished feature: Home's "Your team" panel (compact live agent map with a one-line status). Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import Link from "next/link";
import { useLive } from "@/lib/use-live";
import { AgentMap } from "@/components/command/AgentMap";

/** "Your team": the compact live agent map, with a one-line read of what the team is doing. */
export function TeamPanel() {
  const { snapshot } = useLive();
  const agents = snapshot?.agents ?? [];
  const working = agents.filter((a) => a.state === "working");
  const waiting = agents.filter((a) => a.state === "waiting").length;
  const blocked = agents.filter((a) => a.state === "blocked");
  const line = working.length
    ? `${working.length > 1 ? `${working.slice(0, -1).map((a) => a.name).join(", ")} and ${working.at(-1)!.name}` : working[0]!.name} ${working.length === 1 ? "is" : "are"} working now`
    : "Everyone is between tasks";

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
      <div className="relative h-[420px] max-sm:h-[340px]">
        <AgentMap height="100%" />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-5 py-3 text-small">
        <span className="flex items-center gap-2 text-fg">
          <span aria-hidden className={working.length ? "signal-pulse size-1.5 rounded-full bg-brand" : "size-1.5 rounded-full bg-fg-3"} />
          {line}
        </span>
        {waiting ? <span className="text-fg-2">{waiting} waiting on you</span> : null}
        {blocked.length ? (
          <Link href={`/agents/${blocked[0]!.key}`} className="text-danger hover:underline">
            {blocked[0]!.name} is blocked
          </Link>
        ) : null}
      </div>
    </div>
  );
}
