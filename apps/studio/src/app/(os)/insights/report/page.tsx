import type { Metadata } from "next";
import Link from "next/link";
import { blockLabel, WEEKDAYS } from "@attentionos/scoring";
import { fmtCompact, fmtDate, fmtX, humanize } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import { CostWatch } from "@/components/insights/cost-watch";
import { Figure } from "@/components/insights/figure";
import { Delta, Gap, Panel } from "@/components/insights/kit";
import { PostMortems } from "@/components/insights/post-mortems";
import { fmtUnit } from "@/components/insights/units";
import { AgentMonogram } from "@/motion/AgentMonogram";
import { costWatch, getReport, postMortems } from "@/server/queries/insights";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Weekly report · Insights" };
export const dynamic = "force-dynamic";

const DIM: Record<string, string> = { hook_pattern: "Hook", lane: "Lane", format: "Format", angle: "Angle", funnel_stage: "Funnel stage", cta_type: "Call to action", length_bucket: "Length", story_structure: "Story" };

export default async function WeeklyReportPage() {
  const ws = workspace();
  const tz = ws.config.workspace.timezone;
  const [r, costs, mortems] = await Promise.all([getReport(), costWatch(), postMortems(6)]);
  const ns = r.northStar;
  const unit = ns.metric === "revenue_per_week" ? "usd" : ns.metric === "skip_rate" ? "rate" : "count";
  const k = (key: string) => r.kpis.find((x) => x.key === key);
  const nums = [
    { label: "Posts published", value: String(r.posts), sub: `last week ${r.previousPosts}` },
    { label: "Typical post", value: fmtX(r.medianX), sub: `last week ${fmtX(r.previousMedianX)}` },
    { label: "Send rate", value: fmtUnit(k("send_rate")?.value ?? null, "rate"), sub: "shares + saves per view" },
    { label: "Follows per 1k views", value: fmtUnit(k("follows_per_1k")?.value ?? null, "per1k"), sub: "posts this week" },
    { label: "New followers", value: r.followers.delta7 === null ? "–" : `${r.followers.delta7 >= 0 ? "+" : "−"}${fmtCompact(Math.abs(r.followers.delta7))}`, sub: r.followers.previous7 === null ? "" : `week before ${r.followers.previous7 >= 0 ? "+" : "−"}${fmtCompact(Math.abs(r.followers.previous7))}` },
    { label: "Leads", value: String(r.funnel.totals.leads), sub: `${r.funnel.totals.bookings} booked call${r.funnel.totals.bookings === 1 ? "" : "s"}` },
  ];
  const statLine = (s: (typeof r.wins)[number]) => (
    <li key={`${s.dimension}:${s.value}`} className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="min-w-0 text-small text-fg">
        <span className="text-fg-3">{DIM[s.dimension] ?? humanize(s.dimension)}:</span> {s.dimension === "angle" ? s.value : humanize(s.value)}
      </span>
      <span className="shrink-0 text-small tabular text-fg-2">
        <span className="font-medium text-fg">{fmtX(s.medianX)}</span> · n={s.n}
      </span>
    </li>
  );
  const slot = r.slots.best[0];
  return (
    <article className="flex flex-col gap-6">
      <header className="rounded-xl border border-border bg-surface-1 p-6 sm:p-10">
        <p className="text-small text-fg-2">Weekly report · week ending {fmtDate(`${r.weekEnding}T12:00:00Z`, "UTC", { month: "long", day: "numeric" })}</p>
        <h2 className="mt-4 max-w-[24ch] font-display text-[40px] leading-[44px] text-fg sm:text-[56px] sm:leading-[60px]">{r.headline}</h2>
        <div className="mt-8 grid gap-8 md:grid-cols-[auto_minmax(0,1fr)] md:items-end md:gap-12">
          {ns.value !== null ? <Figure value={ns.value} unit={unit} label={`${ns.label}${ns.target !== null ? ` · goal ${fmtUnit(ns.target, unit)}` : ""}`} size="l" /> : <Gap>{ns.gap ?? "Not measured."}</Gap>}
          <div className="flex gap-3 md:pb-6">
            <AgentMonogram agent={{ monogram: "An", state: "idle", name: "Analyst" }} size={24} />
            <p className="max-w-[56ch] text-body text-fg">
              <span className="sr-only">Analyst: </span>
              {r.pacing ? r.pacing.pace.line : "No pace to report yet."}
              {ns.previous !== null && ns.value !== null ? <span className="ml-2 align-middle"><Delta change={ns.previous === 0 ? null : (ns.value - ns.previous) / ns.previous} suffix="vs last week" better={ns.metric === "skip_rate" ? "down" : "up"} /></span> : null}
            </p>
          </div>
        </div>
      </header>

      <section aria-label="This week's numbers" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3 xl:grid-cols-6">
        {nums.map((n) => (
          <div key={n.label} className="bg-surface-1 px-5 py-4">
            <div className="text-small text-fg-2">{n.label}</div>
            <div className="mt-1 text-h1 font-medium text-fg">{n.value}</div>
            <div className="text-caption text-fg-3">{n.sub}</div>
          </div>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {[{ title: "Best post", b: r.best }, { title: "Weakest post", b: r.worst }].map(({ title, b }) => (
          <Panel key={title} title={title} id={title}>
            {b ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                  <Link href={`/insights/posts/${b.post.postId}`} className="min-w-0 hover:underline hover:decoration-border-strong hover:underline-offset-4">
                    <span className="flex items-center gap-2 text-caption text-fg-3">
                      <PlatformIcon platform={b.post.platform} /> {fmtDate(b.post.publishedAt, tz, { weekday: "short", month: "short", day: "numeric" })}
                    </span>
                    <span className="mt-1 block text-h3 font-medium text-fg">{b.post.title}</span>
                  </Link>
                  <span className="shrink-0 font-display text-[40px] leading-[44px] text-fg">{fmtX(b.post.x)}</span>
                </div>
                {b.why.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {b.why.map((w) => (
                      <li key={w} className="relative pl-4 text-small text-fg-2 before:absolute before:left-0 before:top-[9px] before:size-1 before:rounded-full before:bg-fg-3">
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-small text-fg-3">No measured posts this period.</p>
            )}
          </Panel>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Lifting results" takeaway="Last 90 days, against your typical post." id="lifting">
          {r.wins.length ? <ul className="divide-y divide-border">{r.wins.map(statLine)}</ul> : <p className="text-small text-fg-3">No choice stands above your typical post yet.</p>}
        </Panel>
        <Panel title="Holding results back" takeaway="Same depth for what isn't working." id="holding">
          {r.losses.length ? <ul className="divide-y divide-border">{r.losses.map(statLine)}</ul> : <p className="text-small text-fg-3">No choice stands below your typical post.</p>}
        </Panel>
      </div>

      <Panel title="Focus next week" takeaway="Each one comes from a number above." id="focus" className="signal-left">
        {r.focus.length ? (
          <ol className="flex flex-col gap-2.5">
            {r.focus.map((f, i) => (
              <li key={f} className="flex gap-3 text-body text-fg">
                <span className="mt-0.5 font-display text-[20px] leading-6 text-brand-fg">{i + 1}</span>
                {f}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-small text-fg-3">Nothing clear enough to act on yet. Keep posting; the read sharpens with every settled post.</p>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Funnel this week" id="funnel-w">
          <p className="text-small text-fg-2">
            {fmtCompact(r.funnel.totals.views)} views → {r.funnel.clicksSource === "none" ? "clicks n/a" : `${fmtCompact(r.funnel.totals.clicks)} clicks`} → {r.funnel.totals.leads} leads → {r.funnel.totals.bookings} booked
            {r.funnel.totals.revenue ? ` → ${fmtUnit(r.funnel.totals.revenue, "usd")}` : ""}
          </p>
          <Link href="/insights/funnel?days=7" className="mt-3 inline-block text-small text-brand-fg hover:underline hover:underline-offset-4">
            See the funnel
          </Link>
        </Panel>
        <Panel title="When to post" id="slot-w">
          <p className="text-small text-fg-2">{slot ? `${WEEKDAYS[slot.day]} ${blockLabel(slot.startHour, slot.endHour)} leads at ${fmtX(slot.shrunkX)} over ${slot.n} posts.` : "No slot has enough posts yet."}</p>
          <Link href="/insights/timing" className="mt-3 inline-block text-small text-brand-fg hover:underline hover:underline-offset-4">
            See the heatmap
          </Link>
        </Panel>
        <Panel title="Against tracked creators" id="bench-w">
          <p className="text-small text-fg-2">{r.benchmark && r.benchmark.viewsRatio !== null ? `Your typical post gets ${fmtX(r.benchmark.viewsRatio)} their median views.` : "Not enough competitor posts yet."}</p>
          <Link href="/insights/competitors" className="mt-3 inline-block text-small text-brand-fg hover:underline hover:underline-offset-4">
            See benchmarks
          </Link>
        </Panel>
      </div>

      {r.gaps.length ? (
        <Panel title="Not enough data yet" takeaway="Missing numbers, stated as missing, not guessed." id="gaps">
          <div className="flex flex-col gap-2">{r.gaps.map((g) => <Gap key={g}>{g}</Gap>)}</div>
        </Panel>
      ) : null}

      <section aria-labelledby="mortems" className="flex flex-col gap-3">
        <h3 id="mortems" className="text-h2 font-medium text-fg">
          Post-mortems
        </h3>
        <p className="-mt-2 text-small text-fg-2">Wins and losses get the same depth, so the team learns from both.</p>
        <PostMortems items={mortems} tz={tz} />
      </section>

      <section aria-labelledby="costs" className="flex flex-col gap-3">
        <h3 id="costs" className="text-h2 font-medium text-fg">
          Cost watch
        </h3>
        <CostWatch data={costs} dailyBudget={ws.config.budgets.dailyUsd} />
      </section>

      <details className="rounded-lg border border-border bg-surface-1 p-5">
        <summary className="cursor-pointer text-small text-fg-2">Plain-text version (what the Analyst sends on Mondays)</summary>
        <pre className="mt-4 whitespace-pre-wrap font-mono text-[13px] leading-5 text-fg-2">{r.markdown}</pre>
      </details>
    </article>
  );
}
