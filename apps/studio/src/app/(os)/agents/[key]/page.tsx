import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getAgentProfile } from "@/server/queries/agents";
import { workspace } from "@/server/workspace";
import { SectionTitle } from "@/components/shell/page-header";
import { usd } from "@/components/shell/format";
import { AGENT_INFO, isAgentKey } from "@/components/agents/meta";
import { AgentHero } from "@/components/agents/agent-hero";
import { AutonomyControl, ModelField, PauseButton, RunNow } from "@/components/agents/agent-controls";
import { AgentActivity } from "@/components/agents/agent-activity";
import { RunsList } from "@/components/agents/runs-list";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  return { title: isAgentKey(key) ? AGENT_INFO[key].name : "Agent" };
}

export default async function AgentPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!isAgentKey(key)) notFound();
  const info = AGENT_INFO[key];
  const ws = workspace();
  const profile = await getAgentProfile(key);
  const { stats } = profile;
  const finished = stats.succeeded7d + stats.failed7d;
  const rate = finished ? Math.round((stats.succeeded7d / finished) * 100) : null;

  return (
    <div className="@container">
      <Link href="/agents" className="mb-6 inline-flex items-center gap-1.5 text-small text-fg-2 hover:text-fg">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Team
      </Link>

      <AgentHero agent={key} actions={<PauseButton agent={key} enabled={profile.enabled} />} />

      <dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border @2xl:grid-cols-4">
        {[
          { label: "Tasks this week", value: String(stats.runs7d) },
          { label: "Finished cleanly", value: rate === null ? "–" : `${rate}%` },
          { label: "AI spend this week", value: usd(stats.costUsd7d, { precise: true }) },
          { label: "Pending your approval", value: String(profile.runs.filter((r) => r.status === "waiting_approval").length) },
        ].map((s) => (
          <div key={s.label} className="bg-surface-1 px-5 py-4">
            <dt className="text-small text-fg-2">{s.label}</dt>
            <dd className="mt-1 text-h2 font-medium text-fg tabular">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-12 grid grid-cols-1 gap-12 @5xl:grid-cols-12 @5xl:gap-8">
        <div className="flex flex-col gap-12 @5xl:col-span-7">
          <section aria-labelledby="autonomy">
            <SectionTitle id="autonomy">How much it can do on its own</SectionTitle>
            <AutonomyControl agent={key} value={profile.autonomy} />
          </section>
          <section aria-labelledby="run-now">
            <SectionTitle id="run-now">Run now</SectionTitle>
            <RunNow agent={key} />
          </section>
          <section aria-labelledby="recent">
            <SectionTitle id="recent" action={<Link href={`/activity?agent=${key}`} className="text-small text-fg-2 hover:text-fg">Full log</Link>}>
              Recent work
            </SectionTitle>
            <RunsList runs={profile.runs.slice(0, 10)} empty={`${info.name} hasn't run yet. Use Run now, or wait for its next scheduled task.`} />
          </section>
        </div>
        <div className="flex flex-col gap-12 @5xl:col-span-5">
          <section aria-labelledby="what">
            <SectionTitle id="what">What it does</SectionTitle>
            <p className="text-body text-fg-2">{info.about}</p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {info.owns.map((o) => (
                <li key={o} className="inline-flex h-7 items-center rounded-sm bg-surface-2 px-2.5 text-small text-fg-2">
                  {o}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="live">
            <SectionTitle id="live">Live activity</SectionTitle>
            <AgentActivity agent={key} initial={profile.events} tz={ws.config.workspace.timezone} />
          </section>
          <section aria-labelledby="settings">
            <SectionTitle id="settings">Settings</SectionTitle>
            <ModelField agent={key} value={profile.model} fallback={profile.defaultModel} />
          </section>
        </div>
      </div>
    </div>
  );
}
