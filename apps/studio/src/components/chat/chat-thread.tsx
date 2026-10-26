"use client";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Info } from "lucide-react";
import type { ChatMessage, ChatState } from "@/server/queries/chat";
import { loadChatAction, sendChatAction } from "@/server/actions/chat";
import { useLive } from "@/lib/use-live";
import { cn } from "@/components/ui";
import { AgentMonogram } from "@/motion";
import { clock } from "@/components/shell/format";
import { useToast } from "@/components/shell/toast";

const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;

const SUGGESTIONS = ["What's waiting for me?", "How did yesterday go?", "What should I film tomorrow?"];

/** Inline markdown the Chief of Staff uses: *bold*, `code`, bullet lines. Nothing else is interpreted. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*[^*\n]+\*|`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(
      t.startsWith("*") ? (
        <strong key={i++} className="font-medium text-fg">
          {t.slice(1, -1)}
        </strong>
      ) : (
        <code key={i++} className="rounded-[4px] bg-surface-3 px-1 py-px font-mono text-[12.5px] text-fg">
          {t.slice(1, -1)}
        </code>
      ),
    );
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = (k: number) => {
    if (!list.length) return;
    blocks.push(
      <ul key={`l${k}`} className="my-1 flex flex-col gap-1">
        {list.map((l, j) => (
          <li key={j} className="relative pl-4 before:absolute before:left-1 before:top-[10px] before:size-1 before:rounded-full before:bg-fg-3">
            {inline(l)}
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  text.split("\n").forEach((line, k) => {
    const b = /^\s*(?:[•\-–]|\d+\.)\s+(.*)$/.exec(line);
    if (b) return void list.push(b[1]!);
    flush(k);
    if (!line.trim()) blocks.push(<div key={k} className="h-2" />);
    else blocks.push(<p key={k}>{inline(line)}</p>);
  });
  flush(-1);
  return <div className="flex flex-col">{blocks}</div>;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const CHANNEL: Record<string, string> = { telegram: "Telegram", discord: "Discord", email: "Email", console: "Console", studio: "Studio" };

function Message({ m, fresh, tz }: { m: ChatMessage; fresh: boolean; tz?: string }) {
  const mine = m.direction === "in";
  const via = m.channel !== "studio" ? `via ${CHANNEL[m.channel] ?? m.channel}` : null;
  return (
    <motion.div
      initial={fresh ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className={cn("flex gap-3", mine ? "justify-end" : "justify-start")}
    >
      {!mine ? (
        <span className="mt-0.5 shrink-0">
          <AgentMonogram agent={{ monogram: "Cs", name: "Chief of Staff", state: "idle" }} size={24} />
        </span>
      ) : null}
      <div className={cn("flex min-w-0 max-w-[min(560px,85%)] flex-col", mine ? "items-end" : "items-start")}>
        <div
          className={cn(
            "text-[15px] leading-6 break-words",
            mine ? "rounded-lg rounded-br-sm bg-surface-3 px-4 py-2.5 text-fg" : "pt-0.5 text-fg-2 [&_p]:text-fg",
          )}
        >
          <RichText text={m.text || "(attachment)"} />
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-caption text-fg-3" suppressHydrationWarning>
          {clock(m.at, tz)}
          {via ? <span>· {via}</span> : null}
          {m.direction === "out" && m.status === "failed" ? <span>· not delivered</span> : null}
          {m.direction === "out" && m.status === "queued" ? <span>· sending</span> : null}
        </div>
      </div>
    </motion.div>
  );
}

/** Turns a run error into what the owner should do about it. */
export function failureHint(error: string | null): string {
  const e = error ?? "";
  if (/401|authenticat|oauth|not logged in|sign[- ]?in/i.test(e)) {
    return "Claude's sign-in isn't working. In Terminal run: cd ~/AttentionOS && ./aos claude-login, then try again.";
  }
  if (/isn't installed|ENOENT/i.test(e)) return "Claude Code isn't available to AttentionOS. Run ./aos doctor to see how to fix it.";
  if (/rate limit|usage limit|429/i.test(e)) return "You've hit your Claude plan's usage limit for now. Try again later.";
  return e ? `Chief of Staff couldn't answer that one: ${e}` : "Chief of Staff couldn't answer that one. Try again.";
}

function Working({ status, error, workerOnline, mode }: { status: "queued" | "running" | "failed"; error?: string | null; workerOnline: boolean; mode: "copilot" | "autopilot" }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE_OUT }} className="flex gap-3">
      <AgentMonogram agent={{ monogram: "Cs", name: "Chief of Staff", state: status === "running" ? "working" : "idle" }} size={24} />
      <div className="pt-1 text-small text-fg-3">
        {status === "running" ? (
          <span className="flex items-center gap-2">
            <span className="flex gap-1" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1 rounded-full bg-brand" style={{ animation: `signal-pulse 1.2s ${i * 0.16}s ease-in-out infinite` }} />
              ))}
            </span>
            Chief of Staff is writing
          </span>
        ) : status === "failed" ? (
          failureHint(error ?? null)
        ) : workerOnline ? (
          // Chat is top priority on the queue and the worker keeps a slot free for it.
          "Starting now."
        ) : (
          "Queued. It's answered as soon as the worker is running."
        )}
      </div>
    </motion.div>
  );
}

/** Explains plainly why answers might not arrive, and what to do instead. */
export function ChatNotice({ workerOnline, compact }: { mode: "copilot" | "autopilot"; workerOnline: boolean; compact?: boolean }) {
  if (workerOnline) return null;
  return (
    <div className={cn("flex gap-3 rounded-lg border border-border bg-surface-1 text-small text-fg-2", compact ? "p-3" : "p-4")}>
      <Info className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={1.5} />
      <div className="flex flex-col gap-1">
        <p className="text-fg">Your team isn't running right now.</p>
        <p>
          Start it in Terminal with <code className="font-mono text-[12.5px] text-fg">cd ~/AttentionOS && ./aos start</code> and the Chief of Staff answers here, using your own
          Claude Code login. Messages you send now are answered as soon as it starts.
        </p>
      </div>
    </div>
  );
}

export function ChatThread({ initial, compact = false, autoFocus = false }: { initial: ChatState; compact?: boolean; autoFocus?: boolean }) {
  const { snapshot, onEvent } = useLive();
  const toast = useToast();
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState("");
  const [sending, startSend] = useTransition();
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const seen = useRef(new Set(initial.messages.map((m) => m.id)));
  const workerOnline = snapshot?.workerOnline ?? false;
  const mode = snapshot?.workspace.mode ?? state.mode;
  const tz = snapshot?.workspace.timezone;

  const reload = useCallback(async () => {
    try {
      const next = await loadChatAction();
      setState(next);
    } catch {
      // Background refresh: the next poll or chief event tries again, and sending shows its own error.
    }
  }, []);

  useEffect(() => setState(initial), [initial]);

  // New Chief of Staff activity (or anything from the worker answering) refreshes the thread.
  useEffect(() => onEvent((e) => e.agent === "chief_of_staff" && void reload()), [onEvent, reload]);
  useEffect(() => {
    if (!state.pending.length) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [state.pending.length, reload]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.pending.length]);

  useEffect(() => {
    for (const m of state.messages) seen.current.add(m.id);
  });

  const send = (text: string) => {
    const clean = text.trim();
    if (!clean || sending) return;
    const temp: ChatMessage = { id: -Date.now(), direction: "in", channel: "studio", text: clean, status: "received", at: new Date().toISOString(), messageId: null, replyTo: null };
    setState((s) => ({ ...s, messages: [...s.messages, temp] }));
    setDraft("");
    startSend(async () => {
      const r = await sendChatAction(clean);
      if (!r.ok) {
        toast(r.error, "error");
        setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== temp.id) }));
        setDraft(clean);
        return;
      }
      await reload();
    });
  };

  const groups: { day: string; items: ChatMessage[] }[] = [];
  for (const m of state.messages) {
    const day = dayLabel(m.at);
    const g = groups.at(-1);
    if (g && g.day === day) g.items.push(m);
    else groups.push({ day, items: [m] });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", compact ? "px-5 py-5" : "py-2 pr-1")}>
        <div className="mx-auto flex max-w-[760px] flex-col gap-6">
          {groups.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-h3 font-medium text-fg">Ask your Chief of Staff anything</p>
              <p className="mx-auto mt-1 max-w-sm text-small text-fg-2">What's waiting, how posts are doing, what to film next. It answers here and can hand work to the team.</p>
            </div>
          ) : null}
          {groups.map((g, gi) => (
            <Fragment key={`${gi}-${g.day}`}>
              <div className="flex items-center gap-3 text-caption text-fg-3" suppressHydrationWarning>
                <span className="h-px flex-1 bg-border" />
                {g.day}
                <span className="h-px flex-1 bg-border" />
              </div>
              {g.items.map((m) => (
                <Message key={m.id} m={m} fresh={!seen.current.has(m.id)} tz={tz} />
              ))}
            </Fragment>
          ))}
          <AnimatePresence>
            {state.pending.slice(-1).map((p) => (
              <Working key={p.runId} status={p.status} error={p.error} workerOnline={workerOnline} mode={mode} />
            ))}
          </AnimatePresence>
        </div>
      </div>

      <div className={cn("shrink-0", compact ? "border-t border-border p-4" : "pt-4")}>
        <div className="mx-auto max-w-[760px]">
          <div className="mb-3">
            <ChatNotice mode={mode} workerOnline={workerOnline} compact={compact} />
          </div>
          {state.messages.length < 3 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="h-8 rounded-full border border-border px-3 text-small text-fg-2 transition-colors hover:border-border-strong hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
            className="flex items-end gap-2 rounded-lg border border-border bg-surface-1 p-2 transition-[border-color,box-shadow] focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--brand-tint)]"
          >
            <label htmlFor={compact ? "chat-quick" : "chat-main"} className="sr-only">
              Message your Chief of Staff
            </label>
            <textarea
              id={compact ? "chat-quick" : "chat-main"}
              ref={input}
              autoFocus={autoFocus}
              rows={1}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              placeholder="Move Thursday's post to Friday morning"
              style={{ outline: "none" }}
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-6 text-fg outline-none placeholder:text-fg-3"
            />
            <button
              type="submit"
              disabled={!draft.trim() || sending}
              className="grid size-9 shrink-0 place-items-center rounded-md bg-brand text-on-brand transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-3"
              aria-label="Send"
            >
              <ArrowUp className="size-4" strokeWidth={2} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
