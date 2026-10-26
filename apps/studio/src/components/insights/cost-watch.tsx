import { ColumnChart, Meter, Takeaway } from "@/components/charts";
import { fmtUsd, humanize } from "@/components/content/format";
import type { CostWatch as CostWatchData } from "@/server/queries/insights";

export function CostWatch({ data, dailyBudget }: { data: CostWatchData; dailyBudget: number }) {
  const days = data.daily;
  const avg = days.length ? days.reduce((s, d) => s + d.usd, 0) / days.length : 0;
  const labels = days.map((d, i) => (i === days.length - 1 || (i % 3 === 0 && i < days.length - 2) ? `${Number(d.day.slice(8))}` : ""));
  const over = data.lines.filter((l) => l.budget !== null && l.spent >= l.budget);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <div className="rounded-lg border border-border bg-surface-1 p-5 sm:p-6">
        <ul className="flex flex-col gap-5">
          {data.lines.map((l) => {
            const share = l.budget ? l.spent / l.budget : null;
            return (
              <li key={l.category}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-small text-fg">
                    {l.label} <span className="text-fg-3">· {l.period === "day" ? "today" : "this month"}</span>
                  </span>
                  <span className="text-small tabular text-fg">
                    {fmtUsd(l.spent)}
                    {l.budget !== null ? <span className="text-fg-3"> of {fmtUsd(l.budget, { cents: false })}</span> : <span className="text-fg-3"> · no cap</span>}
                  </span>
                </div>
                {l.budget !== null ? (
                  <Meter className="mt-2" value={l.spent} max={l.budget} title={`${Math.round((share ?? 0) * 100)}% of the budget`} />
                ) : (
                  <div className="mt-2 h-1.5 rounded-full bg-surface-2" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-6 flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-4 text-small">
          <span className="text-fg-2">All spend this month</span>
          <span className="tabular text-fg">
            {fmtUsd(data.monthTotal)}
            {data.byCategoryMonth.length ? (
              <span className="text-fg-3"> · {data.byCategoryMonth.map((c) => `${c.category === "llm" ? "AI" : humanize(c.category)} ${fmtUsd(c.spent)}`).join(", ")}</span>
            ) : null}
          </span>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-surface-1 p-5 sm:p-6">
        <h3 className="text-small font-medium text-fg">AI spend per day</h3>
        <Takeaway>
          {over.length
            ? `${over.map((o) => o.label).join(" and ")} hit the cap. Jobs that spend on it pause until it resets.`
            : `Averaging ${fmtUsd(avg)} a day over two weeks, ${avg < dailyBudget * 0.5 ? "well under" : "under"} the ${fmtUsd(dailyBudget, { cents: false })} daily cap.`}
        </Takeaway>
        <ColumnChart values={days.map((d) => d.usd)} labels={labels} height={132} format={(n) => fmtUsd(n)} />
        <p className="mt-2 text-caption text-fg-3">Last 14 days by date. Today is the highlighted bar.</p>
      </div>
    </div>
  );
}
