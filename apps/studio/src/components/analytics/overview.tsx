import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { TrendChart, TrendLegend } from "@/components/charts/trend";
import { fmtCompact, fmtDate, fmtX, platformLabel } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import { Delta, Panel, Stat } from "@/components/insights/kit";
import { fmtUnit } from "@/components/insights/units";
import type { AnalyticsOverview } from "@/server/queries/analytics";
import { Cover } from "./cover";
import { VersusBadge } from "./versus";

const changeOf = (v: number | null, prev: number | null) => (v === null || prev === null || prev === 0 ? null : (v - prev) / prev);

export function HeadlineStrip({ a }: { a: AnalyticsOverview }) {
  const followers = a.ov.followers;
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
      {a.headline.map((h) => {
        const value = h.unit === "number" ? (h.value === null ? "–" : h.value.toFixed(h.value >= 10 ? 0 : 1)) : fmtUnit(h.value, h.unit);
        const delta =
          h.key === "followers" ? (
            followers.delta30 !== null ? (
              <span className={followers.delta30 >= 0 ? "text-caption text-success" : "text-caption text-danger"}>
                {followers.delta30 >= 0 ? "+" : "−"}
                {fmtCompact(Math.abs(followers.delta30))} in 30 days
              </span>
            ) : undefined
          ) : h.value === null ? undefined : (
            <Delta change={changeOf(h.value, h.previous)} suffix={`vs the ${a.days} days before`} />
          );
        return <Stat key={h.key} label={h.label} value={value} delta={delta} hint={h.hint} className="bg-surface-1" />;
      })}
    </div>
  );
}

export function BestPost({ a, tz }: { a: AnalyticsOverview; tz: string }) {
  const p = a.best;
  if (!p) return null;
  return (
    <section aria-labelledby="best-title" className="grid gap-5 rounded-lg border border-border bg-surface-1 p-5 sm:grid-cols-[96px_minmax(0,1fr)] sm:p-6">
      <Link href={`/analytics/posts/${p.id}`} className="w-24 sm:w-full" aria-hidden tabIndex={-1}>
        <Cover src={p.thumbnailUrl} platform={p.platform} />
      </Link>
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <h2 id="best-title" className="text-small text-fg-2">
            Best post, last {a.days} days
          </h2>
          <p className="mt-1 text-h3 font-medium text-fg">{p.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-3">
            <PlatformIcon platform={p.platform} />
            {fmtDate(p.publishedAt, tz, { weekday: "short", month: "short", day: "numeric" })}
            <VersusBadge versus={p.versus} x={p.x} />
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {[
            ["Views", fmtCompact(p.views)],
            ["Likes", fmtCompact(p.likes)],
            ["Comments", fmtCompact(p.comments)],
            ...(p.x !== null ? [["vs your normal", fmtX(p.x)]] : []),
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-caption text-fg-3">{k}</dt>
              <dd className="text-h3 font-medium tabular text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        {a.bestWhy.length ? <p className="text-small text-fg-2">{a.bestWhy[0]}.</p> : null}
        <Link href={`/analytics/posts/${p.id}`} className="inline-flex w-fit items-center gap-1.5 text-small text-brand-fg hover:underline hover:underline-offset-4">
          See how it did <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

export function ViewsTrend({ a, tz }: { a: AnalyticsOverview; tz: string }) {
  const weeks = a.ov.trend;
  const labels = weeks.map((w) => fmtDate(w.start, tz, { month: "short", day: "numeric" }));
  const tips = weeks.map((w) => `Week of ${fmtDate(w.start, tz, { month: "short", day: "numeric" })} · ${w.posts} post${w.posts === 1 ? "" : "s"}`);
  const withPosts = weeks.filter((w) => w.posts > 0);
  const recent = weeks.slice(-4);
  const above = recent.filter((w) => w.medianViews !== null && w.bandHigh !== null && w.medianViews > w.bandHigh).length;
  const below = recent.filter((w) => w.medianViews !== null && w.bandLow !== null && w.medianViews < w.bandLow).length;
  const hasBand = weeks.some((w) => w.bandMid !== null);
  const takeaway = !withPosts.length
    ? "No posts in the last 12 weeks."
    : !hasBand
      ? `Typical views per post, by the week it went up. Your normal range shows once there are 5 posts before a week.`
      : above >= 2
        ? `Your typical post has run above its normal range in ${above} of the last 4 weeks.`
        : below >= 2
          ? `Your typical post has dipped below its normal range in ${below} of the last 4 weeks.`
          : "Your typical post has stayed inside its normal range lately.";
  return (
    <Panel title="Views per post" takeaway={takeaway} id="trend-views">
      <TrendChart
        labels={labels}
        tooltipLabels={tips}
        series={[{ label: "Typical views per post", values: weeks.map((w) => w.medianViews) }]}
        {...(hasBand ? { band: { low: weeks.map((w) => w.bandLow), high: weeks.map((w) => w.bandHigh) }, bandLabel: "Normal range" } : {})}
        unit="count"
        ariaLabel="Typical views per post by week"
      />
      <div className="mt-3">
        <TrendLegend items={[{ label: "Typical (median) views per post, by week posted", kind: "line" }, ...(hasBand ? [{ label: "Your normal range", kind: "band" as const }] : [])]} />
      </div>
    </Panel>
  );
}

export function PlatformsLine({ a }: { a: AnalyticsOverview }) {
  const platforms = [...new Set(a.recent.map((p) => p.platform))];
  if (platforms.length < 2) return null;
  return (
    <p className="text-caption text-fg-3">
      Across {platforms.map((p) => platformLabel(p)).join(", ")}. Open a platform on Your posts to see it on its own.
    </p>
  );
}
