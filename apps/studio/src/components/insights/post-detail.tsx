import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { PostDetail } from "@attentionos/module-learn/analytics";
import { TrendChart, TrendLegend } from "@/components/charts/trend";
import { fmtCompact, fmtDate, fmtDuration, fmtTime, fmtX, humanize, platformLabel } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import { Badge, cn } from "@/components/ui";
import type { PostMortem } from "@/server/queries/insights";
import { Gap, Panel, VERDICT } from "./kit";
import { DIMENSION_LABEL, valueLabel } from "./labels";
import { MortemCard } from "./post-mortems";
import { fmtUnit, type Unit } from "./units";

const LABEL_NAME: Record<string, string> = { "1h": "1 hour", "24h": "1 day", "72h": "3 days", "7d": "7 days", "30d": "30 days" };

function Compare({ label, value, usual, unit, better = "up" }: { label: string; value: number | null; usual?: number | null; unit: Unit; better?: "up" | "down" }) {
  const r = value !== null && usual ? value / usual : null;
  const good = r !== null && (better === "up" ? r >= 1.1 : r <= 0.9);
  const bad = r !== null && (better === "up" ? r <= 0.9 : r >= 1.1);
  return (
    <div className="min-w-0">
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="mt-0.5 text-h3 font-medium tabular text-fg">{fmtUnit(value, unit)}</dd>
      {usual !== undefined ? (
        <dd className={cn("text-caption tabular", good ? "text-success" : bad ? "text-danger" : "text-fg-3")}>
          {usual === null ? "No usual yet" : `usual ${fmtUnit(usual, unit)}`}
        </dd>
      ) : null}
    </div>
  );
}

export function PostDetailView({ d, mortems, tz }: { d: PostDetail; mortems: PostMortem[]; tz: string }) {
  const p = d.post;
  const n = d.norms;
  const curveLabels = d.usualCurve.map((c) => c.label);
  // The post's value at each scheduled capture (labelled snapshots only; "latest" fills the newest gap).
  const own = curveLabels.map((l) => d.series.find((s) => s.label === l)?.views ?? null);
  const latest = [...d.series].reverse().find((s) => s.label === "latest" || s.label === "import");
  if (latest && latest.views !== null) {
    const idx = d.usualCurve.findIndex((c, i) => latest.hours <= c.hours * 1.5 && own[i] === null && (i === 0 || own[i - 1] !== null));
    if (idx >= 0) own[idx] = latest.views;
  }
  const lastIdx = own.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).pop() ?? -1;
  const atLast = lastIdx >= 0 ? d.usualCurve[lastIdx] : undefined;
  const curveTakeaway = lastIdx >= 0 && atLast?.median
    ? `At ${LABEL_NAME[atLast.label] ?? atLast.label} it had ${fmtCompact(own[lastIdx])} views against a usual ${fmtCompact(Math.round(atLast.median))} for your ${platformLabel(p.platform)} posts.`
    : "Captures land at 1 hour, 1 day, 3 days, 7 days and 30 days after posting.";
  const ret = d.retention;
  const usualRet = d.usualRetention;
  const statusBadge = p.flag === "breakout" ? <Badge tone="success">Breakout</Badge> : p.flag === "flop" ? <Badge tone="warning">Flop</Badge> : !p.settled ? <Badge tone="info">Still settling</Badge> : null;
  const plan = (d.plan ?? {}) as Record<string, string | null>;
  const planRows = [
    ["Lane", plan.lane],
    ["Hook pattern", plan.hook_pattern],
    ["Format", plan.template],
    ["Story", plan.story_structure],
    ["Call to action", plan.cta_type],
    ["Funnel stage", plan.funnel_stage],
    ["Angle", plan.angle],
    ["Length", p.durationS ? fmtDuration(p.durationS) : null],
    ["Posted", `${fmtDate(p.publishedAt, tz, { weekday: "long" })} ${fmtTime(p.publishedAt, tz)}`],
  ].filter((r): r is [string, string] => !!r[1]);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/insights/posts" className="inline-flex w-fit items-center gap-1.5 text-small text-fg-2 hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> All posts
      </Link>
      <header className="grid gap-6 rounded-xl border border-border bg-surface-1 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-3">
            <PlatformIcon platform={p.platform} label />
            <span>· {fmtDate(p.publishedAt, tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
            {statusBadge}
            {p.variants > 1 ? <Badge tone="neutral">{p.variants} trial variants, best counted</Badge> : null}
          </div>
          <h2 className="mt-2 max-w-[48ch] text-h1 font-medium text-fg">{p.title ?? "Untitled post"}</h2>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-small">
            {p.contentId ? (
              <Link href={`/content/${p.contentId}`} className="text-brand-fg hover:underline hover:underline-offset-4">
                Open the piece
              </Link>
            ) : null}
            {p.url ? (
              <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg-2 hover:text-fg">
                View on {platformLabel(p.platform)} <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : null}
          </div>
        </div>
        <div className="lg:text-right">
          <div className="font-display text-[56px] leading-[60px] text-fg">{fmtX(p.x)}</div>
          <p className="text-small text-fg-2">
            your usual on {platformLabel(p.platform)}
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
          <Compare label="Send rate" value={p.rates.sendRate} usual={n?.medianSendRate ?? null} unit="rate" />
          <Compare label="Follows per 1k views" value={p.rates.followsPer1k} usual={n?.medianFollowsPer1k ?? null} unit="per1k" />
          <Compare label="Engagement rate" value={p.rates.engagementPerView} usual={n?.medianEngagement ?? null} unit="rate" />
          <Compare label="3-second hold" value={p.hold3s} usual={n?.medianHold3s ?? null} unit="rate" />
          <Compare label="First-day pace" value={p.velocity} unit="x" />
          <Compare label="Reach" value={p.reach} unit="count" />
          <Compare label="Comments" value={p.comments} unit="count" />
          <Compare label="Shares" value={p.shares} unit="count" />
          <Compare label="Saves" value={p.saves} unit="count" />
          <Compare label="Profile visits" value={p.profileVisits} unit="count" />
          <Compare label="Avg watch" value={p.avgWatchS} unit="seconds" />
        </dl>
        <p className="mt-4 text-caption text-fg-3">
          Numbers from the {p.snapshot ? `${LABEL_NAME[p.snapshot] ?? p.snapshot} capture` : "latest capture"}. Usual = the median of your settled {platformLabel(p.platform)} posts. A dash means the platform didn&apos;t report it.
        </p>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Views over time" takeaway={curveTakeaway} id="curve">
          <TrendChart
            labels={curveLabels.map((l) => LABEL_NAME[l] ?? l)}
            tooltipLabels={curveLabels.map((l) => `After ${LABEL_NAME[l] ?? l}`)}
            series={[{ label: "This post", values: own }, { label: "Your usual", values: d.usualCurve.map((c) => c.median), dashed: true }]}
            band={{ low: d.usualCurve.map((c) => c.low), high: d.usualCurve.map((c) => c.high) }}
            bandLabel="Usual range"
            unit="count"
            height={220}
            ariaLabel="This post's views at each capture against the usual curve"
          />
          <div className="mt-3">
            <TrendLegend items={[{ label: "This post", kind: "line" }, { label: "Your usual (median)", kind: "dashed", color: "var(--text-secondary)" }, { label: "Usual range", kind: "band" }]} />
          </div>
        </Panel>
        <Panel
          title="Retention"
          id="retention"
          takeaway={ret ? `${fmtUnit(p.hold3s, "rate")} were still watching at 3 seconds${n?.medianHold3s ? ` (usual ${fmtUnit(n.medianHold3s, "rate")})` : ""}; ${Math.round(ret[ret.length - 1]!.pct)}% made it to ${Math.round(ret[ret.length - 1]!.t)}s.` : undefined}
        >
          {ret ? (
            <>
              <TrendChart
                labels={ret.map((r) => `${Math.round(r.t)}s`)}
                series={[{ label: "This post", values: ret.map((r) => r.pct / 100) }, ...(usualRet ? [{ label: "Your usual", values: ret.map((r) => (usualRet.find((u) => u.t === r.t)?.pct ?? null) as number | null).map((v) => (v === null ? null : v / 100)), dashed: true }] : [])]}
                unit="rate"
                yMax={1}
                height={220}
                ariaLabel="Share of viewers still watching by second"
              />
              <div className="mt-3">
                <TrendLegend items={[{ label: "This post", kind: "line" }, ...(usualRet ? [{ label: "Your usual", kind: "dashed" as const, color: "var(--text-secondary)" }] : [])]} />
              </div>
            </>
          ) : (
            <Gap>No retention curve for this post. Instagram doesn&apos;t expose it by API: export it and drop the CSV in imports/analytics/ (retention column).</Gap>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Why it did what it did" id="why" takeaway="Computed against your own numbers; the post-mortem below goes deeper.">
          {d.why.length ? (
            <ul className="flex flex-col gap-2">
              {d.why.map((w) => (
                <li key={w} className="relative pl-4 text-small text-fg before:absolute before:left-0 before:top-[9px] before:size-1 before:rounded-full before:bg-brand">
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-small text-fg-3">Nothing stands far from your usual on this post.</p>
          )}
          {d.features.length ? (
            <div className="mt-5 border-t border-border pt-4">
              <h4 className="text-caption font-medium text-fg-2">How its choices usually do (last 90 days)</h4>
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {d.features.map((f) => {
                  const v = VERDICT[f.verdict] ?? VERDICT.flat!;
                  return (
                    <li key={`${f.dimension}:${f.value}`} className="flex items-baseline justify-between gap-4 py-2">
                      <span className="min-w-0 text-small text-fg">
                        <span className="text-fg-3">{DIMENSION_LABEL[f.dimension] ?? humanize(f.dimension)}:</span> {valueLabel(f.dimension, f.value)}
                      </span>
                      <span className="shrink-0 text-right text-caption tabular">
                        {f.sufficient ? (
                          <>
                            <span className="text-small font-medium text-fg">{fmtX(f.lift)}</span>
                            <span className={cn("ml-2", v.tone)}>{v.label}</span>
                            <span className="text-fg-3"> · n={f.n}</span>
                          </>
                        ) : (
                          <span className="text-fg-3">Too few posts (n={f.n})</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel title="What it drove" id="drove">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 lg:grid-cols-2">
              {[
                ["Link clicks", p.funnel.clicks || p.clicks || 0],
                ["Leads", p.funnel.leads],
                ["Booked calls", p.funnel.bookings],
                ["Revenue", p.funnel.revenue],
              ].map(([k, v]) => (
                <div key={k as string}>
                  <dt className="text-caption text-fg-3">{k}</dt>
                  <dd className="text-h3 font-medium tabular text-fg">{k === "Revenue" ? fmtUnit(v as number, "usd") : fmtCompact(v as number)}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          {planRows.length ? (
            <Panel title="The plan behind it" id="plan">
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-small">
                {planRows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-fg-3">{k}</dt>
                    <dd className="text-fg">{k === "Angle" || k === "Length" || k === "Posted" ? v : humanize(v)}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          ) : null}
        </div>
      </div>

      <section aria-labelledby="pm" className="flex flex-col gap-3">
        <h3 id="pm" className="text-h2 font-medium text-fg">
          Post-mortem
        </h3>
        {mortems.length ? (
          mortems.map((m) => <MortemCard key={m.id} m={m} tz={tz} />)
        ) : (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-small text-fg-2">
            {p.flag ? "The Analyst writes this one once its numbers settle." : "Post-mortems are written for breakouts, flops and new bests. This post sits near your usual."}
          </p>
        )}
      </section>
    </div>
  );
}
