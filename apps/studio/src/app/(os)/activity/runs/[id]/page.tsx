import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getRunDetail } from "@/server/queries/activity";
import { workspace } from "@/server/workspace";
import { Badge } from "@/components/ui";
import { AgentMonogram } from "@/motion/AgentMonogram";
import { SectionTitle } from "@/components/shell/page-header";
import { jobLabel, usd, who } from "@/components/shell/format";
import { StatusLabel } from "@/components/agents/runs-list";
import { RunActions } from "@/components/stream/run-actions";

export const metadata: Metadata = { title: "Run" };
export const dynamic = "force-dynamic";

function span(a: string | null, b: string | null): string {
  if (!a) return "–";
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  if (ms < 1000) return "under a second";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  return `${Math.round(ms / 3_600_000)} h`;
}

function Json({ value }: { value: unknown }) {
  const text = value === null || value === undefined ? "null" : JSON.stringify(value, null, 2);
  return <pre className="max-h-[420px] overflow-auto rounded-md bg-surface-2 p-4 font-mono text-[12.5px] leading-5 text-fg-2">{text}</pre>;
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRunDetail(id);
  if (!run) notFound();
  const tz = workspace().config.workspace.timezone;
  const w = who(run.agent);
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: tz }) : "–");

  return (
    <div className="@container">
      <Link href="/activity" className="mb-6 inline-flex items-center gap-1.5 text-small text-fg-2 hover:text-fg">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Activity
      </Link>
      <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <AgentMonogram agent={{ monogram: w.monogram, name: w.name, state: run.status === "running" ? "working" : "idle" }} size={56} />
          <div>
            <div className="text-small text-fg-2">
              <Link href={`/agents/${run.agent}`} className="hover:text-fg">{w.name}</Link> · {run.trigger === "schedule" ? "on schedule" : run.createdBy.startsWith("user:") ? "started by you" : run.trigger}
            </div>
            <h1 className="mt-0.5 text-h1 font-medium tracking-[-0.01em] text-fg">{jobLabel(run.jobId)}</h1>
            <div className="mt-2 flex items-center gap-3">
              <StatusLabel status={run.status} />
              <span className="font-mono text-[12px] text-fg-3">{run.jobId}</span>
            </div>
          </div>
        </div>
        <RunActions runId={run.id} status={run.status} />
      </header>

      {run.summary || run.error ? (
        <p className={run.error ? "mb-10 max-w-[70ch] text-body text-danger" : "mb-10 max-w-[70ch] text-body text-fg"}>{run.error ?? run.summary}</p>
      ) : null}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border @2xl:grid-cols-5">
        {[
          { label: "Started", value: time(run.startedAt ?? run.createdAt) },
          { label: "Took", value: span(run.startedAt, run.finishedAt) },
          { label: "AI spend", value: usd(run.costUsd, { precise: true }) },
          { label: "Turns", value: String(run.turns) },
          { label: "Attempts", value: `${run.attempts} of ${run.maxAttempts}` },
        ].map((s) => (
          <div key={s.label} className="bg-surface-1 px-5 py-4">
            <dt className="text-small text-fg-2">{s.label}</dt>
            <dd className="mt-1 text-[15px] font-medium text-fg tabular">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-12 grid grid-cols-1 gap-12 @5xl:grid-cols-12 @5xl:gap-8">
        <section aria-labelledby="timeline" className="@5xl:col-span-7">
          <SectionTitle id="timeline" count={run.events.length}>Timeline</SectionTitle>
          {run.events.length ? (
            <ol className="rounded-lg bg-surface-2 p-4 font-mono text-log">
              {run.events.map((e) => (
                <li key={e.id} className="grid grid-cols-[84px_76px_minmax(0,1fr)] gap-3 py-1 max-sm:grid-cols-[72px_minmax(0,1fr)]">
                  <span className="text-fg-3 tabular">{new Date(e.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: tz })}</span>
                  <span className={e.kind === "error" ? "text-danger max-sm:hidden" : e.kind === "approval" ? "text-on-tint max-sm:hidden" : "text-fg-3 max-sm:hidden"}>{e.kind}</span>
                  <span className="break-words text-fg">{e.message}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-small text-fg-2">No steps recorded for this run.</p>
          )}
          {run.approvals.length ? (
            <div className="mt-8">
              <SectionTitle>Asked you</SectionTitle>
              <ul className="flex flex-col gap-2">
                {run.approvals.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 rounded-md border border-border px-4 py-3 text-small">
                    <Badge tone={a.status === "pending" ? "brand" : a.status === "approved" ? "success" : a.status === "rejected" ? "danger" : "info"}>{a.status === "pending" ? "Waiting" : a.status}</Badge>
                    <Link href={a.status === "pending" ? `/approvals#${a.ref}` : "/approvals?view=decided"} className="min-w-0 flex-1 truncate text-fg hover:underline">{a.summary}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        <section aria-labelledby="output" className="flex flex-col gap-8 @5xl:col-span-5">
          <div>
            <SectionTitle id="output">Output</SectionTitle>
            <Json value={run.output} />
          </div>
          <div>
            <SectionTitle>Input</SectionTitle>
            <Json value={run.input} />
          </div>
          {run.ledger.length ? (
            <div>
              <SectionTitle>Spend</SectionTitle>
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border text-small">
                {run.ledger.map((l, i) => (
                  <li key={i} className="flex justify-between px-4 py-2.5">
                    <span className="text-fg-2">{l.category} · {l.provider}</span>
                    <span className="text-fg tabular">{usd(l.usd, { precise: true })}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
