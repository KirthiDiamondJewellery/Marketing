import type { Metadata } from "next";
import Link from "next/link";
import { blockLabel, WEEKDAYS } from "@attentionos/scoring";
import { Cover } from "@/components/analytics/cover";
import { HeatLegend, Heatmap } from "@/components/charts/analytics";
import { fmtCompact, fmtDate, fmtX } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import { Panel } from "@/components/insights/kit";
import { DIMENSION_LABEL, featurePhrase, valueLabel } from "@/components/insights/labels";
import { getWorking, type WorkingRow } from "@/server/queries/analytics";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "What's working · Analytics" };
export const dynamic = "force-dynamic";

function Finding({ r, good }: { r: WorkingRow; good: boolean }) {
  return (
    <li className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="min-w-0 text-small text-fg">
        <span className="text-fg-3">{DIMENSION_LABEL[r.dimension] ?? r.dimension}:</span> {valueLabel(r.dimension, r.value)}
      </span>
      <span className="shrink-0 text-right text-caption tabular text-fg-3">
        <span className={good ? "text-small font-medium text-success" : "text-small font-medium text-danger"}>{fmtX(r.lift)}</span> your normal · {r.n} posts
      </span>
    </li>
  );
}

export default async function AnalyticsWorkingPage() {
  const w = await getWorking();
  const tz = workspace().config.workspace.timezone;
  const h = w.slots;
  const fmt = (n: number) => fmtX(n);
  const cols = Array.from({ length: 24 / h.blockHours }, (_, b) => blockLabel(b * h.blockHours, (b + 1) * h.blockHours));
  const top = h.best[0];
  // Only call a slot "strongest" when it sits clearly above your normal; otherwise the heatmap speaks for itself.
  const best = top && top.shrunkX !== null && h.overallMedian !== null && top.shrunkX >= h.overallMedian * 1.1 ? top : null;
  const lead = w.winners[0];
  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h2 className="text-h2 font-medium text-fg">What&apos;s working</h2>
        <p className="max-w-[68ch] text-small text-fg-2">
          {w.scored
            ? `Built from ${w.scored} of your posts from the last 120 days, each compared with your typical post (1×). A choice needs ${w.minN} posts before it counts.`
            : "Nothing to compare yet. Posts count here once they are 3 days old."}
          {lead ? ` Strongest so far: ${featurePhrase(lead.dimension, lead.value)}, at ${fmtX(lead.lift)} your normal.` : ""}
        </p>
      </div>

      <Panel title="Your posts that beat your normal" id="top" takeaway={w.topPosts.length ? "Start here: what these have in common is your best guess at what works." : undefined}>
        {w.topPosts.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {w.topPosts.map((p) => (
              <li key={p.id}>
                <Link href={`/analytics/posts/${p.id}`} className="group flex gap-3 rounded-md p-1 -m-1 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-brand">
                  <span className="block w-14 shrink-0"><Cover src={p.thumbnailUrl} platform={p.platform} /></span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-small text-fg group-hover:underline group-hover:underline-offset-4">{p.hook ? `“${p.hook}”` : p.title}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-caption tabular text-fg-3">
                      <PlatformIcon platform={p.platform} size={12} />
                      {fmtDate(p.publishedAt, tz, { month: "short", day: "numeric" })} · {fmtCompact(p.views)} views
                    </span>
                    <span className="text-caption font-medium tabular text-success">{fmtX(p.x)} your normal</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-small text-fg-3">{w.scored ? "None of your recent posts ran well above your normal yet." : "Shows once your posts have numbers."}</p>
        )}
      </Panel>

      <div className="flex flex-col gap-4">
        <Panel title="Choices that beat your normal" id="winners" takeaway="Format, length, posting time and more, from the posts you have.">
          {w.winners.length || w.losers.length ? (
            <>
              {w.winners.length ? (
                <ul className="flex flex-col divide-y divide-border">
                  {w.winners.map((r) => <Finding key={`${r.dimension}:${r.value}`} r={r} good />)}
                </ul>
              ) : (
                <p className="text-small text-fg-3">Nothing clearly beats your normal yet.</p>
              )}
              {w.losers.length ? (
                <>
                  <h3 className="mt-5 text-caption font-medium text-fg-2">Running under your normal</h3>
                  <ul className="flex flex-col divide-y divide-border">
                    {w.losers.map((r) => <Finding key={`${r.dimension}:${r.value}`} r={r} good={false} />)}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-small text-fg-2">
              {w.needMore ? `Needs about ${w.needMore} more post${w.needMore === 1 ? "" : "s"} with 3 days of numbers before a pattern shows.` : `No choice has ${w.minN} posts behind it yet.`}
            </p>
          )}
        </Panel>

        <Panel
          title="Best time to post"
          id="heat"
          takeaway={best ? `${WEEKDAYS[best.day]} ${blockLabel(best.startHour, best.endHour)} is your strongest slot so far: ${fmt(best.shrunkX!)} your normal over ${best.n} posts.` : top ? "No time slot clearly beats your normal yet." : undefined}
        >
          {top ? (
            <>
              <Heatmap
                rows={[...WEEKDAYS]}
                cols={cols}
                cells={h.cells.map((c) => ({
                  day: c.day,
                  block: c.block,
                  n: c.n,
                  value: c.medianX,
                  shrunk: c.shrunkX,
                  evidence: c.evidence,
                  title: `${WEEKDAYS[c.day]} ${blockLabel(c.startHour, c.endHour)}: ${c.n} post${c.n === 1 ? "" : "s"}, typical ${c.medianX === null ? "–" : fmt(c.medianX)}`,
                }))}
                normal={h.overallMedian}
                format={fmt}
              />
              <div className="mt-4">
                <HeatLegend normalLabel={`your typical post (${h.overallMedian === null ? "1×" : fmt(h.overallMedian)})`} />
              </div>
              <p className="mt-3 text-caption text-fg-3">Times in {h.timeZone.replace(/_/g, " ")}. Slots with few posts are pulled toward your normal so one lucky post can&apos;t crown a slot.</p>
            </>
          ) : (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-small text-fg-2">
              Needs more posts: {h.n} so far, and no time slot has 3 yet. Keep posting at a few regular times and this fills in.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
