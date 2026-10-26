"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2, X } from "lucide-react";
import type { ChatState } from "@/server/queries/chat";
import { loadChatAction } from "@/server/actions/chat";
import { useLive } from "@/lib/use-live";
import { AgentMonogram } from "@/motion";
import { cn } from "@/components/ui";
import { humanLabel } from "@/components/shell/format";
import { ChatThread } from "./chat-thread";

const EASE = [0.2, 0.8, 0.2, 1] as const;

/**
 * The Chief of Staff, always in the bottom corner: a round launcher that opens a chat panel above it (a sheet on
 * phones). It glows while the Chief of Staff is working, so you can see it's busy without opening it.
 */
export function ChiefLauncher({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const { snapshot } = useLive();
  const cos = snapshot?.agents.find((a) => a.key === "chief_of_staff");
  const state = cos?.state ?? "idle";
  const [chat, setChat] = useState<ChatState | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    loadChatAction().then((s) => alive && setChat(s)).catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      <AnimatePresence>
        {open ? (
          <>
            <motion.div key="scrim" className="fixed inset-0 z-[60] bg-[rgba(8,5,11,0.55)] md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
            <motion.aside
              key="panel"
              role="dialog"
              aria-label="Chief of Staff"
              className="fixed z-[61] flex flex-col overflow-hidden border border-border bg-surface-2 shadow-[var(--shadow-3)] max-md:inset-x-0 max-md:bottom-0 max-md:h-[88dvh] max-md:rounded-t-xl md:bottom-24 md:right-6 md:h-[min(640px,calc(100dvh-128px))] md:w-[420px] md:rounded-xl"
              initial={{ y: 16, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 16, opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.28, ease: EASE }}
              style={{ transformOrigin: "bottom right" }}
            >
              <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4">
                <AgentMonogram agent={{ monogram: "Cs", name: "Chief of Staff", state }} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium text-fg">Chief of Staff</div>
                  <div className="truncate text-caption text-fg-3">{state === "working" ? humanLabel(cos?.label) : "Ask for anything. It hands work to the team."}</div>
                </div>
                <Link href="/chat" onClick={onClose} className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg" aria-label="Open full chat">
                  <Maximize2 className="size-4" strokeWidth={1.5} />
                </Link>
                <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-fg" aria-label="Close">
                  <X className="size-4" strokeWidth={1.5} />
                </button>
              </header>
              <div className="min-h-0 flex-1">{chat ? <ChatThread initial={chat} compact autoFocus /> : <div className="p-6 text-small text-fg-3">Opening the conversation…</div>}</div>
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      <button
        type="button"
        onClick={open ? onClose : onOpen}
        aria-expanded={open}
        aria-label={open ? "Close the Chief of Staff" : "Talk to the Chief of Staff"}
        title="Chief of Staff"
        className={cn(
          "group fixed bottom-[calc(80px+env(safe-area-inset-bottom))] right-4 z-[55] flex items-center gap-2.5 rounded-full border border-border-strong bg-surface-2 p-1.5 shadow-[var(--shadow-3)] transition-[transform,background-color] duration-150 hover:bg-surface-3 active:scale-[0.97] md:bottom-6 md:right-6 md:pr-4",
          open && "max-md:hidden",
        )}
      >
        <span className={cn("relative rounded-full", state === "working" && "signal-pulse")}>
          <AgentMonogram agent={{ monogram: "Cs", name: "Chief of Staff", state }} size={32} />
        </span>
        <span className="hidden text-small font-medium text-fg md:inline">{open ? "Close" : "Chief of Staff"}</span>
      </button>
    </>
  );
}
