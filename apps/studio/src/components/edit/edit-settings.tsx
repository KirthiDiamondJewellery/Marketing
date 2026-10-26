"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { setReviewCutsAction } from "@/server/actions/production";
import { Button } from "@/components/ui";
import { Switch } from "@/components/settings/switch";
import { useToast } from "@/components/shell/toast";

/** The one Edit setting, tucked in a small popover: check the cuts before your editor finishes a video. */
export function EditSettings({ reviewCuts }: { reviewCuts: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(reviewCuts);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setOn(reviewCuts), [reviewCuts]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <Button variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label="Edit settings">
        <Settings2 className="size-4" strokeWidth={1.75} /> Settings
      </Button>
      {open ? (
        <div role="dialog" aria-label="Edit settings" className="absolute right-0 top-full z-40 mt-2 w-[min(320px,calc(100vw-32px))] rounded-lg border border-border-strong bg-surface-3 p-4 shadow-[var(--shadow-3)] max-sm:left-0 max-sm:right-auto">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-small font-medium text-fg">Review cuts before editing</p>
              <p className="mt-0.5 text-caption text-fg-2">{on ? "You check each cut list here first, then your editor finishes the video." : "Off: your editor goes straight to the finished video."}</p>
            </div>
            <Switch
              checked={on}
              label="Review cuts before editing"
              onChange={async (next) => {
                setOn(next);
                const r = await setReviewCutsAction(next);
                toast(r.ok ? r.message ?? "Saved" : r.error, r.ok ? "ok" : "error");
                router.refresh();
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
