// Unfinished feature: the edit queue (every video in the pipeline with its editing progress and next action). Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, CircleAlert, Film, RotateCcw, Square } from "lucide-react";
import type { EditQueue, EditRowView } from "@/server/queries/edits";
import { cancelEditAction, retryEditAction, retryScheduleAction, setReviewCutsAction } from "@/server/actions/production";
import { Button, buttonClass, cn } from "@/components/ui";
import { Switch } from "@/components/settings/switch";
import { useToast } from "@/components/shell/toast";
import { AutoRefresh } from "@/components/production/auto-refresh";

const STAGES = ["Uploaded", "Prepping", "Planning", "Rendering", "Checking", "Ready for you"] as const;

function eta(s: number | null): string | null {
  if (s === null || !Number.isFinite(s)) return null;
  if (s < 60) return "less than a minute left";
  const m = Math.round(s / 60);
  return `about ${m} min left`;
}

function Stepper({ row }: { row: EditRowView }) {
  const at = Math.min(row.stage, 6);
  return (
    <ol className="flex w-full items-start gap-1" aria-label={`Step ${Math.min(at + 1, 6)} of 6: ${row.label}`}>
      {STAGES.map((s, i) => {
        const done = i < at || at === 6;
        const current = i === at && at < 6;
        const failed = current && row.state === "failed";
        return (
          <li key={s} className="flex min-w-0 flex-1 flex-col gap-1.5" aria-current={current ? "step" : undefined}>
            <span className={cn("relative h-[3px] overflow-hidden rounded-full", at === 6 && row.state === "done" ? "bg-success" : done ? "bg-fg-3" : "bg-surface-3")}>
              {current ? (
                failed ? (
                  <span className="absolute inset-0 bg-danger" />
                ) : row.state === "needs_you" ? (
                  <span className="absolute inset-0 bg-brand" />
                ) : row.state === "working" ? (
                  <motion.span
                    className="absolute inset-y-0 left-0 w-1/2 bg-brand"
                    animate={{ x: ["-100%", "200%"] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                  />
                ) : (
                  <span className="absolute inset-y-0 left-0 w-1/4 bg-fg-3" />
                )
              ) : null}
            </span>
            <span className={cn("hidden truncate text-[11px] @3xl:block", current ? (failed ? "text-danger" : "text-fg") : done ? "text-fg-2" : "text-fg-3")}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Cover({ row }: { row: EditRowView }) {
  return (
    <div className="relative h-[85px] w-[48px] shrink-0 overflow-hidden rounded-[8px] border border-border bg-surface-2">
      {row.coverId ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/media/${row.coverId}`} alt="" className="h-full w-full object-cover" />
      ) : (
        <Film className="absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-fg-3" strokeWidth={1.5} />
      )}
      {row.state === "working" ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-brand" /> : null}
    </div>
  );
}

function Row({ row, tz }: { row: EditRowView; tz: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    toast(r.ok ? r.message ?? "Done" : r.error ?? "That didn't work.", r.ok ? "ok" : "error");
    router.refresh();
  };
  const canStop = ["waiting", "working", "failed", "needs_you"].includes(row.state) && row.status !== "approved";
  const due = row.filmBy ? new Date(row.filmBy).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz }) : null;
  const left = row.state === "working" || row.state === "waiting" ? eta(row.etaS) : null;

  return (
    <li className={cn("relative rounded-lg border bg-surface-1 p-4", row.state === "needs_you" ? "border-border-strong" : "border-border")} data-edit={row.ref} data-state={row.state}>
      {row.state === "needs_you" ? <span aria-hidden className="absolute bottom-4 left-[-1px] top-4 w-[2px] bg-brand" /> : null}
      <div className="flex gap-4">
        <Cover row={row} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="min-w-0 truncate text-[16px] font-medium leading-6 text-fg">{row.title}</h3>
            <span className="font-mono text-[11px] text-fg-3">
              {row.ref}
              {row.version > 1 ? ` v${row.version}` : ""}
            </span>
            {due ? <span className="text-caption text-fg-3">· film-by {due}</span> : null}
          </div>
          <div className="mt-3">
            <Stepper row={row} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 text-small max-sm:basis-full">
              <span className={cn("font-medium", row.state === "failed" ? "text-danger" : row.state === "needs_you" ? "text-on-tint" : "text-fg")}>{row.label}</span>
              {row.state === "working" && row.progress ? <span className="text-fg-2"> · {row.progress}</span> : row.detail ? <span className="text-fg-2"> · {row.detail}</span> : null}
              {left ? <span className="text-fg-3"> · {left}</span> : null}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {row.state === "needs_you" && row.approvalRef ? (
                <Link href={`/approvals#${row.approvalRef}`} className={buttonClass("secondary", "sm")}>
                  Review <ArrowRight className="size-3.5" strokeWidth={2} />
                </Link>
              ) : null}
              {row.status === "approved" && (row.release?.status === "failed" || row.release?.status === "partial") ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => retryScheduleAction(row.ref))}>
                  <RotateCcw className="size-3.5" strokeWidth={1.75} /> Schedule again
                </Button>
              ) : row.state === "failed" ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => retryEditAction(row.ref))}>
                  <RotateCcw className="size-3.5" strokeWidth={1.75} /> Retry
                </Button>
              ) : null}
              {canStop ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => cancelEditAction(row.ref))} aria-label={`Stop ${row.ref}`}>
                  <Square className="size-3" strokeWidth={2} /> Stop
                </Button>
              ) : null}
            </div>
          </div>
          {row.error && (row.state === "failed" || row.status === "approved") ? (
            <p className="mt-2 flex items-start gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-small text-fg">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" strokeWidth={1.75} />
              <span className="min-w-0 break-words">{row.error}</span>
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** The edit queue: every video in the pipeline, in film-by order, with progress from the agents and what to do. */
export function EditQueueView({ queue }: { queue: EditQueue }) {
  const router = useRouter();
  const toast = useToast();
  const [reviewCuts, setReviewCuts] = useState(queue.reviewCuts);
  const inFlight = queue.rows.some((r) => r.state === "working" || r.state === "waiting" || (r.status === "approved" && !r.release));
  const groups: { key: string; title: string; rows: EditRowView[] }[] = [
    { key: "attention", title: "Needs you", rows: queue.rows.filter((r) => r.state === "needs_you" || r.state === "failed") },
    { key: "progress", title: "In the edit", rows: queue.rows.filter((r) => r.state === "working" || r.state === "waiting") },
    { key: "done", title: "Done", rows: queue.rows.filter((r) => r.state === "done" || r.state === "stopped") },
  ].filter((g) => g.rows.length);
  const workerStale = !queue.workerSeen || Date.now() - Date.parse(queue.workerSeen) > 2 * 60_000;

  return (
    <>
      <AutoRefresh active={inFlight} />
      <div className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium text-fg">Review cuts before editing</p>
          <p className="text-caption text-fg-2">{reviewCuts ? "You approve each cut list, then the Art Director plans the edit." : "Off: cuts are approved for you and you only review the finished video."}</p>
        </div>
        <Switch
          checked={reviewCuts}
          label="Review cuts before editing"
          onChange={async (next) => {
            setReviewCuts(next);
            const r = await setReviewCutsAction(next);
            toast(r.ok ? r.message ?? "Saved" : r.error, r.ok ? "ok" : "error");
            router.refresh();
          }}
        />
      </div>
      {inFlight && workerStale ? (
        <p className="mb-6 flex items-start gap-2 rounded-md border border-border bg-surface-2 px-4 py-3 text-small text-fg">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.75} />
          The editor isn't running, so these are waiting. Start it with <code className="font-mono text-[12px]">./aos restart</code>.
        </p>
      ) : null}
      {groups.length ? (
        <div className="flex flex-col gap-10">
          {groups.map((g) => (
            <section key={g.key} aria-labelledby={`edits-${g.key}`}>
              <h2 id={`edits-${g.key}`} className="mb-3 text-h3 font-medium text-fg">
                {g.title} <span className="ml-1 text-fg-3 tabular">{g.rows.length}</span>
              </h2>
              <ol className="flex flex-col gap-2">
                {g.rows.map((r) => (
                  <Row key={r.id} row={r} tz={queue.tz} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border-strong px-6 py-14 text-center">
          <p className="text-h3 font-medium text-fg">Nothing in the edit</p>
          <p className="mx-auto mt-1 max-w-sm text-small text-fg-2">Upload a take on Film and it shows up here: prepped, planned, rendered and checked, then sent to you.</p>
          <Link href="/film" className={buttonClass("secondary", "md", "mt-4")}>
            Go to Film
          </Link>
        </div>
      )}
    </>
  );
}
