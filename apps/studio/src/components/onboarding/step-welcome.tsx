"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, CircleAlert } from "lucide-react";
import { Button, cn } from "@/components/ui";
import { AGENT_INFO, AGENT_ORDER } from "@/components/agents/meta";
import { AgentMonogram, WakeTheTeam } from "@/motion";
import type { AgentLive } from "@/lib/live";
import { completeStepAction } from "@/server/actions/onboarding";
import { CommandLine, StepFooter, StepHeader } from "./parts";
import type { StepProps } from "./wizard";

/** Step 1: the team wakes up, and three plain checks say whether everything they need is running. */
export function WelcomeStep({ view, nav }: StepProps) {
  const router = useRouter();
  const [rechecking, setRechecking] = useState(false);
  const agents = useMemo<AgentLive[]>(
    () =>
      AGENT_ORDER.map((key) => {
        const a = AGENT_INFO[key];
        return { key, name: a.name, monogram: a.monogram, role: a.role, state: "idle", label: "", autonomy: "review_all", enabled: true, pendingApprovals: 0, run: null, runs24h: 0, costTodayUsd: 0 };
      }),
    [],
  );
  const checks = view.checks ?? [];
  const blocking = checks.filter((c) => !c.ok && c.id !== "worker");
  const firstVisit = view.state.completed.length === 0 && view.state.data.skipped.length === 0;

  return (
    <div className="flex flex-1 flex-col">
      {firstVisit ? <WakeTheTeam agents={agents} force tasks={0} /> : null}
      <StepHeader
        title={firstVisit ? "Meet your content team" : "Welcome back"}
        lede={
          firstVisit
            ? "Show the team your website and your accounts. They read your posts, study the creators you admire and draft your Brand Kit while you watch. About five minutes of your time; you never paste a post."
            : "Pick up where you left off. Everything you saved is still here."
        }
      />

      <ul className="mx-auto mt-10 flex max-w-[640px] flex-wrap justify-center gap-x-3 gap-y-5" aria-label="Your team">
        {agents.map((a) => (
          <li key={a.key} className="flex w-[76px] flex-col items-center gap-2 text-center">
            <AgentMonogram agent={a} size={56} />
            <span className="text-caption text-fg-2">{a.name}</span>
          </li>
        ))}
      </ul>

      <section className="mt-12" aria-labelledby="checks-title">
        <div className="flex items-center justify-between gap-3">
          <h2 id="checks-title" className="text-h3 font-medium text-fg">
            Before we start
          </h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={rechecking}
            onClick={() => {
              setRechecking(true);
              router.refresh();
              setTimeout(() => setRechecking(false), 1500);
            }}
          >
            {rechecking ? "Checking" : "Check again"}
          </Button>
        </div>
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface-1">
          {checks.map((c) => (
            <li key={c.id} className="flex gap-3 p-4">
              {c.ok ? (
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" strokeWidth={1.75} aria-label="Ready" />
              ) : (
                <CircleAlert className={cn("mt-0.5 size-5 shrink-0", c.id === "worker" ? "text-warning" : "text-danger")} strokeWidth={1.75} aria-label="Needs attention" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-body text-fg">{c.label}</p>
                {c.detail ? <p className="text-small text-fg-2">{c.detail}</p> : null}
                {!c.ok && c.fix ? <p className="mt-1 text-small text-fg-2">{c.fix}</p> : null}
                {!c.ok && c.command ? <CommandLine command={c.command} /> : null}
              </div>
            </li>
          ))}
        </ul>
        {blocking.length ? (
          <p className="mt-3 text-small text-fg-2">You can keep going. Steps that need AI will wait until this is fixed.</p>
        ) : null}
      </section>

      <StepFooter
        busy={nav.busy}
        primary={{ label: firstVisit ? "Start setup" : "Continue setup", onClick: () => void nav.finish(() => completeStepAction("welcome")) }}
      />
    </div>
  );
}
