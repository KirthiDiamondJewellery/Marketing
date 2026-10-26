"use client";
import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Copy, Check, Plus, X } from "lucide-react";
import type { AgentKey } from "@attentionos/core";
import { Button, cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { AgentMonogram, SignalLine } from "@/motion";
import { AGENT_INFO } from "@/components/agents/meta";
import type { RunInfo } from "@/server/onboarding";
import type { SetupResult } from "@/server/actions/onboarding";

/** Runs a setup action: pending state, a toast on error (or on a message), then a server refresh. */
export function useSetupAction() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const run = useCallback(
    (fn: () => Promise<SetupResult>, opts: { onOk?: (r: Extract<SetupResult, { ok: true }>) => void; quiet?: boolean; refresh?: boolean } = {}) =>
      new Promise<SetupResult>((resolve) => {
        start(async () => {
          const r = await fn().catch((): SetupResult => ({ ok: false, error: "Studio couldn't reach the server. Try again." }));
          if (!r.ok) toast(r.error, "error");
          else {
            if (r.message && !opts.quiet) toast(r.message);
            opts.onOk?.(r);
            if (r.redirect) router.push(r.redirect);
            else if (opts.refresh !== false) router.refresh();
          }
          resolve(r);
        });
      }),
    [router, toast],
  );
  return { run, pending };
}

/** Re-renders the page every few seconds while agent work is under way. */
export function useRefreshWhile(active: boolean, ms = 2500) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [active, ms, router]);
}

export const isActive = (run: RunInfo | undefined) => run?.status === "queued" || run?.status === "running";

/** The headline block of every step: Sora, centred (DESIGN §4.1: onboarding may centre). */
export function StepHeader({ title, lede, kicker }: { title: string; lede?: ReactNode; kicker?: string }) {
  return (
    <header className="flex flex-col items-center text-center">
      {kicker ? <p className="text-small text-fg-3">{kicker}</p> : null}
      <h1 className="mt-2 font-display text-[34px] leading-[40px] text-fg md:text-display-l">{title}</h1>
      {lede ? <p className="mt-3 max-w-[56ch] text-body text-fg-2">{lede}</p> : null}
    </header>
  );
}

/** Back · I'll do this later · one primary action. */
export function StepFooter({
  onBack,
  onSkip,
  primary,
  secondary,
  busy,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  primary?: { label: string; onClick: () => void; disabled?: boolean };
  secondary?: ReactNode;
  busy?: boolean;
}) {
  return (
    <footer className="sticky bottom-0 z-10 -mx-4 mt-10 border-t border-border bg-bg/95 px-4 py-4 backdrop-blur-sm md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-none">
      <div className="flex flex-col-reverse items-stretch gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center justify-between gap-2 md:justify-start">
          {onBack ? (
            <Button variant="ghost" onClick={onBack} disabled={busy} className="h-11 md:h-9">
              Back
            </Button>
          ) : (
            <span />
          )}
          {onSkip ? (
            <Button variant="ghost" onClick={onSkip} disabled={busy} className="h-11 md:h-9">
              I&apos;ll do this later
            </Button>
          ) : null}
        </div>
        <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
          {secondary}
          {primary ? (
            <Button variant="primary" size="lg" onClick={primary.onClick} disabled={primary.disabled || busy} className="h-11">
              {primary.label}
            </Button>
          ) : null}
        </div>
      </div>
    </footer>
  );
}

export function Section({ title, hint, children, className }: { title: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border bg-surface-1 p-5 md:p-6", className)}>
      <h2 className="text-h3 font-medium text-fg">{title}</h2>
      {hint ? <p className="mt-1 text-small text-fg-2">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One agent visibly working on the owner's request, with its latest progress line. */
export function AgentWorking({ agent, run, fallback }: { agent: AgentKey; run: RunInfo | undefined; fallback: string }) {
  const info = AGENT_INFO[agent];
  const failed = run?.status === "failed" || run?.status === "cancelled";
  const working = isActive(run);
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border border-border bg-surface-1 p-4", working && "signal-left")} role="status" aria-live="polite">
      <AgentMonogram agent={{ monogram: info.monogram, name: info.name, state: working ? "working" : failed ? "blocked" : "idle" }} size={32} />
      <div className="min-w-0 flex-1">
        <p className="text-small font-medium text-fg">{info.name}</p>
        <p className={cn("text-small", failed ? "text-danger" : "text-fg-2")}>
          {failed ? (run?.error ?? "That didn't work. Try again.") : working ? (run?.progress ?? fallback) : (run?.progress ?? "Done")}
        </p>
        {working ? <SignalLine pulse className="mt-3 !w-24" /> : null}
      </div>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-small text-danger" role="alert">
      <CircleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
      <span>{children}</span>
    </p>
  );
}

export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md bg-surface-2 py-1.5 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-log text-fg">{command}</code>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? <Check className="size-4 text-success" strokeWidth={1.75} /> : <Copy className="size-4" strokeWidth={1.75} />}
      </Button>
    </div>
  );
}

/** An editable list of short lines (quotes, objections, banned phrases). */
export function ListEditor({ id, items, onChange, placeholder, max = 15 }: { id: string; items: string[]; onChange: (next: string[]) => void; placeholder: string; max?: number }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v) || items.length >= max) return;
    onChange([...items, v]);
    setDraft("");
    inputRef.current?.focus();
  };
  return (
    <div className="flex flex-col gap-2">
      {items.length ? (
        <ul className="flex flex-col gap-1.5">
          {items.map((it, i) => (
            <li key={`${i}-${it}`} className="group flex items-start gap-2 rounded-sm bg-surface-2 px-3 py-2 text-small text-fg">
              <span className="min-w-0 flex-1">{it}</span>
              <button type="button" aria-label={`Remove "${it}"`} className="shrink-0 text-fg-3 hover:text-fg" onClick={() => onChange(items.filter((_, j) => j !== i))}>
                <X className="size-4" strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="h-10 w-full rounded-sm border border-border bg-surface-2 px-3 text-[15px] text-fg outline-none placeholder:text-fg-3 focus:border-brand focus:shadow-[0_0_0_3px_var(--brand-tint)]"
        />
        <Button variant="secondary" onClick={add} aria-label="Add" className="h-10 shrink-0 px-3">
          <Plus className="size-4" strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

/** A small segmented control (sentence-case labels, one choice). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-full flex-wrap gap-1 rounded-md border border-border bg-surface-2 p-1 md:w-auto">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-9 flex-1 rounded-[7px] px-3 text-small font-medium transition-colors duration-[120ms] md:flex-none",
            value === o.value ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Handles as chips: type one and press Enter (or a comma), or paste several at once. The parent decides what's
 * accepted (cleaning, duplicates, the per-platform cap) and says why something wasn't.
 */
export function ChipsInput({
  id,
  label,
  items,
  onAdd,
  onRemove,
  placeholder,
  disabled,
}: {
  id: string;
  label: string;
  items: { key: string; label: string; hint?: string }[];
  onAdd: (text: string) => void;
  onRemove: (key: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (text = draft) => {
    if (!text.trim()) return;
    onAdd(text);
    setDraft("");
  };
  return (
    <div
      className="flex min-h-12 flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-2 p-1.5 focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--brand-tint)]"
      onClick={() => inputRef.current?.focus()}
    >
      {items.map((it) => (
        <span key={it.key} title={it.hint} className="inline-flex h-8 max-w-full items-center gap-1 rounded-sm bg-surface-3 pl-2.5 pr-1 text-small text-fg">
          <span className="truncate">{it.label}</span>
          <button
            type="button"
            aria-label={`Remove ${it.label}`}
            className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(it.key);
            }}
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      ))}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        value={draft}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,\s]$/.test(v) && v.trim()) commit(v);
          else setDraft(v);
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (/[\s,;]/.test(text.trim())) {
            e.preventDefault();
            commit(text);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && items.length) {
            onRemove(items[items.length - 1]!.key);
          }
        }}
        onBlur={() => commit()}
        placeholder={items.length ? "" : placeholder}
        // The whole box shows the focus ring (focus-within), so the inner field doesn't draw a second one.
        style={{ outline: "none" }}
        className="h-8 min-w-[10ch] flex-1 bg-transparent px-1.5 text-[15px] text-fg placeholder:text-fg-3"
      />
    </div>
  );
}

/** One plain status line with a coloured dot (board rows, account matches). */
export function StatusLine({ tone, children }: { tone: "ok" | "work" | "wait" | "warn" | "off"; children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-2 text-small text-fg-2">
      <span
        aria-hidden
        className={cn(
          "mt-[7px] size-1.5 shrink-0 rounded-full",
          tone === "ok" ? "bg-success" : tone === "work" ? "animate-pulse bg-brand motion-reduce:animate-none" : tone === "warn" ? "bg-warning" : tone === "wait" ? "bg-fg-3" : "bg-border-strong",
        )}
      />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
