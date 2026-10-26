"use client";
import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Check, Minus } from "lucide-react";
import type { StepId } from "@attentionos/module-onboarding/state";
import { cn } from "@/components/ui";
import { Wordmark } from "@/components/shell/wordmark";
import { ToastProvider } from "@/components/shell/toast";
import type { SetupView } from "@/server/queries/onboarding";
import { goToStepAction, skipStepAction, type SetupResult } from "@/server/actions/onboarding";
import { useSetupAction } from "./parts";
import { WelcomeStep } from "./step-welcome";
import { YouStep } from "./step-you";
import { KeysStep } from "./step-keys";
import { CompetitorsStep } from "./step-competitors";
import { StartStep } from "./step-start";
import { ReviewStep } from "./step-review";
import { InterviewStep } from "./step-interview";
import { GoLiveStep } from "./step-golive";

export type StepNav = {
  back: () => void;
  skip: () => void;
  /** Runs a completing action and, when it succeeds, shows the next step. */
  finish: (fn: () => Promise<SetupResult>) => Promise<SetupResult>;
  busy: boolean;
};

export type StepProps = { view: SetupView; nav: StepNav };

const STEPS: Record<StepId, (p: StepProps) => React.ReactNode> = {
  welcome: WelcomeStep,
  you: YouStep,
  keys: KeysStep,
  competitors: CompetitorsStep,
  start: StartStep,
  review: ReviewStep,
  "go-live": GoLiveStep,
  interview: InterviewStep,
};

/** Wider canvas for the steps with side-by-side cards. */
const WIDE: StepId[] = ["keys", "start", "review"];

function Progress({ value }: { value: number }) {
  return (
    <div aria-hidden className="fixed inset-x-0 top-0 z-40 h-[2px] bg-border">
      <span
        className="block h-full origin-left bg-brand transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
        style={{ transform: `scaleX(${Math.max(0.02, value)})` }}
      />
    </div>
  );
}

function StepRail({ view, onJump }: { view: SetupView; onJump: (s: StepId) => void }) {
  return (
    <nav aria-label="Setup steps" className="hidden items-center gap-1 lg:flex">
      {view.steps.map(({ id, title, status: st }, i) => {
        return (
          <button
            key={id}
            type="button"
            onClick={() => onJump(id)}
            aria-current={view.step === id ? "step" : undefined}
            title={title}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-caption font-medium transition-colors duration-[120ms]",
              st === "current" ? "bg-surface-2 text-fg" : "text-fg-3 hover:text-fg-2",
            )}
          >
            <span
              className={cn(
                "grid size-4 place-items-center rounded-full border text-[10px] tabular",
                st === "current" ? "border-brand text-fg" : st === "done" ? "border-transparent bg-surface-3 text-success" : "border-border-strong",
              )}
            >
              {st === "done" ? <Check className="size-3" strokeWidth={2} /> : st === "skipped" ? <Minus className="size-3" strokeWidth={2} /> : i + 1}
            </span>
            <span className={st === "current" ? "" : "sr-only xl:not-sr-only"}>{title}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function SetupWizard({ view }: { view: SetupView }) {
  const router = useRouter();
  const { run, pending } = useSetupAction();
  const show = useCallback(() => router.replace("/setup", { scroll: true }), [router]);

  const nav = useMemo<StepNav>(
    () => ({
      busy: pending,
      back: () => void run(() => goToStepAction(view.prev), { quiet: true, refresh: false, onOk: show }),
      skip: () => void run(() => skipStepAction(view.step), { quiet: true, refresh: false, onOk: (r) => (r.redirect ? undefined : show()) }),
      finish: (fn) => run(fn, { refresh: false, onOk: (r) => (r.redirect ? undefined : show()) }),
    }),
    [pending, run, show, view.step, view.prev],
  );
  const jump = (s: StepId) => void run(() => goToStepAction(s), { quiet: true, refresh: false, onOk: show });

  const Step = STEPS[view.step];
  // Extra steps (the interview) sit with Review in the rail.
  const n = Math.max(0, view.steps.findIndex((s) => s.id === (view.steps.some((x) => x.id === view.step) ? view.step : "review")));
  return (
    <ToastProvider>
      <Progress value={view.progress} />
      <div className="flex min-h-dvh flex-col bg-bg">
        <header className="flex h-14 items-center justify-between gap-4 px-4 pt-[2px] md:px-8">
          <Wordmark />
          <StepRail view={view.steps.some((x) => x.id === view.step) ? view : { ...view, steps: view.steps.map((x) => (x.id === "review" ? { ...x, status: "current" } : x)) }} onJump={jump} />
          <p className="text-small text-fg-2 lg:hidden">
            <span className="tabular">
              {n + 1} of {view.steps.length}
            </span>
            <span className="text-fg-3"> · </span>
            {view.steps.some((x) => x.id === view.step) ? view.steps[n]?.title : "Proof and stories"}
          </p>
        </header>
        <main className={cn("mx-auto flex w-full flex-1 flex-col px-4 pb-6 pt-8 md:px-8 md:pb-16 md:pt-14", WIDE.includes(view.step) ? "max-w-[1040px]" : "max-w-[680px]")}>
          <Step key={view.step} view={view} nav={nav} />
        </main>
      </div>
    </ToastProvider>
  );
}
