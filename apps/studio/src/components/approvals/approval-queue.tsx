"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCheck, CircleCheck } from "lucide-react";
import type { ApprovalView } from "@/server/queries/approvals";
import { approveAllAction, decideApprovalAction } from "@/server/actions/approvals";
import { Button, buttonClass } from "@/components/ui";
import { ApproveAllCascade } from "@/motion";
import { claimMoments } from "@/components/reel";
import { who } from "@/components/shell/format";
import { useToast } from "@/components/shell/toast";
import { markDecided } from "@/components/shell/decided";
import { ApprovalCard, type Decision } from "./approval-card";

const EASE = [0.2, 0.8, 0.2, 1] as const;

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function QueueClear() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-20 text-center">
      <CircleCheck className="size-6 text-success" strokeWidth={1.5} />
      <p className="mt-1 text-h2 font-medium text-fg">Queue clear. Your agents are on it.</p>
      <p className="max-w-sm text-small text-fg-2">New drafts land here the moment they're ready. You'll get a nudge in chat too.</p>
      <Link href="/" className={buttonClass("secondary", "md", "mt-4")}>
        Back to Home
      </Link>
    </div>
  );
}

/** Approve-all confirmation (DESIGN §8.1: the one place a confirmation dialog earns its keep). */
function ConfirmAll({ items, onCancel, onConfirm }: { items: ApprovalView[]; onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const byAgent = new Map<string, number>();
  for (const a of items) byAgent.set(a.agent, (byAgent.get(a.agent) ?? 0) + 1);
  return (
    <motion.div className="fixed inset-0 z-[70] grid place-items-center bg-[rgba(8,5,11,0.6)] px-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <motion.div
        role="alertdialog"
        aria-labelledby="confirm-all-title"
        aria-describedby="confirm-all-desc"
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: 0.2, ease: EASE }}
        className="w-full max-w-[440px] rounded-xl border border-border-strong bg-surface-3 p-6 shadow-[var(--shadow-3)]"
      >
        <h2 id="confirm-all-title" className="text-h2 font-medium text-fg">
          Approve all {items.length}?
        </h2>
        <p id="confirm-all-desc" className="mt-2 text-small text-fg-2">
          Each agent picks its item up right away. Posts go out at their scheduled time, and replies are sent as drafted.
        </p>
        <ul className="mt-4 flex flex-col gap-1.5 rounded-md bg-surface-2 p-3">
          {[...byAgent].map(([agent, n]) => (
            <li key={agent} className="flex justify-between text-small">
              <span className="text-fg">{who(agent).name}</span>
              <span className="text-fg-2 tabular">{n}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={confirmRef} variant="primary" onClick={onConfirm}>
            Approve all {items.length}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function ApprovalQueue({ items: initial, handles, tz }: { items: ApprovalView[]; handles: Record<string, string>; tz?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(initial);
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [cascade, setCascade] = useState<"idle" | "playing" | "done">("idle");
  const refs = useRef(new Map<string, HTMLElement>());
  const gone = useRef(new Set<string>());
  // Reel mode (hotkey 6) plays the cascade in place without deciding anything.
  const rehearsal = useRef(false);
  const countRef = useRef(0);
  countRef.current = items.length;
  useEffect(
    () =>
      claimMoments((m) => {
        if (m !== 6 || countRef.current === 0) return false;
        rehearsal.current = true;
        setCascade("playing");
        return true;
      }),
    [],
  );

  // Fresh server data replaces the local list (minus what was just decided here), except mid-cascade.
  useEffect(() => {
    if (cascade === "playing") return;
    const fresh = initial.filter((x) => !gone.current.has(x.id));
    setItems(fresh);
    if (fresh.length) setCascade("idle");
  }, [initial, cascade]);

  useEffect(() => setFocus((f) => Math.min(f, Math.max(0, items.length - 1))), [items.length]);

  const decide = async (item: ApprovalView, decision: Decision, note?: string): Promise<boolean> => {
    setBusy(item.id);
    const r = await decideApprovalAction(item.id, decision, note);
    setBusy(null);
    if (!r.ok) {
      toast(r.error, "error");
      return false;
    }
    gone.current.add(item.id);
    markDecided([item.id]);
    const name = who(item.agent).name;
    toast(decision === "approved" ? `Approved. ${name} takes it from here.` : decision === "revised" ? `Sent back to ${name} with your notes.` : `Rejected. ${name} won't use it.`);
    setItems((list) => list.filter((x) => x.id !== item.id));
    router.refresh();
    return true;
  };

  // The video review card decides on its own (approve with captions, notes on the timeline); then it leaves the queue.
  const settled = (item: ApprovalView, decision: Decision, message?: string) => {
    gone.current.add(item.id);
    markDecided([item.id]);
    toast(message ?? (decision === "approved" ? "Approved" : decision === "revised" ? "Sent back with your notes" : "Rejected"));
    setItems((list) => list.filter((x) => x.id !== item.id));
    router.refresh();
  };

  const approveAll = async () => {
    setConfirm(false);
    const ids = items.map((i) => i.id);
    for (const id of ids) gone.current.add(id);
    setCascade("playing");
    const r = await approveAllAction(ids);
    markDecided(r.approved);
    if (r.failed.length) toast(`${r.failed.length} couldn't be approved. ${r.failed[0]!.error}`, "error");
  };

  // Keyboard (DESIGN §12): J/K move, A approves, E edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || confirm || cascade !== "idle") return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        e.preventDefault();
        setFocus((f) => {
          const next = Math.max(0, Math.min(items.length - 1, f + (k === "j" ? 1 : -1)));
          const el = refs.current.get(items[next]?.id ?? "");
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
          return next;
        });
      } else if (k === "a" && items[focus] && !busy) {
        e.preventDefault();
        void decide(items[focus]!, "approved");
      } else if (k === "e" && items[focus]?.editHref) {
        e.preventDefault();
        router.push(items[focus]!.editHref!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Scroll to a card linked as /approvals#ap-5.
  useEffect(() => {
    const ref = window.location.hash.slice(1);
    const idx = items.findIndex((i) => i.ref === ref);
    if (idx >= 0) {
      setFocus(idx);
      setTimeout(() => refs.current.get(items[idx]!.id)?.scrollIntoView({ block: "start" }), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!items.length && cascade !== "playing") return <QueueClear />;

  const cards = items.map((item, i) => (
    <ApprovalCard
      key={item.id}
      ref={(el) => {
        if (el) refs.current.set(item.id, el);
        else refs.current.delete(item.id);
      }}
      item={item}
      handles={handles}
      tz={tz}
      focused={i === focus}
      busy={busy === item.id}
      onFocus={() => setFocus(i)}
      onDecide={decide}
      onSettled={settled}
    />
  ));

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4">
        <p className="text-small text-fg-3 max-md:invisible">
          <kbd className="font-sans text-fg-2">J</kbd> <kbd className="font-sans text-fg-2">K</kbd> to move, <kbd className="font-sans text-fg-2">A</kbd> to approve, <kbd className="font-sans text-fg-2">E</kbd> to edit
        </p>
        {items.length > 1 ? (
          <Button variant="secondary" onClick={() => setConfirm(true)} disabled={cascade !== "idle"}>
            <CheckCheck className="size-4" strokeWidth={1.75} />
            Approve all {items.length}
          </Button>
        ) : null}
      </div>
      {cascade === "idle" ? (
        <motion.div layout className="flex flex-col gap-6">
          <AnimatePresence initial={false} mode="popLayout">
            {cards.map((c, i) => (
              <motion.div key={items[i]!.id} layout exit={{ opacity: 0, x: 48, transition: { duration: 0.32, ease: [0.4, 0, 1, 1] } }} transition={{ duration: 0.32, ease: EASE }}>
                {c}
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <ApproveAllCascade
          play={cascade === "playing"}
          gap={24}
          onDone={() => {
            if (rehearsal.current) {
              rehearsal.current = false;
              setTimeout(() => setCascade("idle"), 1800);
              return;
            }
            setCascade("done");
            setItems([]);
            router.refresh();
          }}
          emptyState={<QueueClear />}
        >
          {cards}
        </ApproveAllCascade>
      )}
      <AnimatePresence>{confirm ? <ConfirmAll items={items} onCancel={() => setConfirm(false)} onConfirm={approveAll} /> : null}</AnimatePresence>
    </>
  );
}
