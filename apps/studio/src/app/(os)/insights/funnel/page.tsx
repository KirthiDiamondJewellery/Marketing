import type { Metadata } from "next";
import Link from "next/link";
import { FunnelSteps } from "@/components/charts/analytics";
import { TrendChart, TrendLegend } from "@/components/charts/trend";
import { fmtCompact, fmtDate } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import { Gap, Panel, Stat } from "@/components/insights/kit";
import { Segmented } from "@/components/insights/nav";
import { fmtUnit, RANGE_OPTIONS } from "@/components/insights/units";
import { getFunnel, parseRange } from "@/server/queries/insights";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Funnel · Insights" };
export const dynamic = "force-dynamic";

export default async function FunnelPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days = parseRange(sp.days, 30);
  const tz = workspace().config.workspace.timezone;
  const { report: f, rows } = await getFunnel(days);
  const t = f.totals;
  const drop = f.biggestDrop;
  const takeaway = t.views
    ? `${fmtCompact(t.views)} views turned into ${t.leads} lead${t.leads === 1 ? "" : "s"}${t.bookings ? `, ${t.bookings} booked call${t.bookings === 1 ? "" : "s"}` : ""}${t.revenue ? ` and ${fmtUnit(t.revenue, "usd")} in sales` : ""}.${drop ? ` The biggest drop is ${drop.label.toLowerCase()}: ${fmtUnit(drop.fromPrevious, "rate")} of the step before.` : ""}`
    : "No posts with views in this window yet.";
  const top = rows.filter((r) => r.counts.leads || r.counts.bookings || r.counts.revenue || r.counts.clicks).slice(0, 12);
  const labels = f.weekly.map((w) => fmtDate(w.start, tz, { month: "short", day: "numeric" }));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h2 font-medium text-fg">Funnel</h2>
          <p className="max-w-[68ch] text-small text-fg-2">
            From a post to money: every click, lead, booked call and sale from your website is credited to the post whose tracked link (utm_content) brought the visitor in first.
          </p>
        </div>
        <Segmented param="days" options={RANGE_OPTIONS} current={String(days)} label="Time range" />
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-4">
        <Stat className="bg-surface-1" label="Leads" value={fmtCompact(t.leads)} hint={f.per1k.leads !== null ? `${f.per1k.leads.toFixed(1)} per 1k views` : undefined} />
        <Stat className="bg-surface-1" label="Booked calls" value={f.steps.find((s) => s.key === "bookings")?.value === null ? "–" : fmtCompact(t.bookings)} hint={f.per1k.bookings !== null ? `${f.per1k.bookings.toFixed(2)} per 1k views` : "Not connected"} />
        <Stat className="bg-surface-1" label="Revenue" value={f.steps.find((s) => s.key === "sales")?.value === null ? "–" : fmtUnit(t.revenue, "usd")} hint={t.sales ? `${t.sales} sale${t.sales === 1 ? "" : "s"}` : "No sales credited yet"} />
        <Stat className="bg-surface-1" label="Revenue per 1k views" value={t.views && t.revenue ? fmtUnit((t.revenue / t.views) * 1000, "usd") : "–"} hint={`Posts from the last ${days} days`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Panel title="Post to sale" takeaway={takeaway} id="steps">
          <FunnelSteps steps={f.steps} dropKey={drop?.key ?? null} format={(n, key) => (key === "views" || key === "clicks" ? fmtCompact(n) : String(n))} />
          <p className="mt-4 text-caption text-fg-3">
            Bars use a log scale so views and sales fit on one chart; the numbers are exact. Clicks come from {f.clicksSource === "website" ? "your website's events" : f.clicksSource === "platform" ? "the platform's link-click counts" : "nowhere yet"}.
          </p>
        </Panel>
        <Panel title="Leads and booked calls by week" takeaway="Counted when they happen, across every post and your bio link." id="weekly">
          <TrendChart labels={labels} tooltipLabels={labels.map((l) => `Week of ${l}`)} series={[{ label: "Leads", values: f.weekly.map((w) => w.leads) }, { label: "Booked calls", values: f.weekly.map((w) => w.bookings), color: "var(--info)" }]} unit="count" height={200} ariaLabel="Leads and booked calls per week" />
          <div className="mt-3">
            <TrendLegend items={[{ label: "Leads", kind: "line" }, { label: "Booked calls", kind: "line", color: "var(--info)" }]} />
          </div>
        </Panel>
      </div>
      <Panel title="Posts that drove business" takeaway={top.length ? "Sorted by revenue, then booked calls, then leads." : undefined} id="posts">
        {top.length ? (
          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[640px] text-small">
              <thead>
                <tr className="border-b border-border text-left text-caption text-fg-3">
                  <th scope="col" className="px-5 py-2.5 font-medium sm:px-6">Post</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Views</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Clicks</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Leads</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Booked</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium sm:px-6">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {top.map((r) => (
                  <tr key={r.postId} className="border-b border-border last:border-b-0 hover:bg-surface-2/60">
                    <td className="max-w-[320px] px-5 py-2.5 sm:px-6">
                      <Link href={`/insights/posts/${r.postId}`} className="flex min-w-0 items-center gap-2 hover:underline hover:decoration-border-strong hover:underline-offset-4">
                        <PlatformIcon platform={r.post!.platform} />
                        <span className="truncate text-fg">{r.post!.title}</span>
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular text-fg-2">{fmtCompact(r.views)}</td>
                    <td className="px-3 py-2.5 text-right tabular text-fg-2">{r.counts.clicks || r.providerClicks || "–"}</td>
                    <td className="px-3 py-2.5 text-right tabular text-fg-2">{r.counts.leads || "–"}</td>
                    <td className="px-3 py-2.5 text-right tabular text-fg-2">{r.counts.bookings || "–"}</td>
                    <td className="px-5 py-2.5 text-right font-medium tabular text-fg sm:px-6">{r.counts.revenue ? fmtUnit(r.counts.revenue, "usd") : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-small text-fg-3">No post has a credited click or lead in this window yet.</p>
        )}
        {f.untagged.leads || f.untagged.bookings ? (
          <p className="mt-4 text-caption text-fg-3">
            Not from a tracked post: {f.untagged.leads} lead{f.untagged.leads === 1 ? "" : "s"} and {f.untagged.bookings} booked call{f.untagged.bookings === 1 ? "" : "s"} arrived without a tag (direct visits or an untagged bio link).
          </p>
        ) : null}
      </Panel>
      {f.gaps.length ? <div className="flex flex-col gap-2">{f.gaps.map((g) => <Gap key={g}>{g}</Gap>)}</div> : null}
    </div>
  );
}
