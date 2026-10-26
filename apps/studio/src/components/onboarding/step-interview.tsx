"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Badge, Button, cn } from "@/components/ui";
import { AgentMonogram } from "@/motion";
import { saveInterviewAction, sendInterviewAction, startInterviewAction } from "@/server/actions/onboarding";
import { ErrorNote, isActive, StepFooter, StepHeader, useRefreshWhile, useSetupAction } from "./parts";
import type { StepProps } from "./wizard";

const KIND_LABEL: Record<string, [string, string]> = {
  pain: ["pain", "pains"],
  want: ["want", "wants"],
  quote: ["quote", "quotes"],
  objection: ["objection", "objections"],
  offer: ["offer detail", "offer details"],
  proof: ["proof point", "proof points"],
  faq: ["question", "questions"],
  process: ["process step", "process steps"],
  story: ["story", "stories"],
  not_for: ["not-for", "not-for notes"],
  other: ["note", "notes"],
};

const CS = { monogram: "Cs", name: "Chief of Staff" };

/**
 * Optional ("Add proof and stories", from Review or the Brand Kit): a live interview with the Chief of Staff. Each
 * answer is one agent turn that resumes the same session. Saving returns to Review.
 */
export function InterviewStep({ view, nav }: StepProps) {
  const iv = view.state.data.interview;
  const run = iv.runId ? view.runs[iv.runId] : undefined;
  const thinking = isActive(run);
  useRefreshWhile(thinking, 2000);
  const { run: act, pending } = useSetupAction();
  const [text, setText] = useState("");
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const started = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Open the conversation once: the Chief of Staff asks the first question.
  useEffect(() => {
    if (started.current || iv.messages.length || thinking) return;
    started.current = true;
    void act(() => startInterviewAction(), { quiet: true });
  }, [act, iv.messages.length, thinking]);

  useEffect(() => {
    if (optimistic && iv.messages.some((m) => m.role === "owner" && m.text === optimistic)) setOptimistic(null);
  }, [iv.messages, optimistic]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [iv.messages.length, thinking, optimistic]);

  const totals = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of iv.answers) c[a.kind] = (c[a.kind] ?? 0) + 1;
    return Object.entries(c);
  }, [iv.answers]);

  const send = () => {
    const t = text.trim();
    if (!t || thinking) return;
    setOptimistic(t);
    setText("");
    void act(() => sendInterviewAction(t), { quiet: true }).then((r) => {
      if (!r.ok) {
        setOptimistic(null);
        setText(t);
      }
    });
  };

  const failed = run?.status === "failed";
  const canSave = iv.answers.length > 0;

  return (
    <div className="flex flex-1 flex-col">
      <StepHeader
        title="Add proof and stories"
        lede="Optional. The Chief of Staff asks for results you can prove, client stories, the objections you hear and how customers describe their problem. About ten minutes; short answers are fine, and you can stop any time."
      />

      {totals.length ? (
        <div className="mt-6 flex flex-wrap justify-center gap-1.5" aria-label="Recorded so far">
          {totals.map(([k, n]) => (
            <Badge key={k} tone="neutral" className="tabular">
              {n} {KIND_LABEL[k]?.[n === 1 ? 0 : 1] ?? k}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="mt-8 flex flex-col gap-4" aria-live="polite">
        {iv.messages.map((m) =>
          m.role === "agent" ? (
            <div key={m.id} className="flex items-start gap-3">
              <AgentMonogram agent={{ ...CS, state: "idle" }} size={32} />
              <p className="max-w-[60ch] whitespace-pre-line pt-1.5 text-body text-fg">{m.text}</p>
            </div>
          ) : (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-line rounded-lg rounded-br-sm bg-surface-2 px-4 py-2.5 text-body text-fg md:max-w-[75%]">{m.text}</p>
            </div>
          ),
        )}
        {optimistic ? (
          <div className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-line rounded-lg rounded-br-sm bg-surface-2 px-4 py-2.5 text-body text-fg opacity-80 md:max-w-[75%]">{optimistic}</p>
          </div>
        ) : null}
        {thinking || (pending && !iv.messages.length) ? (
          <div className="flex items-center gap-3" role="status">
            <AgentMonogram agent={{ ...CS, state: "working" }} size={32} />
            <p className="text-small text-fg-2">{iv.messages.length ? (run?.progress && !run.progress.startsWith("Started") ? run.progress : "Thinking about your answer") : "Reading what you've shared so far"}</p>
          </div>
        ) : null}
        {failed ? <ErrorNote>{run?.error ?? "The Chief of Staff couldn't answer."} Send your answer again, or save what's recorded.</ErrorNote> : null}
        <div ref={endRef} />
      </div>

      <div className={cn("mt-6 flex items-end gap-2 rounded-lg border border-border bg-surface-1 p-2 focus-within:border-brand", iv.done && "opacity-90")}>
        <label htmlFor="answer" className="sr-only">
          Your answer
        </label>
        <textarea
          id="answer"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={iv.done ? "Add anything else" : "Type your answer"}
          className="max-h-48 min-h-11 w-full resize-none bg-transparent px-2 py-2 text-[15px] text-fg outline-none placeholder:text-fg-3"
        />
        <Button variant={iv.done ? "secondary" : "primary"} aria-label="Send answer" className="size-11 shrink-0 p-0" disabled={!text.trim() || thinking} onClick={send}>
          <ArrowUp className="size-5" strokeWidth={1.75} />
        </Button>
      </div>
      <p className="mt-2 text-caption text-fg-3">Enter sends. Numbers are only kept when you say where they come from.</p>

      <StepFooter
        busy={nav.busy}
        onBack={nav.back}
        onSkip={nav.skip}
        secondary={
          !iv.done && canSave ? (
            <Button variant="secondary" size="lg" className="h-11" disabled={thinking} onClick={() => void nav.finish(() => saveInterviewAction())}>
              Save and continue
            </Button>
          ) : null
        }
        primary={iv.done ? { label: "Save to Brand Kit", onClick: () => void nav.finish(() => saveInterviewAction()), disabled: !canSave || thinking } : undefined}
      />
    </div>
  );
}
