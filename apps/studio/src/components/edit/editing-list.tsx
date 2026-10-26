"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CircleAlert, Film, RotateCcw, Square } from "lucide-react";
import type { EditingRow } from "@/server/queries/edit";
import { cancelEditAction, retryEditAction } from "@/server/actions/production";
import { Button, cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";

const STEPS = ["Up next", "Cutting", "Adding captions", "Final checks"] as const;

function left(s: number | null): string | null {
  if (s === null || !Number.isFinite(s)) return null;
  if (s < 60) return "under a minute left";
  return `about ${Math.round(s / 60)} min left`;
}

function Steps({ row }: { row: EditingRow }) {
  const reduced = useReducedMotion();
  return (
    <div className="flex w-full max-w-[220px] gap-1" aria-hidden>
      {STEPS.map((s, i) => (
        <span
          key={s}
          className={cn(
            "h-[3px] flex-1 overflow-hidden rounded-full",
            i < row.step ? "bg-fg-3" : i === row.step ? (row.state === "failed" ? "bg-danger" : "relative bg-surface-3") : "bg-surface-3",
          )}
        >
          {i === row.step && row.state === "working" ? (
            reduced ? (
              <span className="block h-full w-full bg-brand" />
            ) : (
              <motion.span className="block h-full w-1/2 bg-brand" animate={{ x: ["-100%", "200%"] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }} />
            )
          ) : null}
          {i === row.step && row.state === "waiting" ? <span className="block h-full w-1/4 bg-fg-3" /> : null}
        </span>
      ))}
    </div>
  );
}

function Row({ row }: { row: EditingRow }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, ok: string) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    toast(r.ok ? ok : r.error ?? "That didn't work.", r.ok ? "ok" : "error");
    router.refresh();
  };
  const time = row.state === "failed" ? null : left(row.etaS);
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 py-3" data-edit-row={row.state}>
      <div className="relative h-[52px] w-[30px] shrink-0 overflow-hidden rounded-[6px] border border-border bg-surface-2">
        {row.coverId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/media/${row.coverId}`} alt="" className="h-full w-full object-cover" />
        ) : (
          <Film className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-fg-3" strokeWidth={1.5} aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-small font-medium text-fg">{row.title}</p>
        <p className="mt-0.5 text-small">
          <span className={cn("font-medium", row.state === "failed" ? "text-danger" : "text-fg-2")}>{row.stage}</span>
          {row.detail ? <span className="text-fg-3"> · {row.detail}</span> : null}
          {time ? <span className="text-fg-3"> · {time}</span> : null}
        </p>
        <div className="mt-2">
          <Steps row={row} />
        </div>
        {row.error ? (
          <p className="mt-2 flex items-start gap-1.5 text-caption text-fg-2">
            <CircleAlert className="mt-px size-3.5 shrink-0 text-danger" strokeWidth={1.75} />
            <span className="min-w-0 break-words">{row.error}</span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 max-sm:flex-col max-sm:items-end">
        {row.state === "failed" ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => retryEditAction(row.ref), "Trying again.")}>
            <RotateCcw className="size-3.5" strokeWidth={1.75} /> Retry
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => cancelEditAction(row.ref), "Stopped.")} aria-label={`Stop editing ${row.title}`}>
          <Square className="size-3" strokeWidth={2} /> Stop
        </Button>
      </div>
    </li>
  );
}

/** Step 2: videos your editor is working on, with a plain stage and time left. */
export function EditingList({ rows, workerStale }: { rows: EditingRow[]; workerStale: boolean }) {
  if (!rows.length) return null;
  return (
    <section aria-labelledby="edit-editing">
      <h2 id="edit-editing" className="mb-3 text-h3 font-medium text-fg">
        Being edited <span className="ml-1 text-fg-3 tabular">{rows.length}</span>
      </h2>
      {workerStale && rows.some((r) => r.state !== "failed") ? (
        <p className="mb-3 flex items-start gap-2 rounded-md border border-border bg-surface-2 px-4 py-3 text-small text-fg">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.75} />
          <span>
            Your editor isn&apos;t running, so these are waiting. Start it in Terminal with <code className="font-mono text-[12px]">cd ~/AttentionOS && ./aos start</code>.
          </span>
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <Row key={r.editId} row={r} />
        ))}
      </ul>
    </section>
  );
}
