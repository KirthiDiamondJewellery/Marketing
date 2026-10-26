"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Circle, Film, X } from "lucide-react";
import { Badge, Button, Textarea, cn, type BadgeTone } from "@/components/ui";
import type { EditJobView } from "@/server/queries/content";
import { addRevisionNote } from "@/server/actions/content";
import { toast } from "./toast";
import { fmtDuration, fmtRelative, humanize } from "./format";

const STEPS = [
  { key: "prep", label: "Prep", statuses: ["queued", "prepping"] },
  { key: "plan", label: "Plan", statuses: ["planning"] },
  { key: "render", label: "Render", statuses: ["rendering"] },
  { key: "qc", label: "QC", statuses: ["qc"] },
  { key: "review", label: "Review", statuses: ["review"] },
] as const;

const EDIT_STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  prepping: { tone: "info", label: "Prepping" },
  planning: { tone: "info", label: "Planning" },
  rendering: { tone: "info", label: "Rendering" },
  qc: { tone: "info", label: "Checking" },
  review: { tone: "brand", label: "Ready for review" },
  approved: { tone: "success", label: "Approved" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function EditPanel({ job, poster }: { job: EditJobView; poster: string | null }) {
  const st = EDIT_STATUS[job.status] ?? { tone: "neutral" as BadgeTone, label: humanize(job.status) };
  const renders = [...job.renders].sort((a, b) => b.version - a.version);
  const [shown, setShown] = useState(renders.find((r) => r.assetId === job.outputAssetId)?.assetId ?? renders[0]?.assetId ?? null);
  const current = renders.find((r) => r.assetId === shown) ?? null;
  const active = job.status === "approved" ? STEPS.length : Math.max(0, STEPS.findIndex((s) => (s.statuses as readonly string[]).includes(job.status)));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-h3 font-medium tabular text-fg">
          {job.ref} <span className="text-fg-2">v{job.version}</span>
        </span>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-small text-fg-3">
          {humanize(job.format ?? "edit")} · {job.engine === "motion" ? "motion engine" : "cut engine"} · updated {fmtRelative(job.updatedAt)}
          {job.costUsd ? ` · $${job.costUsd.toFixed(2)} spent` : ""}
        </span>
      </div>

      <ol className="grid grid-cols-5 gap-2" aria-label="Edit progress">
        {STEPS.map((s, i) => {
          const done = i < active;
          const now = i === active && job.status !== "approved";
          const failed = now && job.status === "failed";
          return (
            <li key={s.key} className="flex flex-col gap-2">
              <span className={cn("h-[2px] rounded-full", done ? "bg-fg-2" : now ? (failed ? "bg-danger" : "bg-brand") : "bg-border")} />
              <span className={cn("flex items-center gap-1.5 text-caption", done ? "text-fg-2" : now ? "text-fg" : "text-fg-3")}>
                {done ? <Check className="size-3.5" strokeWidth={2} /> : now ? <span className={cn("size-1.5 rounded-full", failed ? "bg-danger" : "signal-pulse bg-brand")} /> : <Circle className="size-3" strokeWidth={1.5} />}
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-8 md:grid-cols-[minmax(220px,280px)_1fr]">
        <div className="flex flex-col gap-3">
          <div className="relative mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-lg border border-border bg-surface-2">
            {current ? (
              <video key={current.assetId} src={`/api/media/${current.assetId}`} poster={poster ?? undefined} controls playsInline preload="metadata" className="size-full bg-black object-contain" />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Film className="size-5 text-fg-3" strokeWidth={1.5} />
                <p className="text-small text-fg-2">{job.status === "failed" ? "The render didn’t finish." : "The render shows up here when it’s ready."}</p>
                {job.sourceAsset ? <p className="text-caption text-fg-3">From {job.sourceAsset.uri.split("/").pop()}{job.sourceAsset.durationS ? `, ${fmtDuration(job.sourceAsset.durationS)}` : ""}</p> : null}
              </div>
            )}
          </div>
          {renders.length > 1 ? (
            <div className="mx-auto flex rounded-md border border-border p-0.5" role="tablist" aria-label="Render versions">
              {renders.map((r) => (
                <button
                  key={r.assetId}
                  type="button"
                  role="tab"
                  aria-selected={r.assetId === shown}
                  onClick={() => setShown(r.assetId)}
                  className={cn("rounded-[8px] px-3 py-1 text-[13px] tabular", r.assetId === shown ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg")}
                >
                  v{r.version}
                  {r.durationS ? <span className="ml-1.5 text-fg-3">{fmtDuration(r.durationS)}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-8">
          {job.pendingApproval ? (
            <div className="signal-left rounded-md rounded-l-none border border-border bg-surface-1 px-4 py-3 text-small">
              <span className="text-fg">Waiting for your sign-off</span>
              <span className="text-fg-2"> · {job.pendingApproval.ref}: {job.pendingApproval.summary}</span>
            </div>
          ) : null}
          <QcBlock job={job} />
          <Notes job={job} />
        </div>
      </div>
    </div>
  );
}

function QcBlock({ job }: { job: EditJobView }) {
  const qc = job.qc;
  if (!qc) {
    return (
      <section>
        <h3 className="mb-2 text-h3 font-medium text-fg">Quality check</h3>
        <p className="text-small text-fg-2">QC runs right after the render: loudness, pauses, black frames, caption safe zone and the export format.</p>
      </section>
    );
  }
  const issues = qc.checks.filter((c) => c.status === "fail" || c.status === "warn");
  const passed = qc.checks.filter((c) => c.status === "pass");
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-2 text-h3 font-medium text-fg">
        Quality check
        <Badge tone={qc.passed ? "success" : "danger"}>{qc.passed ? "Passed" : `${issues.length} to fix`}</Badge>
      </h3>
      {job.cutSummary ? (
        <p className="mb-4 text-small text-fg-3">
          {job.cutSummary.dropped} cut{job.cutSummary.dropped === 1 ? "" : "s"} from the take{job.cutSummary.outputS ? `, ${fmtDuration(job.cutSummary.outputS)} of keepers` : ""}
        </p>
      ) : (
        <div className="mb-4" />
      )}
      <ul className="flex flex-col gap-2.5">
        {[...issues, ...passed].map((c) => (
          <li key={c.id} className="flex items-start gap-2.5 text-small">
            {c.status === "pass" ? (
              <Check className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={2} />
            ) : c.status === "warn" ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.75} />
            ) : (
              <X className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={2} />
            )}
            <span className="min-w-0">
              <span className={c.status === "pass" ? "text-fg-2" : "text-fg"}>{c.label}</span>
              <span className="tabular text-fg-3"> · {c.detail}</span>
              {c.fix && c.status !== "pass" ? <span className="mt-0.5 block text-caption text-fg-2">Fix: {c.fix}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Notes({ job }: { job: EditJobView }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const canRevise = Boolean(job.outputAssetId) || ["review", "approved"].includes(job.status);
  return (
    <section>
      <h3 className="mb-3 text-h3 font-medium text-fg">Revision notes</h3>
      {job.notes.length ? (
        <ol className="mb-5 flex flex-col gap-3">
          {job.notes.map((n, i) => (
            <li key={i} className="flex gap-3 text-small">
              <span className="mt-0.5 shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 text-caption tabular text-fg-2">v{n.version}</span>
              <span className="min-w-0">
                <span className="text-fg">{n.text}</span>
                <span className="block text-caption text-fg-3">
                  {n.by.startsWith("user:") ? "You" : humanize(n.by.replace(/^agent:/, ""))}
                  {n.channel ? ` via ${n.channel === "studio" ? "Studio" : humanize(n.channel)}` : ""} · {n.at ? fmtRelative(n.at) : ""}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mb-4 text-small text-fg-2">No notes yet. Say what to change in plain words; the Art Director re-renders only what changed.</p>
      )}
      {canRevise ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const res = await addRevisionNote(job.ref, text);
              if (res.ok) {
                setText("");
                toast(res.message, { by: "Art Director" });
                router.refresh();
              } else setError(res.message);
            });
          }}
        >
          <label htmlFor={`note-${job.ref}`} className="sr-only">
            Revision note for {job.ref}
          </label>
          <Textarea
            id={`note-${job.ref}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Tighten the hook and hold the bench reveal a beat longer"
            rows={3}
            aria-invalid={error ? true : undefined}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") e.currentTarget.form?.requestSubmit();
            }}
          />
          {error ? (
            <p className="text-caption text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-fg-3">
              Becomes {job.ref} v{job.version + 1}
            </span>
            <Button type="submit" variant="secondary" size="sm" disabled={pending || text.trim().length < 3}>
              {pending ? "Sending…" : "Add note"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
