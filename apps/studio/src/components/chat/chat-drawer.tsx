// Unfinished feature: a quick-open chat drawer with the Chief of Staff from anywhere in the shell. Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2, X } from "lucide-react";
import type { ChatState } from "@/server/queries/chat";
import { loadChatAction } from "@/server/actions/chat";
import { AgentMonogram } from "@/motion";
import { ChatThread } from "./chat-thread";

const EASE = [0.2, 0.8, 0.2, 1] as const;

/** Quick-open chat with the Chief of Staff, from anywhere in the shell. */
export function ChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, setState] = useState<ChatState | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    loadChatAction().then((s) => alive && setState(s)).catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="scrim"
            className="fixed inset-0 z-[60] bg-[rgba(8,5,11,0.55)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.aside
            key="panel"
            role="dialog"
            aria-label="Chief of Staff"
            className="fixed inset-y-0 right-0 z-[61] flex w-full max-w-[440px] flex-col border-l border-border bg-surface-2 shadow-[var(--shadow-3)] max-md:inset-x-0 max-md:top-auto max-md:h-[88dvh] max-md:max-w-none max-md:rounded-t-xl max-md:border-l-0 max-md:border-t"
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.32, ease: EASE }}
          >
            <header className="flex h-[72px] shrink-0 items-center gap-3 border-b border-border px-5">
              <AgentMonogram agent={{ monogram: "Cs", name: "Chief of Staff", state: "idle" }} size={32} />
              <div className="min-w-0 flex-1">
                <div className="text-h3 font-medium text-fg">Chief of Staff</div>
                <div className="text-caption text-fg-3">Runs the team and talks to you</div>
              </div>
              <Link href="/chat" onClick={onClose} className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg" aria-label="Open full chat">
                <Maximize2 className="size-4" strokeWidth={1.5} />
              </Link>
              <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg" aria-label="Close">
                <X className="size-4" strokeWidth={1.5} />
              </button>
            </header>
            <div className="min-h-0 flex-1">
              {state ? <ChatThread initial={state} compact autoFocus /> : <div className="p-6 text-small text-fg-3">Opening the conversation…</div>}
            </div>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
