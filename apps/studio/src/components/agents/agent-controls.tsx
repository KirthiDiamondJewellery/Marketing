"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Pause, Play, Terminal } from "lucide-react";
import type { AgentKey } from "@attentionos/core";
import { setAgentEnabledAction, setAgentModelAction, setAutonomyAction } from "@/server/actions/agents";
import { runNowAction } from "@/server/actions/runs";
import { useLive } from "@/lib/use-live";
import { Button, Input, cn } from "@/components/ui";
import { AutopilotRing } from "@/motion";
import { claimMoments } from "@/components/reel";
import { useToast } from "@/components/shell/toast";
import { AGENT_INFO } from "./meta";

const EASE = [0.2, 0.8, 0.2, 1] as const;
type Level = "review_all" | "review_key" | "autopilot";

const LEVELS: { id: Level; label: string; detail: string }[] = [
  { id: "review_all", label: "Review everything", detail: "Every draft waits for you. The right start." },
  { id: "review_key", label: "Review key posts", detail: "Only campaign posts and sensitive replies wait." },
  { id: "autopilot", label: "Full autopilot", detail: "Acts on its own and tells you afterwards." },
];

/** Autonomy (DESIGN §7.3). Full autopilot asks first, then plays the ring closing. */
export function AutonomyControl({ agent, value }: { agent: AgentKey; value: Level }) {
  const toast = useToast();
  const router = useRouter();
  const [current, setCurrent] = useState<Level>(value);
  const [confirm, setConfirm] = useState(false);
  const [ring, setRing] = useState<"idle" | "playing">("idle");
  const [pending, start] = useTransition();
  const name = AGENT_INFO[agent].name;
  useEffect(() => setCurrent(value), [value]);
  // Reel mode (hotkey 7) plays the autopilot ring here without changing the setting.
  useEffect(
    () =>
      claimMoments((m) => {
        if (m !== 7) return false;
        setRing("playing");
        setTimeout(() => setRing("idle"), 1700);
        return true;
      }),
    [],
  );

  const apply = (level: Level) => {
    const prev = current;
    setCurrent(level);
    start(async () => {
      const r = await setAutonomyAction(agent, level);
      if (!r.ok) {
        setCurrent(prev);
        toast(r.error, "error");
      } else if (level !== "autopilot") toast(r.message ?? "Saved");
      router.refresh();
    });
  };

  const engage = () => {
    setConfirm(false);
    setRing("playing");
    apply("autopilot");
    setTimeout(() => {
      setRing("idle");
      toast(`${name} is on full autopilot. You'll get a report after each task.`);
    }, 1700);
  };

  return (
    <>
      <div role="radiogroup" aria-label={`How much ${name} can do without asking`} className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
        {LEVELS.map((l) => {
          const active = current === l.id;
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={pending}
              onClick={() => (active ? null : l.id === "autopilot" ? setConfirm(true) : apply(l.id))}
              className={cn(
                "relative flex flex-col items-start rounded-md border p-4 text-left transition-colors duration-[120ms]",
                active ? "border-border-strong bg-surface-2" : "border-border hover:border-border-strong",
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-[14px] font-medium text-fg">{l.label}</span>
                <span aria-hidden className={cn("grid size-4 place-items-center rounded-full border", active ? "border-brand" : "border-border-strong")}>
                  {active ? <span className="size-2 rounded-full bg-brand" /> : null}
                </span>
              </span>
              <span className="mt-1 text-small text-fg-2">{l.detail}</span>
              {l.id === "autopilot" && active ? (
                <span className="mt-3 flex items-center gap-2 text-caption text-on-tint">
                  <AutopilotRing play={false} closed size={16} /> Ring closed: acting on its own
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <AnimatePresence>
        {confirm ? (
          <motion.div className="fixed inset-0 z-[70] grid place-items-center bg-[rgba(8,5,11,0.6)] px-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && setConfirm(false)}>
            <motion.div
              role="alertdialog"
              aria-labelledby="ap-title"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="w-full max-w-[440px] rounded-xl border border-border-strong bg-surface-3 p-6 shadow-[var(--shadow-3)]"
            >
              <h2 id="ap-title" className="text-h2 font-medium text-fg">
                Put {name} on full autopilot?
              </h2>
              <p className="mt-2 text-small text-fg-2">
                {name} will act without waiting for approval and report afterwards. Budgets, brand rules and quiet hours still apply, and you can switch back any time.
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirm(false)} autoFocus>
                  Keep reviewing
                </Button>
                <Button variant="primary" onClick={engage}>
                  Turn on autopilot
                </Button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
        {ring === "playing" ? (
          <motion.div key="ring" className="pointer-events-none fixed inset-0 z-[75] grid place-items-center bg-[rgba(8,5,11,0.72)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <AutopilotRing play closed size={160} contractTo={64} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

export function PauseButton({ agent, enabled }: { agent: AgentKey; enabled: boolean }) {
  const toast = useToast();
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();
  useEffect(() => setOn(enabled), [enabled]);
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await setAgentEnabledAction(agent, !on);
          if (r.ok) {
            setOn(!on);
            toast(r.message ?? "Saved");
          } else toast(r.error, "error");
        })
      }
    >
      {on ? <Pause className="size-4" strokeWidth={1.5} /> : <Play className="size-4" strokeWidth={1.5} />}
      {on ? "Pause agent" : "Resume agent"}
    </Button>
  );
}

export function ModelField({ agent, value, fallback }: { agent: AgentKey; value: string | null; fallback: string | null }) {
  const toast = useToast();
  const [v, setV] = useState(value ?? "");
  const [pending, start] = useTransition();
  const dirty = v.trim() !== (value ?? "");
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setAgentModelAction(agent, v);
          toast(r.ok ? r.message ?? "Saved" : r.error, r.ok ? "ok" : "error");
        });
      }}
    >
      <label htmlFor={`model-${agent}`} className="text-small font-medium text-fg">
        Model override
      </label>
      <div className="flex gap-2">
        <Input id={`model-${agent}`} value={v} onChange={(e) => setV(e.target.value)} placeholder={fallback ?? "claude-sonnet-5"} className="font-mono text-[13px]" spellCheck={false} />
        <Button type="submit" variant="secondary" disabled={!dirty || pending} className="h-10">
          Save
        </Button>
      </div>
      <p className="text-caption text-fg-3">Used for this agent's AI tasks. Leave empty for the workspace default.</p>
    </form>
  );
}

/** "Run now" for the agent's own jobs, with plain notes when the worker can't pick them up. */
export function RunNow({ agent }: { agent: AgentKey }) {
  const info = AGENT_INFO[agent];
  const { snapshot } = useLive();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const online = snapshot?.workerOnline ?? false;
  const mode = snapshot?.workspace.mode ?? "copilot";

  if (!info.jobs.length) {
    return (
      <div className="rounded-md border border-border p-4 text-small text-fg-2">
        {info.name} works from your footage, so there's nothing to run on a schedule here.{" "}
        {info.studioLink ? (
          <a href={info.studioLink.href} className="text-fg underline decoration-border-strong underline-offset-4">
            {info.studioLink.label}
          </a>
        ) : null}{" "}
        to start an edit.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {info.jobs.map((j, i) => (
          <li key={j.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-fg">{j.label}</div>
              <div className="text-small text-fg-2">{j.description}</div>
              {j.ai ? <div className="mt-1 text-caption text-fg-3">Runs on your Claude Code login</div> : null}
            </div>
            <Button
              ref={i === 0 ? firstRef : undefined}
              size="sm"
              variant="secondary"
              disabled={busy === j.id}
              onClick={async () => {
                setBusy(j.id);
                const r = await runNowAction(agent, j.id);
                setBusy(null);
                toast(r.ok ? (online ? r.message ?? "Queued" : `${r.message ?? "Queued"}. It starts when the worker is running.`) : r.error, r.ok ? "ok" : "error");
              }}
            >
              <Play className="size-3.5" strokeWidth={1.75} />
              {busy === j.id ? "Queuing" : "Run now"}
            </Button>
          </li>
        ))}
      </ul>
      {!online ? (
        <p className="flex items-start gap-2 text-small text-fg-2">
          <Terminal className="mt-0.5 size-4 shrink-0 text-fg-3" strokeWidth={1.5} />
          <span>
            The worker is offline, so tasks wait in line. Start it in Terminal: <code className="font-mono text-[12.5px] text-fg">cd ~/AttentionOS && ./aos start</code>
          </span>
        </p>
      ) : null}
    </div>
  );
}
