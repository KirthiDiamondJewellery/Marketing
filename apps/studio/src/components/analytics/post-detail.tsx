import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { PostDetail } from "@attentionos/module-learn/analytics";
import { TrendChart, TrendLegend } from "@/components/charts/trend";
import { fmtDate, fmtDuration, fmtTime, fmtX, platformLabel } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import { Panel } from "@/components/insights/kit";
import { fmtUnit, type Unit } from "@/components/insights/units";
import { cn } from "@/components/ui";
import { versusOf } from "@/server/queries/analytics";
import { Cover } from "./cover";
import { VersusBadge } from "./versus";

const LABEL_NAME: Record<string, string> = { "1h": "1 hour", "24h": "1 day", "72h": "3 days", "7d": "7 days", "30d": "30 days" };

function Compare({ label, value, usual, unit }: { label: string; value: number | null; usual?: number | null; unit: Unit }) {
  const r = value !== null && usual ? value / usual : null;
  return (
    <div className="min-w-0">
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="mt-0.5 text-h3 font-medium tabular text-fg">{fmtUnit(value, unit)}</dd>
      {usual !== undefined ? (
        <dd className={cn("text-caption tabular", r !== null && r >= 1.1 ? "text-success" : r !== null && r <= 0.9 ? "text-danger" : "text-fg-3")}>
          {usual === null ? "No normal yet" : `normal ${fmtUnit(usual, unit)}`}
        </dd>
      ) : null}
    </div>
  );
}

/** One post: its numbers against your normal, why it did what it did, and its views over time when captured. */
export function AnalyticsPostDetail({ d, tz }: { d: PostDetail; tz: string }) {
  const p = d.post;
  const n = d.norms;
  const scan = p.scan;
  const versus = versusOf(p.x, p.settled);
  const captured = d.series.filter((s) => s.views !== null);
  const text = scan?.spokenHook ?? null;
  const caption = d.caption?.trim() || null;
  const source = scan
    ? `Numbers from your scan on ${fmtDate(scan.scannedAt, tz, { month: "short", day: "numeric" })}. Saves, reach and watch time come once your analytics account is connected.`
    : `Numbers from the ${p.snapshot ? `${LABEL_NAME[p.snapshot] ?? p.snapshot} capture` : "latest capture"}.`;
  return (
    <div className="flex flex-col gap-6">
      <Link href="/analytics/posts" className="inline-flex w-fit items-center gap-1.5 text-small text-fg-2 hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> Your posts
      </Link>
      <header className="grid gap-6 rounded-xl border border-border bg-surface-1 p-5 sm:grid-cols-[120px_minmax(0,1fr)_auto] sm:items-end sm:p-8">
        <div className="w-28 sm:w-full">
          <Cover src={scan?.thumbnailUrl ?? null} platform={p.platform} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-3">
            <PlatformIcon platform={p.platform} label />
            <span>· {fmtDate(p.publishedAt, tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
            <VersusBadge versus={versus} x={p.x} />
          </div>
          <h2 className="mt-2 max-w-[48ch] text-h1 font-medium text-fg">{p.title ?? "Untitled post"}</h2>
          {p.url ? (
            <a href={p.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-small text-fg-2 hover:text-fg">
              View on {platformLabel(p.platform)} <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ) : null}
        </div>
        <div className="sm:text-right">
          <div className="font-display text-[56px] leading-[60px] text-fg">{fmtX(p.x)}</div>
          <p className="text-small text-fg-2">
            {p.x === null ? (p.settled ? "Learning your normal" : "Still settling") : `your normal on ${platformLabel(p.platform)}`}
            {d.rank ? ` · #${d.rank.onPlatform} of ${d.rank.of}` : ""}
          </p>
        </div>
      </header>

      <section aria-labelledby="numbers" className="rounded-lg border border-border bg-surface-1 p-5 sm:p-6">
        <h3 id="numbers" className="sr-only">
          Numbers
        </h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
          <Compare label="Views" value={p.views} usual={n?.medianViews ?? null} unit="count" />
          <Compare label="Engagement rate" value={p.rates.engagementPerView} usual={n?.medianEngagement ?? null} unit="rate" />
          <Compare label="Likes" value={p.likes} unit="count" />
          <Compare label="Comments" value={p.comments} unit="count" />
          <Compare label="Shares" value={p.shares} unit="count" />
          <Compare label="Saves" value={p.saves} unit="count" />
        </dl>
        <p className="mt-4 text-caption text-fg-3">
          {source} Normal = your typical {platformLabel(p.platform)} post. A dash means the platform didn&apos;t report it.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Why it did what it did" id="why" takeaway="Against your own numbers.">
          {d.why.length ? (
            <ul className="flex flex-col gap-2">
              {d.why.map((w) => (
                <li key={w} className="relative pl-4 text-small text-fg before:absolute before:left-0 before:top-[9px] before:size-1 before:rounded-full before:bg-brand">
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-small text-fg-3">{p.x === null ? "Not enough posts yet to know your normal." : "Nothing stands far from your normal on this post."}</p>
          )}
          <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-border pt-4 text-small">
            <dt className="text-fg-3">Posted</dt>
            <dd className="text-fg">
              {fmtDate(p.publishedAt, tz, { weekday: "long" })} {fmtTime(p.publishedAt, tz)}
            </dd>
            {p.durationS ? (
              <>
                <dt className="text-fg-3">Length</dt>
                <dd className="text-fg">{fmtDuration(p.durationS)}</dd>
              </>
            ) : null}
          </dl>
        </Panel>
        {text || caption ? (
          <Panel title={text ? "What you said" : "Caption"} id="words">
            {text ? <blockquote className="text-[15px] leading-6 text-fg">“{text}”</blockquote> : null}
            {caption ? <p className={cn("whitespace-pre-line text-small text-fg-2", text && "mt-4 border-t border-border pt-4")}>{caption.length > 600 ? `${caption.slice(0, 599)}…` : caption}</p> : null}
          </Panel>
        ) : null}
      </div>

      {captured.length >= 2 ? (
        <Panel title="Views over time" id="curve" takeaway="This post at each capture against your usual post at the same age.">
          <TrendChart
            labels={d.usualCurve.map((c) => LABEL_NAME[c.label] ?? c.label)}
            series={[
              { label: "This post", values: d.usualCurve.map((c) => d.series.find((s) => s.label === c.label)?.views ?? null) },
              { label: "Your usual", values: d.usualCurve.map((c) => c.median), dashed: true },
            ]}
            band={{ low: d.usualCurve.map((c) => c.low), high: d.usualCurve.map((c) => c.high) }}
            bandLabel="Usual range"
            unit="count"
            height={220}
            ariaLabel="This post's views at each capture against your usual"
          />
          <div className="mt-3">
            <TrendLegend items={[{ label: "This post", kind: "line" }, { label: "Your usual", kind: "dashed", color: "var(--text-secondary)" }, { label: "Usual range", kind: "band" }]} />
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
