import type { Metadata } from "next";
import Link from "next/link";
import { EVENT_KINDS, getActivity, getRecentRuns } from "@/server/queries/activity";
import { workspace } from "@/server/workspace";
import { cn } from "@/components/ui";
import { PageHeader, SectionTitle } from "@/components/shell/page-header";
import { AGENT_INFO, AGENT_ORDER } from "@/components/agents/meta";
import { RunsList } from "@/components/agents/runs-list";
import { EventLog } from "@/components/stream/event-log";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

const KIND_FILTERS: Record<string, string> = { progress: "Steps", handoff: "Handoffs", approval: "Approvals", error: "Problems", cost: "Spend" };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ agent?: string; kind?: string; before?: string }> }) {
  const sp = await searchParams;
  const agent = sp.agent && (sp.agent === "you" || sp.agent in AGENT_INFO) ? sp.agent : undefined;
  const kind = sp.kind && (EVENT_KINDS as readonly string[]).includes(sp.kind) ? sp.kind : undefined;
  const before = sp.before ? Number(sp.before) || undefined : undefined;
  const ws = workspace();
  const [{ events, hasMore }, runs] = await Promise.all([getActivity({ agent, kind, before }), getRecentRuns({ agent, limit: 12 })]);

  const href = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const next = { agent, kind, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/activity?${s}` : "/activity";
  };
  const chip = (label: string, link: string, active: boolean) => (
    <Link key={link + label} href={link} aria-current={active ? "true" : undefined} className={cn("inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-small transition-colors", active ? "border-border-strong bg-surface-2 text-fg" : "border-border text-fg-2 hover:text-fg")}>
      {label}
    </Link>
  );

  return (
    <div className="@container">
      <PageHeader title="Activity" description="Everything your team did, step by step. Open any run to see its timeline, cost and raw output." />

      <div className="mb-8 flex flex-col gap-3">
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" aria-label="Filter by agent">
          {chip("Everyone", href({ agent: undefined, before: undefined }), !agent)}
          {AGENT_ORDER.map((k) => chip(AGENT_INFO[k].name, href({ agent: k, before: undefined }), agent === k))}
          {chip("You", href({ agent: "you", before: undefined }), agent === "you")}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" aria-label="Filter by kind">
          {chip("All kinds", href({ kind: undefined, before: undefined }), !kind)}
          {Object.entries(KIND_FILTERS).map(([k, l]) => chip(l, href({ kind: k, before: undefined }), kind === k))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-12 @5xl:grid-cols-12 @5xl:gap-8">
        <section aria-label="Event log" className="@5xl:col-span-7">
          {events.length ? (
            <EventLog events={events} tz={ws.config.workspace.timezone} />
          ) : (
            <p className="rounded-lg border border-border px-6 py-12 text-center text-small text-fg-2">Nothing matches these filters yet.</p>
          )}
          {hasMore ? (
            <Link href={href({ before: String(events.at(-1)!.id) })} className="mt-6 inline-flex h-9 items-center rounded-md border border-border-strong px-4 text-[14px] text-fg hover:bg-surface-2">
              Show older
            </Link>
          ) : null}
        </section>
        <section aria-labelledby="runs" className="@5xl:col-span-5">
          <SectionTitle id="runs">Recent runs</SectionTitle>
          <RunsList runs={runs} showAgent empty="No runs yet." />
        </section>
      </div>
    </div>
  );
}
