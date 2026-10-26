/**
 * Small, crisp inline SVG charts (DESIGN §9). Primary series `--brand`, comparison `--text-secondary`, further series
 * `--info`, `--accent-gold`, `--success`; never more than five. Gridlines `--border` at 50%, axes in caption/muted.
 * Every mark carries a <title> so hover shows the value.
 */
import type { ReactNode } from "react";
import { cn } from "@/components/ui";

export const SERIES_COLORS = ["var(--brand)", "var(--text-secondary)", "var(--info)", "var(--accent-gold)", "var(--success)"] as const;

// ---------------------------------------------------------------------------------------------------------------
// Sparkline: a 2px line with the Signal as its leading point.
// ---------------------------------------------------------------------------------------------------------------

export function Sparkline({
  values,
  width = 88,
  height = 24,
  className,
  tone = "brand",
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  tone?: "brand" | "secondary";
  label?: string;
}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }
  const min = Math.min(...v);
  const max = Math.max(...v);
  const pad = 3;
  const span = max - min || 1;
  const pts = v.map((y, i) => [pad + (i * (width - pad * 2)) / (v.length - 1), height - pad - ((y - min) / span) * (height - pad * 2)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  const color = tone === "brand" ? "var(--brand)" : "var(--text-secondary)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("overflow-visible", className)} role="img" aria-label={label ?? "Trend"}>
      {label ? <title>{label}</title> : null}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={tone === "brand" ? 0.9 : 1} />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// XBar: one row of a "median x with CI whiskers" chart, against the 1× own-baseline rule.
// ---------------------------------------------------------------------------------------------------------------

export function XBar({
  value,
  ciLow,
  ciHigh,
  max,
  muted,
  title,
  height = 20,
}: {
  value: number;
  ciLow?: number | null;
  ciHigh?: number | null;
  /** Domain upper bound (e.g. the largest ci_high across rows). */
  max: number;
  muted?: boolean;
  title?: string;
  height?: number;
}) {
  const W = 100;
  const x = (n: number) => Math.max(0, Math.min(W, (n / max) * W));
  const barH = 8;
  const y = (height - barH) / 2;
  const fill = muted ? "var(--text-muted)" : value >= 1 ? "var(--brand)" : "var(--text-secondary)";
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="h-5 w-full overflow-visible" role="img" aria-label={title}>
      {title ? <title>{title}</title> : null}
      <rect x={0} y={y} width={Math.max(0.6, x(value))} height={barH} rx={1.2} fill={fill} opacity={muted ? 0.45 : 0.92} />
      {ciLow != null && ciHigh != null ? (
        <g stroke="var(--text-primary)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.7}>
          <line x1={x(ciLow)} x2={x(ciHigh)} y1={height / 2} y2={height / 2} vectorEffect="non-scaling-stroke" />
          <line x1={x(ciLow)} x2={x(ciLow)} y1={height / 2 - 4} y2={height / 2 + 4} vectorEffect="non-scaling-stroke" />
          <line x1={x(ciHigh)} x2={x(ciHigh)} y1={height / 2 - 4} y2={height / 2 + 4} vectorEffect="non-scaling-stroke" />
        </g>
      ) : null}
      <line x1={x(1)} x2={x(1)} y1={0} y2={height} stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Meter: spend vs budget, a thin track with the fill and a limit tick.
// ---------------------------------------------------------------------------------------------------------------

export function Meter({ value, max, title, className }: { value: number; max: number; title?: string; className?: string }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const tone = pct >= 1 ? "var(--danger)" : pct >= 0.8 ? "var(--warning)" : "var(--brand)";
  return (
    <div className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} title={title}>
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(pct * 100, value > 0 ? 1.5 : 0)}%`, background: tone }} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// LineChart: 2px strokes, no area fill, the Signal as the primary series' leading point.
// ---------------------------------------------------------------------------------------------------------------

export type LineSeries = { label: string; values: (number | null)[]; color?: string; dashed?: boolean };

export function LineChart({
  series,
  labels,
  height = 180,
  format = (n) => String(n),
  target,
  draw = false,
  className,
}: {
  series: LineSeries[];
  labels: string[];
  height?: number;
  format?: (n: number) => string;
  /** Optional horizontal goal line. */
  target?: { value: number; label: string };
  /** Draw left to right on mount (the briefing reveal). */
  draw?: boolean;
  className?: string;
}) {
  const W = 640;
  const H = height;
  const padL = 36;
  const padR = 16;
  const padT = 12;
  const padB = 24;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (target) all.push(target.value);
  const maxV = Math.max(1, ...all) * 1.12;
  const n = Math.max(2, labels.length);
  const px = (i: number) => padL + (i * (W - padL - padR)) / (n - 1);
  const py = (v: number) => padT + (1 - v / maxV) * (H - padT - padB);
  const ticks = niceTicks(maxV, 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("h-auto w-full overflow-visible", className)} role="img" aria-label={series.map((s) => s.label).join(", ")}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - padR} y1={py(t)} y2={py(t)} stroke="var(--border)" strokeOpacity={0.5} />
          <text x={padL - 8} y={py(t) + 4} textAnchor="end" className="fill-fg-3 text-[11px] tabular">
            {format(t)}
          </text>
        </g>
      ))}
      {labels.map((l, i) =>
        i % Math.ceil(labels.length / 8) === 0 || i === labels.length - 1 ? (
          <text key={i} x={px(i)} y={H - 6} textAnchor="middle" className="fill-fg-3 text-[11px]">
            {l}
          </text>
        ) : null,
      )}
      {target ? (
        <g>
          <line x1={padL} x2={W - padR} y1={py(target.value)} y2={py(target.value)} stroke="var(--accent-gold)" strokeDasharray="4 4" strokeOpacity={0.8} />
          <text x={W - padR} y={py(target.value) - 6} textAnchor="end" className="fill-fg-2 text-[11px]">
            {target.label}
          </text>
        </g>
      ) : null}
      {series.map((s, si) => {
        const color = s.color ?? SERIES_COLORS[si] ?? "var(--text-secondary)";
        const pts = s.values.map((v, i) => (v == null ? null : ([px(i), py(v), v, i] as const))).filter((p): p is readonly [number, number, number, number] => p !== null);
        if (!pts.length) return null;
        const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
        const last = pts[pts.length - 1]!;
        return (
          <g key={s.label}>
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={s.dashed ? "4 4" : undefined}
              pathLength={draw && !s.dashed ? 1 : undefined}
              className={draw && !s.dashed ? "chart-draw" : undefined}
            />
            {pts.map(([x, y, v, i]) => (
              <circle key={i} cx={x} cy={y} r={8} fill="transparent">
                <title>{`${labels[i] ?? ""}: ${format(v)} ${s.label.toLowerCase()}`}</title>
              </circle>
            ))}
            {si === 0 ? (
              <g className={draw ? "chart-draw-dot" : undefined}>
                <circle cx={last[0]} cy={last[1]} r={4} fill={color} />
                <circle cx={last[0]} cy={last[1]} r={4} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={6} />
              </g>
            ) : null}
          </g>
        );
      })}
      <style>{`
        .chart-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: chart-draw 1.4s cubic-bezier(0.16,1,0.3,1) 0.35s forwards; }
        .chart-draw-dot { opacity: 0; animation: chart-dot 0.3s ease-out 1.6s forwards; }
        @keyframes chart-draw { to { stroke-dashoffset: 0; } }
        @keyframes chart-dot { to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .chart-draw { animation: none; stroke-dashoffset: 0; } .chart-draw-dot { animation: none; opacity: 1; } }
      `}</style>
    </svg>
  );
}

function niceTicks(max: number, count: number): number[] {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = 0; t <= max; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ColumnChart: vertical bars, rounded top corners only.
// ---------------------------------------------------------------------------------------------------------------

export function ColumnChart({
  values,
  labels,
  height = 120,
  format = (n) => String(n),
  highlightLast = true,
  className,
}: {
  values: number[];
  labels: string[];
  height?: number;
  format?: (n: number) => string;
  highlightLast?: boolean;
  className?: string;
}) {
  const W = 320;
  const H = height;
  const padB = 20;
  const max = Math.max(1, ...values);
  const gap = 6;
  const bw = (W - gap * (values.length - 1)) / Math.max(1, values.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("h-auto w-full", className)} role="img">
      <line x1={0} x2={W} y1={H - padB} y2={H - padB} stroke="var(--border)" />
      {values.map((v, i) => {
        const h = (v / max) * (H - padB - 8);
        const x = i * (bw + gap);
        const y = H - padB - h;
        const r = Math.min(4, bw / 2, h);
        const color = highlightLast && i === values.length - 1 ? "var(--brand)" : "var(--text-secondary)";
        return (
          <g key={i}>
            <path d={`M${x} ${H - padB} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + bw - r} Q${x + bw} ${y} ${x + bw} ${y + r} V${H - padB} Z`} fill={color} opacity={i === values.length - 1 ? 1 : 0.55}>
              <title>{`${labels[i] ?? ""}: ${format(v)}`}</title>
            </path>
            <text x={x + bw / 2} y={H - 5} textAnchor="middle" className="fill-fg-3 text-[10px]">
              {labels[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A one-sentence takeaway above every chart (DESIGN §9). */
export function Takeaway({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-small text-fg-2">{children}</p>;
}
