/**
 * Server-rendered analytics marks for Insights (DESIGN §9): the posting-time heatmap, emphasis bars, funnel steps
 * and the goal pace bar. Plain HTML/SVG, tokens only, every value reachable as text (title or label), never by color alone.
 */
import type { ReactNode } from "react";
import { cn } from "@/components/ui";

// ---------------------------------------------------------------------------------------------------------------
// Heatmap: day × time block. One hue (brand), stepped by how far above the account's normal a slot sits; slots at
// or below normal stay neutral. Thin evidence is drawn hollow, so a single lucky post never looks like a finding.
// ---------------------------------------------------------------------------------------------------------------

export type HeatCell = { day: number; block: number; n: number; value: number | null; shrunk: number | null; evidence: "none" | "low" | "medium" | "high"; title: string };

export function heatTone(shrunk: number | null, normal: number | null): { bg: string; strong: boolean } {
  if (shrunk === null || normal === null || normal <= 0) return { bg: "transparent", strong: false };
  const r = shrunk / normal;
  if (r >= 1.5) return { bg: "color-mix(in srgb, var(--brand) 72%, var(--surface-1))", strong: true };
  if (r >= 1.25) return { bg: "color-mix(in srgb, var(--brand) 48%, var(--surface-1))", strong: true };
  if (r >= 1.08) return { bg: "color-mix(in srgb, var(--brand) 26%, var(--surface-1))", strong: false };
  if (r > 0.92) return { bg: "var(--surface-3)", strong: false };
  return { bg: "color-mix(in srgb, var(--text-muted) 16%, var(--surface-1))", strong: false };
}

export function Heatmap({
  rows,
  cols,
  cells,
  normal,
  format,
}: {
  rows: string[];
  cols: string[];
  cells: HeatCell[];
  normal: number | null;
  format: (n: number) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-[3px] text-caption" aria-label="Results by posting day and time">
        <thead>
          <tr>
            <th scope="col" className="w-12" />
            {cols.map((c) => (
              <th key={c} scope="col" className="pb-1 text-center font-normal text-fg-3">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, day) => (
            <tr key={r}>
              <th scope="row" className="pr-2 text-left font-normal text-fg-3">
                {r}
              </th>
              {cols.map((_, block) => {
                const c = cells.find((x) => x.day === day && x.block === block);
                if (!c || c.n === 0) return <td key={block} className="h-11 rounded-[6px] bg-surface-2/50" title={`${r} ${cols[block]}: no posts`} />;
                const tone = heatTone(c.shrunk, normal);
                const thin = c.evidence === "low";
                return (
                  <td
                    key={block}
                    title={c.title}
                    className={cn("h-11 rounded-[6px] px-1 text-center align-middle tabular transition-[outline] duration-100 hover:outline hover:outline-1 hover:outline-border-strong", thin && "outline-dashed outline-1 -outline-offset-1 outline-border-strong")}
                    style={{ background: thin ? "transparent" : tone.bg }}
                  >
                    <span className={cn("block text-[12px] leading-4", tone.strong && !thin ? "font-medium text-fg" : "text-fg-2")}>{c.shrunk === null ? "–" : format(c.shrunk)}</span>
                    <span className="block text-[10px] leading-3 text-fg-3">n={c.n}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HeatLegend({ normalLabel }: { normalLabel: string }) {
  const sw = (bg: string, extra?: string) => <span aria-hidden className={cn("inline-block h-3 w-5 rounded-[3px]", extra)} style={{ background: bg }} />;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-fg-3">
      <span className="inline-flex items-center gap-1.5">
        {sw("color-mix(in srgb, var(--text-muted) 16%, var(--surface-1))")}
        {sw("var(--surface-3)")}
        {sw("color-mix(in srgb, var(--brand) 26%, var(--surface-1))")}
        {sw("color-mix(in srgb, var(--brand) 48%, var(--surface-1))")}
        {sw("color-mix(in srgb, var(--brand) 72%, var(--surface-1))")}
        <span className="ml-1">below → above {normalLabel}</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        {sw("transparent", "outline-dashed outline-1 -outline-offset-1 outline-border-strong")} Too few posts to call
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Emphasis bars: one row per entity, the highlighted one in brand, the rest neutral. Value label outside the bar.
// ---------------------------------------------------------------------------------------------------------------

export function EmphasisBars({ rows, format, refValue, refLabel }: { rows: { key: string; label: ReactNode; value: number | null; hint?: ReactNode; highlight?: boolean }[]; format: (n: number) => string; refValue?: number | null; refLabel?: string }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value ?? 0), refValue ?? 0) * 1.06;
  return (
    <ul className="flex flex-col gap-3.5">
      {rows.map((r) => (
        <li key={r.key} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className={cn("min-w-0 truncate text-small", r.highlight ? "font-medium text-fg" : "text-fg-2")}>{r.label}</span>
            <span className={cn("shrink-0 text-small tabular", r.highlight ? "font-medium text-fg" : "text-fg-2")}>{r.value === null ? "–" : format(r.value)}</span>
          </div>
          <div className="relative mt-1.5 h-2 rounded-full bg-surface-2">
            {r.value !== null ? (
              <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: r.highlight ? "var(--brand)" : "var(--text-secondary)", opacity: r.highlight ? 1 : 0.55 }} />
            ) : null}
            {refValue ? <div aria-hidden className="absolute -inset-y-1 w-px bg-fg-2" style={{ left: `${(refValue / max) * 100}%` }} title={refLabel} /> : null}
          </div>
          {r.hint ? <div className="mt-1 text-caption text-fg-3">{r.hint}</div> : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Funnel steps: people at each step, % of the step before and of the top, a pale ghost for who was lost, the final
// step in brand and the biggest drop called out.
// ---------------------------------------------------------------------------------------------------------------

export function FunnelSteps({ steps, dropKey, format }: { steps: { key: string; label: string; value: number | null; fromPrevious: number | null; fromTop: number | null }[]; dropKey: string | null; format: (n: number, key: string) => string }) {
  const shown = steps.filter((s) => s.value !== null);
  const top = Math.max(1, shown[0]?.value ?? 1);
  // Log scale keeps 20,000 views and 3 bookings on one readable chart; widths are labelled with real numbers.
  const width = (v: number) => (v <= 0 ? 0 : Math.max(2, (Math.log10(v + 1) / Math.log10(top + 1)) * 100));
  return (
    <ol className="flex flex-col gap-4">
      {steps.map((s, i) => {
        const last = i === shown.length - 1;
        const prev = i > 0 ? steps[i - 1]!.value : null;
        return (
          <li key={s.key}>
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <span className="text-small text-fg">
                {s.label}
                {s.key === dropKey ? <span className="ml-2 text-caption text-warning">Biggest drop</span> : null}
              </span>
              <span className="text-small tabular text-fg-2">
                {s.value === null ? <span className="text-fg-3">Not connected</span> : <span className="font-medium text-fg">{format(s.value, s.key)}</span>}
                {s.fromPrevious !== null ? <span className="text-fg-3"> · {pctText(s.fromPrevious)} of {steps[i - 1]!.label.toLowerCase()}</span> : null}
              </span>
            </div>
            <div className="relative h-3 rounded-[4px] bg-surface-2">
              {prev !== null && s.value !== null ? <div aria-hidden className="absolute inset-y-0 left-0 rounded-[4px] bg-fg-3/15" style={{ width: `${width(prev)}%` }} /> : null}
              {s.value !== null ? <div aria-hidden className="absolute inset-y-0 left-0 rounded-[4px]" style={{ width: `${width(s.value)}%`, background: last ? "var(--brand)" : "var(--text-secondary)", opacity: last ? 1 : 0.6 }} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function pctText(v: number) {
  const p = v * 100;
  return `${p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

// ---------------------------------------------------------------------------------------------------------------
// Pace bar: the week so far against the target, a tick where a straight line to the target would be today, and the
// projected landing point.
// ---------------------------------------------------------------------------------------------------------------

export function PaceBar({ actual, target, expected, projected, direction = "up", label }: { actual: number; target: number; expected: number | null; projected: number | null; direction?: "up" | "down"; label: string }) {
  const max = Math.max(target, actual, projected ?? 0) * 1.08 || 1;
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const met = direction === "up" ? actual >= target : actual <= target;
  return (
    <div className="relative pt-5 pb-1" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={target} aria-valuenow={actual}>
      <div className="relative h-2 rounded-full bg-surface-2">
        {projected !== null && projected > actual ? <div aria-hidden className="absolute inset-y-0 left-0 rounded-full bg-brand/20" style={{ width: pct(projected) }} /> : null}
        <div aria-hidden className={cn("absolute inset-y-0 left-0 rounded-full", met ? "bg-success" : "bg-brand")} style={{ width: pct(actual) }} />
      </div>
      {expected !== null && expected > 0 && expected < target ? (
        <div aria-hidden className="absolute bottom-0 top-4 w-px bg-fg-2" style={{ left: pct(expected) }} title="Where a steady pace would be today" />
      ) : null}
      <div aria-hidden className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[11px] leading-4 text-fg-3" style={{ left: `min(${pct(target)}, calc(100% - 1.5rem))` }}>
        Goal
      </div>
      <div aria-hidden className="absolute bottom-0 top-4 w-0.5 -translate-x-1/2 rounded-full bg-gold" style={{ left: pct(target) }} />
    </div>
  );
}
