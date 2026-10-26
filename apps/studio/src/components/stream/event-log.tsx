import Link from "next/link";
import type { ActivityEvent } from "@/server/queries/activity";
import { cn } from "@/components/ui";
import { AgentMonogram } from "@/motion/AgentMonogram";
import { jobLabel, who } from "@/components/shell/format";

const KIND_LABEL: Record<string, string> = { progress: "Step", handoff: "Handoff", approval: "Approval", error: "Problem", cost: "Spend", tool: "Tool", text: "Note" };

function dayKey(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
}

/** The full event log, grouped by day. Show the work; the wiring (run, job) is one click away. */
export function EventLog({ events, tz }: { events: ActivityEvent[]; tz: string }) {
  const groups: { day: string; items: ActivityEvent[] }[] = [];
  for (const e of events) {
    const day = dayKey(e.ts, tz);
    const g = groups.at(-1);
    if (g?.day === day) g.items.push(e);
    else groups.push({ day, items: [e] });
  }
  return (
    <div className="flex flex-col gap-10">
      {groups.map((g) => (
        <section key={g.day}>
          <h3 className="sticky top-0 z-10 -mx-1 mb-2 bg-bg px-1 py-2 text-small font-medium text-fg-2 max-md:top-14">{g.day}</h3>
          <ol className="flex flex-col">
            {g.items.map((e) => {
              const w = who(e.agent);
              return (
                <li key={e.id} className="group grid grid-cols-[60px_auto_minmax(0,1fr)] items-start gap-3 rounded-md px-1 py-2 hover:bg-surface-1 max-sm:grid-cols-[auto_minmax(0,1fr)]">
                  <span className="pt-[7px] text-caption text-fg-3 tabular max-sm:hidden">
                    {new Date(e.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}
                  </span>
                  {w.isAgent ? (
                    <AgentMonogram agent={{ monogram: w.monogram, name: w.name, state: "idle" }} size={24} />
                  ) : (
                    <span className="grid size-8 place-items-center rounded-full border border-border-strong text-[9px] font-medium text-fg-2">{w.monogram}</span>
                  )}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 text-caption">
                      <span className="font-medium text-fg-2">{w.name}</span>
                      <span className={cn(e.kind === "error" ? "text-danger" : e.kind === "approval" ? "text-on-tint" : "text-fg-3")}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                      {e.jobId ? <span className="text-fg-3">· {jobLabel(e.jobId)}</span> : null}
                      {e.runId ? (
                        <Link href={`/activity/runs/${e.runId}`} className="ml-auto text-fg-3 opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 focus:opacity-100 max-md:opacity-100">
                          Open run
                        </Link>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[14px] leading-[22px] text-fg">{e.message}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
