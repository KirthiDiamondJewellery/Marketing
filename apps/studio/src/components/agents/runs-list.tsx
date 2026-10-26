import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { RunSummary } from "@/server/queries/agents";
import { cn } from "@/components/ui";
import { AgentMonogram } from "@/motion/AgentMonogram";
import { jobLabel, usd, who } from "@/components/shell/format";
import { RelTime } from "@/components/shell/rel-time";

export const RUN_STATUS: Record<string, { label: string; dot: string; text: string }> = {
  succeeded: { label: "Done", dot: "bg-success", text: "text-success" },
  failed: { label: "Failed", dot: "bg-danger", text: "text-danger" },
  running: { label: "Working", dot: "bg-brand signal-pulse", text: "text-on-tint" },
  queued: { label: "In line", dot: "bg-fg-3", text: "text-fg-2" },
  waiting_approval: { label: "Waiting on you", dot: "bg-brand", text: "text-on-tint" },
  cancelled: { label: "Stopped", dot: "bg-fg-3", text: "text-fg-3" },
};

export function StatusLabel({ status }: { status: string }) {
  const s = RUN_STATUS[status] ?? { label: status, dot: "bg-fg-3", text: "text-fg-2" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-caption font-medium", s.text)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

/** Recent runs as plain-language rows: what the agent did, how it went, what it cost. */
export function RunsList({ runs, showAgent = false, empty }: { runs: RunSummary[]; showAgent?: boolean; empty?: string }) {
  if (!runs.length) return <p className="rounded-lg border border-border px-5 py-8 text-center text-small text-fg-2">{empty ?? "No work yet."}</p>;
  return (
    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-1">
      {runs.map((r) => {
        const w = who(r.agent);
        return (
          <li key={r.id}>
            <Link href={`/activity/runs/${r.id}`} className="group flex items-center gap-4 px-5 py-3.5 transition-colors duration-[120ms] hover:bg-surface-2">
              {showAgent ? <AgentMonogram agent={{ monogram: w.monogram, name: w.name, state: r.status === "running" ? "working" : "idle" }} size={24} /> : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <span className="truncate text-[14px] font-medium text-fg">{jobLabel(r.jobId)}</span>
                  <StatusLabel status={r.status} />
                </div>
                <p className="mt-0.5 truncate text-small text-fg-2">{r.status === "failed" ? r.error ?? "Didn't finish." : r.summary ?? (showAgent ? w.name : r.trigger === "schedule" ? "On schedule" : "Started by you")}</p>
              </div>
              <div className="hidden shrink-0 text-right sm:block">
                <RelTime iso={r.finishedAt ?? r.startedAt ?? r.createdAt} className="block text-small text-fg-2 tabular" />
                <span className="text-caption text-fg-3 tabular">{r.costUsd > 0 ? usd(r.costUsd, { precise: true }) : "No AI cost"}</span>
              </div>
              <ChevronRight className="size-4 shrink-0 text-fg-3 transition-transform group-hover:translate-x-0.5" strokeWidth={1.5} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
