"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CornerDownLeft, MessageSquare, Search, Users } from "lucide-react";
import { NAV } from "@/lib/nav";
import { useLive } from "@/lib/use-live";
import { cn } from "@/components/ui";
import { AGENT_INFO, AGENT_ORDER } from "@/components/agents/meta";
import { sendChatAction } from "@/server/actions/chat";
import { NAV_ICONS, needsYou } from "./nav";
import { useToast } from "./toast";

type Item = { id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void };

const EASE = [0.2, 0.8, 0.2, 1] as const;

/** ⌘K: jump anywhere, open an agent, or send a line straight to the Chief of Staff. */
export function CommandBar({ open, onClose, onOpenChat }: { open: boolean; onClose: () => void; onOpenChat: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { snapshot } = useLive();
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (href: string) => () => {
      router.push(href);
      onClose();
    };
    const counts = needsYou(snapshot?.approvals ?? []);
    const base: Item[] = [
      ...NAV.map((n) => {
        const Icon = NAV_ICONS[n.icon] ?? Search;
        return { id: n.href, label: n.label, hint: counts[n.href] ? `${counts[n.href]} need you` : undefined, icon: <Icon className="size-4" strokeWidth={1.5} />, run: go(n.href) };
      }),
      { id: "/activity", label: "Activity log", icon: <Search className="size-4" strokeWidth={1.5} />, run: go("/activity") },
      { id: "/chat", label: "Chat with Chief of Staff", icon: <MessageSquare className="size-4" strokeWidth={1.5} />, run: () => (onClose(), onOpenChat()) },
      ...AGENT_ORDER.map((k) => ({ id: `/agents/${k}`, label: AGENT_INFO[k].name, hint: AGENT_INFO[k].role, icon: <Users className="size-4" strokeWidth={1.5} />, run: go(`/agents/${k}`) })),
    ];
    const needle = q.trim().toLowerCase();
    const filtered = needle ? base.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(needle)) : base.slice(0, 9);
    if (needle.length > 2) {
      filtered.push({
        id: "ask",
        label: `Ask Chief of Staff: “${q.trim()}”`,
        icon: <MessageSquare className="size-4" strokeWidth={1.5} />,
        run: async () => {
          onClose();
          const r = await sendChatAction(q.trim());
          if (r.ok) {
            toast("Sent to your Chief of Staff");
            onOpenChat();
          } else toast(r.error, "error");
        },
      });
    }
    return filtered;
  }, [q, router, onClose, onOpenChat, snapshot, toast]);

  useEffect(() => setIndex(0), [q]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[70] flex items-start justify-center bg-[rgba(8,5,11,0.6)] px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-label="Search or ask"
            initial={{ opacity: 0, y: -6, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="w-full max-w-[560px] overflow-hidden rounded-xl border border-border-strong bg-surface-3 shadow-[var(--shadow-3)]"
          >
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search className="size-4 text-fg-3" strokeWidth={1.5} />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onClose();
                  else if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(items.length - 1, i + 1)));
                  else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
                  else if (e.key === "Enter") (e.preventDefault(), items[index]?.run());
                }}
                placeholder="Jump to a page, or ask your Chief of Staff"
                style={{ outline: "none" }}
                className="h-14 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3"
                aria-label="Search or ask"
              />
              <kbd className="rounded-[4px] border border-border px-1.5 text-[11px] leading-[18px] text-fg-3">Esc</kbd>
            </div>
            <ul className="max-h-[50vh] overflow-y-auto p-2" role="listbox">
              {items.map((it, i) => (
                <li key={it.id} role="option" aria-selected={i === index}>
                  <button
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={it.run}
                    className={cn("flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-[14px]", i === index ? "bg-surface-2 text-fg" : "text-fg-2")}
                  >
                    <span className="text-fg-3">{it.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {it.hint ? <span className="truncate text-caption text-fg-3">{it.hint}</span> : null}
                    {i === index ? <CornerDownLeft className="size-3.5 text-fg-3" strokeWidth={1.5} /> : null}
                  </button>
                </li>
              ))}
              {!items.length ? <li className="px-3 py-6 text-center text-small text-fg-3">Keep typing to ask your Chief of Staff.</li> : null}
            </ul>
            <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-caption text-fg-3">
              <span><kbd className="font-sans">g h</kbd> Home</span>
              <span><kbd className="font-sans">g a</kbd> Approvals</span>
              <span><kbd className="font-sans">g c</kbd> Command view</span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
