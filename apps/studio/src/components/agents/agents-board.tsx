"use client";
import Link from "next/link";
import { useRef } from "react";
import { Maximize2, Users } from "lucide-react";
import { useLive } from "@/lib/use-live";
import { buttonClass, cn } from "@/components/ui";
import { WorkerRoom, useFullscreen, type WallFeedData } from "@/components/worker-room";
import { CommandBoard } from "./command-board";

export type AgentsViewId = "worker" | "command";

const VIEWS: { id: AgentsViewId; label: string }[] = [
  { id: "worker", label: "Worker" },
  { id: "command", label: "Command" },
];

/**
 * The Agents page stage: the live "larp" dashboard in one of two looks (the isometric worker room, or the command orbit),
 * a full screen button for filming, and a way down to the team settings.
 */
export function AgentsBoard({ view, feed, hold }: { view: AgentsViewId; feed: WallFeedData; hold: boolean }) {
  const { snapshot } = useLive();
  const stage = useRef<HTMLDivElement>(null);
  const full = useFullscreen(stage);
  const working = snapshot?.agents.filter((a) => a.state === "working").length ?? 0;
  const extra = hold ? "hold=1" : "";

  return (
    <section aria-labelledby="agents-title">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 sm:items-end">
        <div className="min-w-0">
          <h1 id="agents-title" className="text-h1 font-medium tracking-[-0.01em] text-fg">
            Agents
          </h1>
          <p className="mt-1 hidden text-small text-fg-2 sm:block">
            {working ? `${working} ${working === 1 ? "agent is" : "agents are"} working right now. They light up while they work.` : "Your team lights up here the moment an agent starts work."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="View" className="inline-flex rounded-md border border-border bg-surface-1 p-0.5">
            {VIEWS.map((v) => (
              <Link
                key={v.id}
                href={`/agents?view=${v.id}${extra ? `&${extra}` : ""}`}
                scroll={false}
                replace
                aria-current={view === v.id ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-[5px] px-3 text-[13px] font-medium transition-colors duration-[120ms]",
                  view === v.id ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg",
                )}
              >
                {v.label}
              </Link>
            ))}
          </nav>
          {full.supported ? (
            <button type="button" onClick={full.toggle} className={buttonClass("secondary", "md", "max-sm:w-9 max-sm:px-0")} aria-label="Full screen">
              <Maximize2 className="size-4" strokeWidth={1.5} aria-hidden />
              <span className="max-sm:hidden">Full screen</span>
            </button>
          ) : null}
          <a href="#team" className={buttonClass("ghost", "md", "max-sm:w-9 max-sm:px-0")} aria-label="Team settings">
            <Users className="size-4" strokeWidth={1.5} aria-hidden />
            <span className="max-sm:hidden">Team</span>
          </a>
        </div>
      </header>

      <div
        ref={stage}
        className={cn(
          "relative -mx-4 h-[calc(100dvh-13.5rem)] min-h-[420px] overflow-hidden border-y border-border bg-[#07050a] md:mx-0 md:h-[calc(100dvh-10.5rem)] md:min-h-[520px] md:rounded-lg md:border",
          "[&:fullscreen]:m-0 [&:fullscreen]:h-full [&:fullscreen]:rounded-none [&:fullscreen]:border-0",
          view === "command" && "bg-bg",
        )}
      >
        {view === "command" ? <CommandBoard framed={!full.active} /> : <WorkerRoom feed={feed} full={full} hold={hold} framed={!full.active} />}
      </div>
    </section>
  );
}
