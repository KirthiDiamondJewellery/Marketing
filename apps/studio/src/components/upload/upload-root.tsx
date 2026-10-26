"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, Check, ChevronDown, Upload, X } from "lucide-react";
import { cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { UploadProvider, useUploads, type UploadItem } from "./upload-provider";

const EASE = [0.2, 0.8, 0.2, 1] as const;

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function pct(it: Pick<UploadItem, "sent" | "size">): number {
  return it.size ? Math.min(100, Math.round((it.sent / it.size) * 100)) : 0;
}

/** Upload state for the whole shell: the provider, the drop-anywhere overlay and the progress tray. */
export function UploadRoot({ children }: { children: ReactNode }) {
  return (
    <UploadProvider>
      {children}
      <GlobalDrop />
      <UploadTray />
    </UploadProvider>
  );
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/** Drag takes onto any Studio page. A page's own drop zone (data-dropzone) handles drops inside it. */
function GlobalDrop() {
  const { add } = useUploads();
  const toast = useToast();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      if ((e.target as HTMLElement | null)?.closest?.("[data-dropzone]")) return;
      const n = add(e.dataTransfer?.files ?? []);
      toast(n ? `Uploading ${n} ${n === 1 ? "take" : "takes"}. Each one is matched to its script.` : "Only video files can be uploaded (.mov, .mp4).", n ? "ok" : "error");
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, [add, toast]);
  return (
    <AnimatePresence>
      {over ? (
        <motion.div
          key="drop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="pointer-events-none fixed inset-0 z-[75] grid place-items-center bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] p-6"
        >
          <div className="flex w-full max-w-lg flex-col items-center gap-3 rounded-xl border-2 border-dashed border-brand px-8 py-14 text-center">
            <Upload className="size-7 text-brand-fg" strokeWidth={1.5} />
            <p className="text-h2 font-medium text-fg">Drop your takes</p>
            <p className="max-w-sm text-small text-fg-2">Drop as many as you like. Each one is matched to its script and goes straight into the edit.</p>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Bottom-right progress for uploads in flight (hidden on Film, which lists them inline). */
function UploadTray() {
  const { items, active, retry, clearDone, dismiss } = useUploads();
  const pathname = usePathname();
  const [open, setOpen] = useState(true);
  const visible = items.length > 0 && pathname !== "/edit";
  const total = items.reduce((n, x) => n + x.size, 0);
  const sent = items.reduce((n, x) => n + Math.min(x.sent, x.size), 0);
  const errors = items.filter((x) => x.status === "error").length;
  return (
    <AnimatePresence>
      {visible ? (
        <motion.aside
          key="tray"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.2, ease: EASE }}
          aria-label="Uploads"
          className="fixed bottom-24 right-4 z-[60] w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-lg border border-border-strong bg-surface-3 shadow-[var(--shadow-3)] md:bottom-6"
        >
          <div className="flex items-center gap-2 px-4 py-3">
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="text-small font-medium text-fg">
                {active ? `Uploading ${active} ${active === 1 ? "take" : "takes"}` : errors ? `${errors} upload${errors === 1 ? "" : "s"} stopped` : "Uploads done"}
              </span>
              {active ? <span className="text-small text-fg-3 tabular">{total ? Math.round((sent / total) * 100) : 0}%</span> : null}
              <ChevronDown className={cn("ml-auto size-4 text-fg-3 transition-transform", !open && "-rotate-90")} strokeWidth={1.75} />
            </button>
            {!active ? (
              <button type="button" onClick={clearDone} className="grid size-7 place-items-center rounded-sm text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Close">
                <X className="size-4" strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
          {active ? (
            <div className="h-0.5 bg-surface-2">
              <div className="h-full bg-brand transition-[width] duration-300" style={{ width: `${total ? (sent / total) * 100 : 0}%` }} />
            </div>
          ) : null}
          {open ? (
            <ul className="max-h-64 overflow-y-auto border-t border-border px-2 py-2">
              {items.map((it) => (
                <li key={it.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                  {it.status === "done" ? (
                    <Check className="size-4 shrink-0 text-success" strokeWidth={2} />
                  ) : it.status === "error" ? (
                    <CircleAlert className="size-4 shrink-0 text-danger" strokeWidth={1.75} />
                  ) : (
                    <span className="size-4 shrink-0 text-center font-mono text-[10px] leading-4 text-fg-3 tabular">{pct(it)}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-small text-fg" title={it.name}>
                    {it.name}
                  </span>
                  {it.status === "error" ? (
                    <button type="button" onClick={() => retry(it.id)} className="text-caption text-fg-2 underline underline-offset-4 hover:text-fg">
                      Retry
                    </button>
                  ) : it.status === "done" ? (
                    <button type="button" onClick={() => dismiss(it.id)} className="text-caption text-fg-3 hover:text-fg" aria-label={`Hide ${it.name}`}>
                      <X className="size-3.5" strokeWidth={1.75} />
                    </button>
                  ) : (
                    <span className="text-caption text-fg-3 tabular">{bytes(it.size)}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="border-t border-border px-4 py-2.5">
            <Link href="/edit" className="text-small text-fg-2 underline decoration-border-strong underline-offset-4 hover:text-fg">
              See which script each take matched
            </Link>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
