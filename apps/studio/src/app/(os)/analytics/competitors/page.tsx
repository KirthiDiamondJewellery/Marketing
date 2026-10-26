import type { Metadata } from "next";
import { OutlierCard } from "@/components/analytics/outlier-card";
import { fmtCompact, fmtRelative, fmtX, handle, platformLabel } from "@/components/content/format";
import { EmptyState, PlatformIcon } from "@/components/content/shared";
import { Panel } from "@/components/insights/kit";
import { Segmented } from "@/components/insights/nav";
import { AddCreatorForm, RemoveCreator } from "@/components/research/controls";
import { getCompetitorsView, parseDays } from "@/server/queries/analytics";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Competitors · Analytics" };
export const dynamic = "force-dynamic";

export default async function AnalyticsCompetitorsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days = parseDays(sp.days, 30);
  const ws = workspace();
  const v = await getCompetitorsView(days);
  const now = new Date();

  // Typical views per creator, from the benchmark (posts in the window), else the scan's stored baseline.
  const typical = new Map<string, { views: number | null; n: number }>();
  for (const b of v.benches) for (const p of b.peers) typical.set(`${b.platform}:${p.key.toLowerCase()}`, { views: p.medianViews, n: p.n });
  const you = v.benches.filter((b) => b.own.n > 0).map((b) => ({ platform: b.platform, views: b.own.medianViews, n: b.own.n, ratio: b.viewsRatio }));

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="who" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="who" className="text-h2 font-medium text-fg">
              Who you track
            </h2>
            <p className="max-w-[68ch] text-small text-fg-2">Typical views are each account&apos;s median post, so one viral post doesn&apos;t skew it. The daily scan reads their new posts.</p>
          </div>
          <AddCreatorForm platforms={[...ws.config.platforms]} primary={!v.creators.length} />
        </div>
        {v.creators.length ? (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
            {you.map((y) => (
              <li key={`you-${y.platform}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-surface-2/40 px-4 py-3">
                <span className="flex min-w-0 items-center gap-2 text-small font-medium text-fg">
                  <PlatformIcon platform={y.platform} />
                  You on {platformLabel(y.platform)}
                </span>
                <span className="text-small tabular text-fg-2">
                  <span className="font-medium text-fg">{fmtCompact(y.views)}</span> typical views · {y.n} posts
                  {y.ratio !== null ? <span className="text-fg-3"> · {fmtX(y.ratio)} theirs</span> : null}
                </span>
              </li>
            ))}
            {v.creators.map((c) => {
              const t = typical.get(`${c.platform}:${c.handle.replace(/^@+/, "").toLowerCase()}`);
              const views = t?.views ?? c.baselineViews;
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                  <span className="flex min-w-0 items-center gap-2 text-small text-fg">
                    <PlatformIcon platform={c.platform} />
                    <span className="truncate font-medium">{handle(c.handle)}</span>
                    {c.notes ? <span className="hidden truncate text-fg-3 md:inline">{c.notes}</span> : null}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-right text-small tabular text-fg-2">
                      {views !== null ? (
                        <>
                          <span className="font-medium text-fg">{fmtCompact(views)}</span> typical views
                        </>
                      ) : (
                        <span className="text-fg-3">Not scanned yet</span>
                      )}
                      {c.outliers30d ? <span> · {c.outliers30d} outlier{c.outliers30d === 1 ? "" : "s"} this month</span> : null}
                      <span className="block text-caption text-fg-3">{c.lastScannedAt ? `Scanned ${fmtRelative(c.lastScannedAt, now)}` : "Waiting for the first scan"}</span>
                    </span>
                    <RemoveCreator handle={c.handle} platform={c.platform} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No competitors yet" body="Track a few accounts in your niche. We read their recent posts and point out the ones that beat their normal." />
        )}
      </section>

      <section aria-labelledby="outliers" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="outliers" className="text-h2 font-medium text-fg">
              Their outliers
            </h2>
            <p className="max-w-[68ch] text-small text-fg-2">Posts that ran far above their creator&apos;s own normal. Remix one and it lands in Scripts: the structure, in your voice, never a copy.</p>
          </div>
          <Segmented param="days" label="Time range" current={String(days)} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
        </div>
        {v.outliers.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {v.outliers.map((o) => (
              <OutlierCard key={o.id} o={o} now={now} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-small text-fg-2">
            {v.creators.length ? `No outliers in the last ${days} days. Try a longer range; the daily scan adds new ones.` : "Track a competitor and their outliers show up here after the next scan."}
          </p>
        )}
      </section>

      {v.trends.length ? (
        <Panel
          title="In the news"
          id="trends"
          takeaway="Stories picking up speed in your niche."
        >
          <ul className="flex flex-col divide-y divide-border">
            {v.trends.map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-4 py-2.5">
                <a href={t.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-small text-fg hover:underline hover:underline-offset-4">
                  {t.title}
                </a>
                <span className="shrink-0 text-caption tabular text-fg-3">{t.publishedAt ? fmtRelative(t.publishedAt, now) : ""}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
