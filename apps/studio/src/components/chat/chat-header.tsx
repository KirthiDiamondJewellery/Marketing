"use client";
import { useLive } from "@/lib/use-live";
import { AgentMonogram } from "@/motion";
import { humanLabel } from "@/components/shell/format";

/** Chat page header: the Chief of Staff with its live state. */
export function ChatHeader() {
  const { snapshot } = useLive();
  const cos = snapshot?.agents.find((a) => a.key === "chief_of_staff");
  const state = cos?.state ?? "idle";
  return (
    <header className="mb-6 flex items-center gap-4 border-b border-border pb-6">
      <span data-agent-anchor="chief_of_staff">
        <AgentMonogram agent={{ monogram: "Cs", name: "Chief of Staff", state }} size={56} badge={undefined} />
      </span>
      <div className="min-w-0">
        <h1 className="text-h1 font-medium tracking-[-0.01em] text-fg">Chief of Staff</h1>
        <p className="mt-0.5 truncate text-small text-fg-2">
          {state === "working" ? humanLabel(cos?.label) : "Runs the team and talks to you. Ask for anything; it hands work to the right agent."}
        </p>
      </div>
    </header>
  );
}
