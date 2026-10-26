import type { Metadata } from "next";
import { blockLabel, WEEKDAYS } from "@attentionos/scoring";
import { EmphasisBars, HeatLegend, Heatmap } from "@/components/charts/analytics";
import { platformLabel } from "@/components/content/format";
import { Gap, Panel } from "@/components/insights/kit";
import { Segmented } from "@/components/insights/nav";
import { fmtUnit, type Unit } from "@/components/insights/units";
import { getSlots } from "@/server/queries/insights";
import { workspace } from "@/server/workspace";

export const metadata: Metadata = { title: "When to post · Insights" };
export const dynamic = "force-dynamic";

const METRICS = { x: { unit: "x" as Unit, label: "Result vs usual" }, send_rate: { unit: "rate" as Unit, label: "Send rate" }, follows_per_1k: { unit: "per1k" as Unit, label: "Follows per 1k" } };
const EVIDENCE: Record<string, string> = { high: "strong evidence", medium: "some evidence", low: "a hunch", none: "no posts" };

export default async function TimingPage({ searchParams }: { searchParams: Promise<{ metric?: string; platform?: string }> }) {
  const sp = await searchParams;
  const metric = (sp.metric && sp.metric in METRICS ? sp.metric : "x") as keyof typeof METRICS;
  const ws = workspace();
  const platforms = ws.config.platforms;
  const platform = sp.platform && (platforms as readonly string[]).includes(sp.platform) ? sp.platform : null;
  const h = await getSlots(metric, platform);
  const unit = METRICS[metric].unit;
  const fmt = (n: number) => fmtUnit(n, unit);
  const cols = Array.from({ length: 24 / h.blockHours }, (_, b) => blockLabel(b * h.blockHours, (b + 1) * h.blockHours));
  const cells = h.cells.map((c) => ({
    day: c.day,
    block: c.block,
    n: c.n,
    value: c.medianX,
    shrunk: c.shrunkX,
    evidence: c.evidence,
    title: `${WEEKDAYS[c.day]} ${blockLabel(c.startHour, c.endHour)}: ${c.n} post${c.n === 1 ? "" : "s"}, median ${c.medianX === null ? "–" : fmt(c.medianX)}, adjusted ${c.shrunkX === null ? "–" : fmt(c.shrunkX)} (${EVIDENCE[c.evidence]})`,
  }));
  const best = h.best[0];
  const takeaway = best
    ? `${WEEKDAYS[best.day]} ${blockLabel(best.startHour, best.endHour)} is your strongest slot: ${fmt(best.shrunkX!)} over ${best.n} posts${h.overallMedian !== null ? ` against a typical ${fmt(h.overallMedian)}` : ""}.`
    : "No time slot has enough posts to call yet.";
  const days = [...h.byDay].filter((d) => d.n > 0);
  const blocks = [...h.byBlock].filter((b) => b.n > 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h2 font-medium text-fg">When to post</h2>
          <p className="max-w-[68ch] text-small text-fg-2">
            {h.n} settled post{h.n === 1 ? "" : "s"} from the last 120 days by day and time ({h.timeZone.replace(/_/g, " ")}). Slots with few posts are pulled toward your normal, so one lucky post can&apos;t crown a slot.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Segmented param="metric" label="Outcome" current={metric} options={[{ value: "x", label: "Result" }, { value: "send_rate", label: "Send rate" }, { value: "follows_per_1k", label: "Follows" }]} />
          <Segmented param="platform" label="Platform" current={platform ?? "all"} options={[{ value: "all", label: "All" }, ...platforms.filter((p) => p !== "linkedin" || platform === p).map((p) => ({ value: p, label: platformLabel(p) }))]} />
        </div>
      </div>

      <Panel title="Day and time" takeaway={takeaway} id="heat">
        {h.n ? (
          <>
            <Heatmap rows={[...WEEKDAYS]} cols={cols} cells={cells} normal={h.overallMedian} format={fmt} />
            <div className="mt-4">
              <HeatLegend normalLabel={`your typical post (${h.overallMedian === null ? "–" : fmt(h.overallMedian)})`} />
            </div>
          </>
        ) : null}
        {h.gaps.length ? <div className="mt-4 flex flex-col gap-2">{h.gaps.map((g) => <Gap key={g}>{g}</Gap>)}</div> : null}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Best slots" id="best" takeaway="Only slots with enough posts, best adjusted result first.">
          {h.best.length ? (
            <ol className="flex flex-col divide-y divide-border">
              {h.best.map((c, i) => (
                <li key={`${c.day}-${c.block}`} className="flex items-baseline justify-between gap-3 py-3 first:pt-0">
                  <span className="text-small text-fg">
                    <span className="mr-2 text-fg-3 tabular">{i + 1}</span>
                    {WEEKDAYS[c.day]} {blockLabel(c.startHour, c.endHour)}
                  </span>
                  <span className="text-right text-small tabular text-fg-2">
                    <span className="font-medium text-fg">{fmt(c.shrunkX!)}</span> · n={c.n}
                    <span className="block text-caption text-fg-3">{c.ciLow !== null ? `likely ${fmt(c.ciLow)}–${fmt(c.ciHigh!)}` : EVIDENCE[c.evidence]}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <Gap>No slot has enough posts yet.</Gap>
          )}
        </Panel>
        <Panel title="By day" id="days">
          <EmphasisBars
            rows={days.map((d) => ({ key: d.label, label: d.label, value: d.shrunkX, hint: `n=${d.n} · ${EVIDENCE[d.evidence]}`, highlight: d.shrunkX !== null && h.overallMedian !== null && d.shrunkX >= h.overallMedian * 1.1 && d.evidence !== "low" }))}
            format={fmt}
            refValue={h.overallMedian}
            refLabel="Your typical post"
          />
        </Panel>
        <Panel title="By time of day" id="blocks">
          <EmphasisBars
            rows={blocks.map((b) => ({ key: b.label, label: b.label, value: b.shrunkX, hint: `n=${b.n} · ${EVIDENCE[b.evidence]}`, highlight: b.shrunkX !== null && h.overallMedian !== null && b.shrunkX >= h.overallMedian * 1.1 && b.evidence !== "low" }))}
            format={fmt}
            refValue={h.overallMedian}
            refLabel="Your typical post"
          />
        </Panel>
      </div>
      <p className="text-caption text-fg-3">
        Adjusted = the slot&apos;s median blended with your typical result as if it had a few extra typical posts, so small slots stay close to normal until they earn it. The vertical rule in the bars is your typical post.
      </p>
    </div>
  );
}
