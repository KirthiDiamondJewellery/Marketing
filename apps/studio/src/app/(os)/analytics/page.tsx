import type { Metadata } from "next";
import Link from "next/link";
import { BestPost, HeadlineStrip, PlatformsLine, ViewsTrend } from "@/components/analytics/overview";
import { EmptyState } from "@/components/content/shared";
import { Segmented } from "@/components/insights/nav";
import { RANGE_OPTIONS } from "@/components/insights/units";
import { buttonClass } from "@/components/ui";
import { getMoreLinks, getOverview, parseDays } from "@/server/queries/analytics";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function AnalyticsOverviewPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days = parseDays(sp.days);
  const tz = workspace().config.workspace.timezone;
  const [a, more] = await Promise.all([getOverview(days), getMoreLinks()]);
  if (!a.hasPosts) {
    return (
      <EmptyState
        title="No posts to measure yet"
        body="Add your handles in setup and press Start. We read your recent posts and your competitors' and show the numbers here in a few minutes."
        action={
          <Link href="/setup" className={buttonClass("primary")}>
            Go to setup
          </Link>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h2 font-medium text-fg">Last {days} days</h2>
          <p className="text-small text-fg-2">
            {a.recent.length} post{a.recent.length === 1 ? "" : "s"}, compared with the {days} days before.
          </p>
        </div>
        <Segmented param="days" options={RANGE_OPTIONS} current={String(days)} label="Time range" />
      </div>
      <HeadlineStrip a={a} />
      <PlatformsLine a={a} />
      {a.best ? <BestPost a={a} tz={tz} /> : <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-small text-fg-2">No posts in the last {days} days. Try a longer range.</p>}
      <ViewsTrend a={a} tz={tz} />
      {more.length ? (
        <p className="text-caption text-fg-3">
          More:{" "}
          {more.map((m, i) => (
            <span key={m.href}>
              {i ? " · " : ""}
              <Link href={m.href} className="text-fg-2 underline-offset-4 hover:text-fg hover:underline">
                {m.label}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
