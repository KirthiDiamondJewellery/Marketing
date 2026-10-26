"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, CircleCheck } from "lucide-react";

/**
 * Page-level toasts for the work surfaces ("Moved to Friday, 11:00 AM"). Call `toast()` anywhere on the client and
 * mount one <Toaster /> per page.
 */
type Toast = { id: number; message: string; tone: "ok" | "error"; by?: string };
type Listener = (t: Toast) => void;

const listeners = new Set<Listener>();
let seq = 0;

export function toast(message: string, opts: { tone?: "ok" | "error"; by?: string } = {}) {
  const t: Toast = { id: ++seq, message, tone: opts.tone ?? "ok", ...(opts.by ? { by: opts.by } : {}) };
  for (const fn of listeners) fn(t);
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const fn: Listener = (t) => {
      setItems((prev) => [...prev.slice(-2), t]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), t.tone === "error" ? 6000 : 3600);
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6">
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className="pointer-events-auto flex max-w-[min(92vw,440px)] items-center gap-3 rounded-md border border-border-strong bg-surface-3 px-4 py-2.5 text-small text-fg shadow-[var(--shadow-3)]"
            role={t.tone === "error" ? "alert" : "status"}
          >
            {t.tone === "error" ? <CircleAlert className="size-4 shrink-0 text-danger" /> : <CircleCheck className="size-4 shrink-0 text-success" />}
            <span className="min-w-0">
              {t.by ? <span className="text-fg-2">{t.by} · </span> : null}
              {t.message}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
