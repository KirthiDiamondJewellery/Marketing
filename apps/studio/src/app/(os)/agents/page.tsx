import type { Metadata } from "next";
import { getRosterExtras, getWallFeed } from "@/server/queries/agents";
import { SectionTitle } from "@/components/shell/page-header";
import { Roster } from "@/components/agents/roster";
import { AgentsBoard, type AgentsViewId } from "@/components/agents/agents-board";

export const metadata: Metadata = { title: "Agents" };
export const dynamic = "force-dynamic";

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const view: AgentsViewId = sp.view === "command" ? "command" : "worker";
  const [extras, feed] = await Promise.all([getRosterExtras(), getWallFeed().catch(() => ({ cards: [], handle: null, totalViews: 0, totalPosts: 0, rivals: [], rivalCreators: 0 }))]);
  return (
    <div className="@container">
      <AgentsBoard view={view} feed={feed} hold={sp.hold === "1"} />
      <section id="team" className="mt-12 scroll-mt-6" aria-labelledby="team-title">
        <SectionTitle id="team-title">Your team</SectionTitle>
        <p className="-mt-2 mb-5 max-w-[60ch] text-small text-fg-2">Open an agent to see its recent work and decide how much it can do on its own.</p>
        <Roster extras={extras} />
      </section>
    </div>
  );
}
