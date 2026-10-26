// Unfinished feature: What's working (which choices beat your typical post, with likely ranges). Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
import { XBar } from "@/components/charts";
import { cn } from "@/components/ui";
import { fmtX } from "@/components/content/format";
import type { FeatureRow } from "@/server/queries/insights";
import { DIMENSION_LABEL, featurePhrase, inlineValue, valueLabel } from "./labels";
import { fmtUnit, type Unit } from "./units";
import { VERDICT } from "./kit";

/**
 * What's working (attribution): per choice, the median outcome against the account's typical post, with the
 * likely range as whiskers. Bars are drawn as lift (1× = your typical post) whatever the metric, so every card reads the
 * same way. Thin samples are called out as gaps, never guessed.
 */

export const METRIC_UNIT: Record<string, Unit> = { x: "x", send_rate: "rate", follows_per_1k: "per1k" };
export const METRIC_LABEL: Record<string, string> = { x: "Result vs usual", send_rate: "Send rate", follows_per_1k: "Follows per 1k views" };

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const liftRange = (r: FeatureRow) => {
  if (r.lift === null || r.medianX === null || r.medianX === 0) return { lo: null, hi: null };
  const overall = r.medianX / r.lift;
  return { lo: r.ciLow === null ? null : r.ciLow / overall, hi: r.ciHigh === null ? null : r.ciHigh / overall };
};

function dimensionTakeaway(dimension: string, rows: FeatureRow[]): string {
  const ok = rows.filter((r) => r.sufficient && r.lift !== null);
  if (!ok.length) return "Too few posts to compare yet.";
  const best = ok.reduce((a, b) => ((b.lift ?? 0) > (a.lift ?? 0) ? b : a));
  const phrase = featurePhrase(dimension, best.value);
  const lead = `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
  if ((best.lift ?? 0) < 1.05) return `Nothing here beats your typical post yet. Closest: ${valueLabel(dimension, best.value)} at ${fmtX(best.lift)}.`;
  const verb = /(posts|hooks|videos|calls to action)$/.test(phrase) ? "run" : "runs";
  return `${lead} ${verb} ${fmtX(best.lift)} your typical post${best.verdict === "clear_win" ? ", clearly above it" : ", though the likely range still includes your usual"}.`;
}

function DimensionCard({ dimension, rows, max, minN, unit }: { dimension: string; rows: FeatureRow[]; max: number; minN: number; unit: Unit }) {
  const ok = rows.filter((r) => r.sufficient);
  const gaps = rows.filter((r) => !r.sufficient);
  return (
    <article className="flex flex-col rounded-lg border border-border bg-surface-1 p-5">
      <h3 className="text-h3 font-medium text-fg">{DIMENSION_LABEL[dimension] ?? dimension}</h3>
      <p className="mt-0.5 text-small text-fg-2">{dimensionTakeaway(dimension, rows)}</p>
      {ok.length ? (
        <ul className="mt-5 flex flex-col gap-3.5">
          {ok.map((r) => {
            const label = valueLabel(dimension, r.value);
            const { lo, hi } = liftRange(r);
            const v = VERDICT[r.verdict] ?? VERDICT.flat!;
            return (
              <li key={r.value}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-small text-fg" title={label}>
                    {label}
                  </span>
                  <span className="shrink-0 text-small tabular">
                    <span className="font-medium text-fg">{fmtX(r.lift)}</span>
                    <span className="text-caption text-fg-3">
                      {unit === "x" ? "" : ` · ${fmtUnit(r.medianX, unit)}`} · n={r.n}
                    </span>
                  </span>
                </div>
                <XBar
                  value={r.lift ?? 0}
                  ciLow={lo}
                  ciHigh={hi}
                  max={max}
                  title={`${label}: ${fmtX(r.lift)} your typical post over ${r.n} posts (median ${unit === "x" ? `${fmtX(r.medianX)} your normal` : fmtUnit(r.medianX, unit)})${lo !== null ? `, likely ${fmtX(lo)} to ${fmtX(hi)}` : ""}`}
                />
                <div className={cn("mt-0.5 text-[11px] leading-4", v.tone)}>
                  {v.label}
                  {lo !== null ? <span className="text-fg-3"> · likely {fmtX(lo)}–{fmtX(hi)}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {gaps.length ? (
        <p className={cn("text-caption text-fg-3", ok.length ? "mt-4 border-t border-border pt-3" : "mt-4")}>
          <span className="font-medium text-fg-2">Gap:</span> {listJoin(gaps.map((r) => `${inlineValue(dimension, r.value)} (${r.n} post${r.n === 1 ? "" : "s"})`))} {gaps.length === 1 ? "is" : "are"} too new to call. Each needs {minN} posts.
        </p>
      ) : null}
    </article>
  );
}

export function WhatsWorking({ dimensions, minN, metric }: { dimensions: { dimension: string; rows: FeatureRow[] }[]; minN: number; metric: string }) {
  const unit = METRIC_UNIT[metric] ?? "x";
  const lifts = dimensions.flatMap((d) => d.rows.filter((r) => r.sufficient).map((r) => Math.max(liftRange(r).hi ?? 0, r.lift ?? 0)));
  const max = Math.min(4, Math.max(2, ...lifts) * 1.05);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {dimensions.map((d) => (
        <DimensionCard key={d.dimension} dimension={d.dimension} rows={d.rows} max={max} minN={minN} unit={unit} />
      ))}
    </div>
  );
}

/** The clearest findings across every dimension, wins and losses at the same depth. */
export function Findings({ dimensions, metric }: { dimensions: { dimension: string; rows: FeatureRow[] }[]; metric: string }) {
  const unit = METRIC_UNIT[metric] ?? "x";
  const all = dimensions.flatMap((d) => d.rows.map((r) => ({ ...r, dimension: d.dimension })));
  const wins = all.filter((r) => r.verdict === "clear_win" || r.verdict === "leaning_up").sort((a, b) => Number(b.verdict === "clear_win") - Number(a.verdict === "clear_win") || (b.lift ?? 0) - (a.lift ?? 0)).slice(0, 3);
  const losses = all.filter((r) => r.verdict === "clear_loss" || r.verdict === "leaning_down").sort((a, b) => Number(b.verdict === "clear_loss") - Number(a.verdict === "clear_loss") || (a.lift ?? 9) - (b.lift ?? 9)).slice(0, 3);
  const item = (r: (typeof all)[number]) => {
    const p = featurePhrase(r.dimension, r.value);
    const v = VERDICT[r.verdict]!;
    return (
      <li key={`${r.dimension}:${r.value}`} className="flex items-baseline justify-between gap-4 py-2.5">
        <span className="min-w-0 text-small text-fg">
          {p.charAt(0).toUpperCase() + p.slice(1)}
          <span className={cn("ml-2 text-caption", v.tone)}>{v.label}</span>
        </span>
        <span className="shrink-0 text-small tabular text-fg-2">
          <span className="font-medium text-fg">{fmtX(r.lift)}</span> · {unit === "x" ? "" : `${fmtUnit(r.medianX, unit)} · `}n={r.n}
        </span>
      </li>
    );
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border border-border bg-surface-1 p-5">
        <h3 className="text-small font-medium text-fg">Lifting results</h3>
        {wins.length ? <ul className="mt-1 divide-y divide-border">{wins.map(item)}</ul> : <p className="mt-2 text-small text-fg-3">No choice stands clearly above your typical post yet.</p>}
      </section>
      <section className="rounded-lg border border-border bg-surface-1 p-5">
        <h3 className="text-small font-medium text-fg">Holding results back</h3>
        {losses.length ? <ul className="mt-1 divide-y divide-border">{losses.map(item)}</ul> : <p className="mt-2 text-small text-fg-3">No choice stands clearly below your typical post.</p>}
      </section>
    </div>
  );
}

export function XLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-fg-3">
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="h-2 w-5 rounded-[2px] bg-brand" /> Above your typical post
      </span>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="h-2 w-5 rounded-[2px] bg-fg-2" /> Below it
      </span>
      <span className="inline-flex items-center gap-2">
        <svg width="20" height="10" aria-hidden>
          <g stroke="var(--text-primary)" strokeOpacity={0.7}>
            <line x1="2" x2="18" y1="5" y2="5" />
            <line x1="2" x2="2" y1="1" y2="9" />
            <line x1="18" x2="18" y1="1" y2="9" />
          </g>
        </svg>
        Likely range
      </span>
      <span className="inline-flex items-center gap-2">
        <svg width="10" height="12" aria-hidden>
          <line x1="5" x2="5" y1="0" y2="12" stroke="var(--border-strong)" strokeDasharray="2 2" />
        </svg>
        1× is your typical post
      </span>
    </div>
  );
}
