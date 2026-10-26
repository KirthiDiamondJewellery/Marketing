import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { GoalPacing, Overview } from "@attentionos/module-learn/analytics";
import { PaceBar } from "@/components/charts/analytics";
import { TrendChart, TrendLegend } from "@/components/charts/trend";
import { fmtCompact, fmtDate, fmtX, humanize, platformLabel } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import { Badge, cn } from "@/components/ui";
import { AgentMonogram } from "@/motion/AgentMonogram";
import { Figure } from "./figure";
import { Cascade } from "./cascade";
import { Delta, Gap, Panel, Stat, fmtUnit, type Unit } from "./kit";

const STATUS: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" }> = {
  met: { label: "Goal met", tone: "success" },
  on_track: { label: "On track", tone: "success" },
  at_risk: { label: "At risk", tone: "warning" },
  behind: { label: "Behind", tone: "danger" },
  no_target: { label: "No target", tone: "neutral" },
  no_data: { label: "Not measured", tone: "neutral" },
};

const unitOf = (g: GoalPacing): Unit => (g.unit === "usd" ? "usd" : g.unit === "rate" ? "rate" : g.unit === "number" ? "number" : "count");

function paceTakeaway(ns: GoalPacing | undefined, ov: Overview): string {
  const parts: string[] = [];
  if (ns && ns.pace.actual !== null) {
    const p = ns.pace;
    const v = (n: number | null) => fmtUnit(n, unitOf(ns));
    const what = ns.label.replace(/ per week$/, "").toLowerCase();
    if (p.status === "met") parts.push(`This week's ${what} goal of ${v(p.target)} is already met`);
    else if (p.status === "on_track") parts.push(`${v(p.actual)} ${what} so far, on pace for ${v(p.projected)} against a goal of ${v(p.target)}`);
    else if (p.target !== null) parts.push(`${v(p.actual)} of ${v(p.target)} ${what} so far this week, ${p.status === "at_risk" ? "tracking just short" : "behind pace"}`);
  }
  if (ov.best && ov.best.post.x !== null) {
    parts.push(`the ${ov.best.period === "week" ? "week's" : "month's"} best post ran ${fmtX(ov.best.post.x)} your usual${ov.best.why[0] ? ` (${ov.best.why[0].charAt(0).toLowerCase()}${ov.best.why[0].slice(1).split(",")[0]})` : ""}`);
  }
  if (!parts.length) return "Not enough posts have been measured yet to call a trend. The first read comes 24 hours after a post goes out.";
  const s = parts.join("; ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

export function NorthStarHero({ ov, tz }: { ov: Overview; tz: string }) {
  const ns = ov.pacing.find((g) => g.isNorthStar);
  const others = ov.pacing.filter((g) => !g.isNorthStar);
  const range = ns ? `${fmtDate(ns.weekStart, tz, { month: "short", day: "numeric" })} – ${fmtDate(new Date(Date.parse(ns.weekEnd) - 1), tz, { month: "short", day: "numeric" })}` : "";
  const history = ns ? [...ns.history.map((h) => h.value), ns.pace.actual] : [];
  const histLabels = ns ? [...ns.history.map((h) => fmtDate(h.weekStart, tz, { month: "short", day: "numeric" })), "This week"] : [];
  const status = ns ? STATUS[ns.pace.status]! : null;
  return (
    <section aria-labelledby="ns-title" className="rounded-xl border border-border bg-surface-1">
      <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-12">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="ns-title" className="text-small text-fg-2">
              North star <span className="text-fg-3">· {range}</span>
            </h2>
            {status ? <Badge tone={status.tone === "danger" ? "danger" : status.tone === "warning" ? "warning" : status.tone === "success" ? "success" : "neutral"}>{status.label}</Badge> : null}
          </div>
          {ns && ns.pace.actual !== null ? (
            <>
              <Figure value={ns.pace.actual} unit={unitOf(ns)} label={`${ns.label.replace(/ per week$/, "")} this week`} size="xl" />
              {ns.pace.target !== null ? (
                <div>
                  <PaceBar actual={ns.pace.actual} target={ns.pace.target} expected={ns.pace.expectedByNow} projected={ns.pace.projected} direction={ns.direction} label={`${ns.label}: ${ns.pace.line}`} />
                  <p className="mt-2 text-caption text-fg-3">{ns.pace.line}</p>
                </div>
              ) : null}
            </>
          ) : (
            <Gap>{ns?.gap ?? "No north-star numbers yet."}</Gap>
          )}
        </div>
        <div className="flex min-w-0 flex-col justify-between gap-6">
          <div className="flex gap-3">
            <AgentMonogram agent={{ monogram: "An", state: "idle", name: "Analyst" }} size={24} />
            <p className="max-w-[52ch] text-body text-fg">
              <span className="sr-only">Analyst: </span>
              {paceTakeaway(ns, ov)}
            </p>
          </div>
          {ns && history.some((v) => v !== null) ? (
            <div className="min-w-0">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-small font-medium text-fg">{ns.label} by week</h3>
                <TrendLegend items={[{ label: ns.label.replace(/ per week$/, ""), kind: "line" }, ...(ns.pace.target !== null ? [{ label: "Goal", kind: "target" as const }] : [])]} />
              </div>
              <TrendChart
                labels={histLabels.map((l, i) => (i === histLabels.length - 1 ? "Now" : l))}
                tooltipLabels={histLabels.map((l, i) => (i === histLabels.length - 1 ? "This week so far" : `Week of ${l}`))}
                series={[{ label: ns.label.replace(/ per week$/, ""), values: history }]}
                target={ns.pace.target !== null ? { value: ns.pace.target, label: "" } : null}
                height={150}
                unit={unitOf(ns)}
                draw
                ariaLabel={`${ns.label} for the last ${history.length} weeks`}
              />
            </div>
          ) : null}
        </div>
      </div>
      {others.length ? (
        <Cascade className="grid border-t border-border sm:grid-cols-2" delay={0.6}>
          {others.map((g, i) => {
            const st = STATUS[g.pace.status]!;
            return (
              <div key={g.metric} className={cn("flex h-full flex-col gap-2 px-6 py-5 sm:px-8", i % 2 ? "border-t border-border sm:border-l sm:border-t-0" : "")}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-small text-fg-2">{g.label}</span>
                  <span className={cn("text-caption", st.tone === "success" ? "text-success" : st.tone === "warning" ? "text-warning" : st.tone === "danger" ? "text-danger" : "text-fg-3")}>{st.label}</span>
                </div>
                <div className="text-h1 font-medium text-fg">
                  {fmtUnit(g.pace.actual, unitOf(g))}
                  {g.pace.target !== null ? <span className="text-small font-normal text-fg-3"> / {fmtUnit(g.pace.target, unitOf(g))}</span> : null}
                </div>
                {g.pace.actual !== null && g.pace.target !== null ? (
                  <PaceBar actual={g.pace.actual} target={g.pace.target} expected={g.pace.expectedByNow} projected={g.pace.projected} direction={g.direction} label={`${g.label}: ${g.pace.line}`} />
                ) : g.gap ? (
                  <Gap>{g.gap}</Gap>
                ) : null}
                <p className="text-caption text-fg-3">{g.pace.line}</p>
              </div>
            );
          })}
        </Cascade>
      ) : null}
    </section>
  );
}

export function KpiStrip({ ov }: { ov: Overview }) {
  const keys = ["views", "typical_x", "engagement", "send_rate", "follows_per_1k", "leads"];
  const kpis = keys.map((k) => ov.kpis.find((x) => x.key === k)).filter((k): k is NonNullable<typeof k> => !!k);
  const hint: Record<string, string> = {
    typical_x: "1× is your usual post",
    send_rate: "Shares + saves per view",
  };
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3 xl:grid-cols-6">
      {kpis.map((k) => (
        <Stat
          key={k.key}
          label={k.label}
          value={fmtUnit(k.value, k.unit)}
          delta={<Delta change={k.unit === "x" && k.value !== null && k.previous !== null ? k.value - k.previous : k.change} points={k.unit === "x"} better={k.better} suffix="vs prior" />}
          hint={hint[k.key]}
          className="bg-surface-1"
        />
      ))}
    </div>
  );
}

export function TrendPanels({ ov, tz }: { ov: Overview; tz: string }) {
  const weeks = ov.trend;
  const labels = weeks.map((w) => fmtDate(w.start, tz, { month: "short", day: "numeric" }));
  const tips = weeks.map((w) => `Week of ${fmtDate(w.start, tz, { month: "short", day: "numeric" })} · ${w.posts} post${w.posts === 1 ? "" : "s"}`);
  const recent = weeks.slice(-4);
  const above = recent.filter((w) => w.medianViews !== null && w.bandHigh !== null && w.medianViews > w.bandHigh).length;
  const below = recent.filter((w) => w.medianViews !== null && w.bandLow !== null && w.medianViews < w.bandLow).length;
  const viewsTakeaway = above >= 2
    ? `Your typical post has run above its normal range in ${above} of the last 4 weeks.`
    : below >= 2
      ? `Your typical post has dipped below its normal range in ${below} of the last 4 weeks.`
      : "Your typical post has stayed inside its normal range lately.";
  const send = weeks.map((w) => w.sendRate);
  const lastSend = [...send].reverse().find((v) => v !== null) ?? null;
  const firstSend = send.find((v) => v !== null) ?? null;
  const fol = ov.followers;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Views per post" takeaway={viewsTakeaway} id="trend-views">
        <TrendChart
          labels={labels}
          tooltipLabels={tips}
          series={[{ label: "Median views per post", values: weeks.map((w) => w.medianViews) }]}
          band={{ low: weeks.map((w) => w.bandLow), high: weeks.map((w) => w.bandHigh) }}
          bandLabel="Normal range"
          unit="count"
          ariaLabel="Median views per post by week against the normal range of the 90 days before"
        />
        <div className="mt-3">
          <TrendLegend items={[{ label: "Median views per post, by week posted", kind: "line" }, { label: "Normal range (middle half of the 90 days before)", kind: "band" }]} />
        </div>
      </Panel>
      <Panel
        title="Send rate"
        takeaway={lastSend !== null && firstSend !== null ? `Shares and saves per view ${lastSend >= firstSend ? "rose" : "fell"} from ${fmtUnit(firstSend, "rate")} to ${fmtUnit(lastSend, "rate")} over 12 weeks: the signal that people found a post worth keeping or sending.` : "Shares and saves per view, by week."}
        id="trend-send"
      >
        <TrendChart labels={labels} tooltipLabels={tips} series={[{ label: "Send rate", values: send }]} unit="rate" ariaLabel="Send rate by week" />
        <p className="mt-3 text-caption text-fg-3">Shares and saves per view, for posts published that week.</p>
      </Panel>
      <Panel
        title="Followers"
        id="trend-followers"
        className="xl:col-span-2"
        takeaway={fol.gap ? undefined : `${fmtCompact(fol.current)} across your accounts, ${fol.delta7 !== null ? `${fol.delta7 >= 0 ? "+" : "−"}${fmtCompact(Math.abs(fol.delta7))} this week` : ""}${fol.previous7 !== null ? ` against ${fol.previous7 >= 0 ? "+" : "−"}${fmtCompact(Math.abs(fol.previous7))} the week before` : ""}.`}
      >
        {fol.gap ? (
          <Gap>{fol.gap}</Gap>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
            <TrendChart
              labels={fol.series.map((p) => fmtDate(`${p.day}T12:00:00Z`, "UTC", { month: "short", day: "numeric" }))}
              series={[{ label: "Followers", values: fol.series.map((p) => p.followers) }]}
              yMin="auto"
              unit="count"
              height={200}
              ariaLabel="Total followers by day"
            />
            <ul className="flex flex-col divide-y divide-border">
              {fol.accounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-3 first:pt-0">
                  <PlatformIcon platform={a.platform} label />
                  <div className="text-right">
                    <div className="text-small font-medium tabular text-fg">{fmtCompact(a.followers)}</div>
                    <div className="text-caption tabular text-fg-3">{a.delta7 === null ? "–" : `${a.delta7 >= 0 ? "+" : "−"}${fmtCompact(Math.abs(a.delta7))} this week`}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </div>
  );
}

export function BestPostCard({ ov, tz }: { ov: Overview; tz: string }) {
  if (!ov.best) return null;
  const p = ov.best.post;
  const rows = [
    { label: "Views", value: fmtCompact(p.views) },
    { label: "Send rate", value: fmtUnit(p.rates.sendRate, "rate") },
    { label: "Follows / 1k", value: fmtUnit(p.rates.followsPer1k, "per1k") },
    { label: "First-day pace", value: p.velocity === null ? "–" : fmtX(p.velocity) },
    { label: "Leads", value: String(p.funnel.leads) },
  ];
  return (
    <section aria-labelledby="best-title" className="grid overflow-hidden rounded-lg border border-border bg-surface-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex flex-col justify-between gap-6 border-b border-border p-6 sm:p-8 lg:border-b-0 lg:border-r">
        <div>
          <h2 id="best-title" className="text-small text-fg-2">
            Best post of the {ov.best.period}
          </h2>
          <div className="mt-4 font-display text-[56px] leading-[60px] text-fg">{fmtX(p.x)}</div>
          <p className="text-small text-fg-2">your usual result on {platformLabel(p.platform)}</p>
        </div>
        <div>
          <div className="flex items-center gap-2 text-caption text-fg-3">
            <PlatformIcon platform={p.platform} />
            {fmtDate(p.publishedAt, tz, { weekday: "short", month: "short", day: "numeric" })}
            {p.features.lane ? <span>· {humanize(p.features.lane)}</span> : null}
          </div>
          <h3 className="mt-1 text-h3 font-medium text-fg">{p.title}</h3>
          <Link href={`/insights/posts/${p.postId}`} className="mt-3 inline-flex items-center gap-1.5 text-small text-brand-fg hover:underline hover:underline-offset-4">
            Open the full breakdown <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </div>
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <div>
          <h3 className="text-small font-medium text-fg">Why it worked</h3>
          {ov.best.why.length ? (
            <ul className="mt-2 flex flex-col gap-2">
              {ov.best.why.map((w) => (
                <li key={w} className="relative pl-4 text-small text-fg-2 before:absolute before:left-0 before:top-[9px] before:size-1 before:rounded-full before:bg-brand">
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-small text-fg-3">Nothing stands out against your usual numbers yet; the post-mortem digs deeper once its numbers settle.</p>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
          {rows.map((r) => (
            <div key={r.label}>
              <dt className="text-caption text-fg-3">{r.label}</dt>
              <dd className="text-h3 font-medium tabular text-fg">{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
