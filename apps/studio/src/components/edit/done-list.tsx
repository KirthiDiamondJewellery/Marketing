"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarClock, ChevronDown, CircleAlert, Download, Film, Inbox, LoaderCircle } from "lucide-react";
import type { DoneVideo } from "@/server/queries/edit";
import { markDownloadedAction } from "@/server/actions/edit";
import { scheduleReadyAction } from "@/server/actions/approvals";
import { Button, buttonClass, cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { MakeTrialButton } from "@/components/trial-reels/trial-reels";

function href(d: DoneVideo): string | null {
  if (!d.assetId) return null;
  const name = d.title.replace(/[^\w .-]+/g, "").trim().slice(0, 80) || "video";
  return `/api/media/${d.assetId}?download=1&name=${encodeURIComponent(name)}`;
}

function Outcome({ d }: { d: DoneVideo }) {
  const icon =
    d.releaseStatus === "scheduled" || d.releaseStatus === "partial" ? (
      <CalendarClock className="size-3.5 shrink-0 text-success" strokeWidth={1.75} />
    ) : d.releaseStatus === "failed" ? (
      <CircleAlert className="size-3.5 shrink-0 text-danger" strokeWidth={1.75} />
    ) : d.releaseStatus === "approved" || d.releaseStatus === "scheduling" ? (
      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-fg-3 motion-reduce:animate-none" strokeWidth={1.75} />
    ) : (
      <Inbox className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.75} />
    );
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-small text-fg-2">
      {icon}
      <span className="min-w-0 truncate" suppressHydrationWarning>
        {d.outcome}
        {d.downloaded ? " · Downloaded" : ""}
      </span>
    </p>
  );
}

/** Step 4: the last few approved videos, where they went, their download link and trial reels. Collapsed by default. */
export function DoneList({ items, trialReels = false }: { items: DoneVideo[]; trialReels?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!items.length) return null;

  const retry = async (d: DoneVideo) => {
    if (!d.releaseId) return;
    setBusy(d.editId);
    const r = await scheduleReadyAction(d.releaseId, { at: null });
    setBusy(null);
    toast(r.ok ? r.message ?? "Scheduling it." : r.error, r.ok ? "ok" : "error");
    router.refresh();
  };

  return (
    <section aria-labelledby="edit-done">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="edit-done-list" className="flex w-full items-center gap-2 text-left">
        <h2 id="edit-done" className="text-h3 font-medium text-fg">
          Recently done <span className="ml-1 text-fg-3 tabular">{items.length}</span>
        </h2>
        <ChevronDown className={cn("size-4 text-fg-3 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} strokeWidth={1.75} />
      </button>
      {open ? (
        <ul id="edit-done-list" className="mt-3 flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
          {items.map((d) => {
            const link = href(d);
            return (
              <li key={d.editId} className="flex items-center gap-3 px-3 py-3" data-done={d.releaseStatus ?? "approved"}>
                <div className="relative h-[52px] w-[30px] shrink-0 overflow-hidden rounded-[6px] border border-border bg-surface-2">
                  {d.coverId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/media/${d.coverId}`} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Film className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-fg-3" strokeWidth={1.5} aria-hidden />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-small font-medium text-fg">{d.title}</p>
                  <Outcome d={d} />
                </div>
                <div className="flex shrink-0 items-center gap-1 max-sm:flex-col max-sm:items-end">
                  {d.releaseStatus === "failed" && d.releaseId ? (
                    <Button size="sm" variant="secondary" disabled={busy === d.editId} onClick={() => retry(d)}>
                      Try again
                    </Button>
                  ) : d.releaseStatus === "ready" ? (
                    <Link href="/calendar" className={buttonClass("ghost", "sm")}>
                      Schedule
                    </Link>
                  ) : null}
                  {trialReels ? <MakeTrialButton start={{ kind: "edit", editRef: d.ref, name: d.title }} /> : null}
                  {link ? (
                    <a href={link} onClick={() => void markDownloadedAction(d.editId)} className={buttonClass("ghost", "sm")} aria-label={`Download ${d.title}`}>
                      <Download className="size-3.5" strokeWidth={1.75} /> Download
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
