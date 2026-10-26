"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

/** A centred modal on desktop, a bottom sheet on phones. Esc and the scrim close it. */
export function Dialog({ open, onClose, title, description, children, size = "md" }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; size?: "md" | "lg" }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    setTimeout(() => panel.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus(), 30);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-center md:items-center md:p-6">
          <motion.div
            className="absolute inset-0 bg-[rgba(8,5,11,0.6)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={`relative max-h-[92dvh] w-full overflow-y-auto rounded-t-xl border border-border bg-surface-3 p-6 shadow-[var(--shadow-3)] md:rounded-xl ${size === "lg" ? "md:max-w-[880px]" : "md:max-w-[520px]"}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-h2 font-medium text-fg">{title}</h2>
                {description ? <p className="mt-1 text-small text-fg-2">{description}</p> : null}
              </div>
              <button type="button" onClick={onClose} className="-mr-2 -mt-1 grid size-9 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
            {children}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
