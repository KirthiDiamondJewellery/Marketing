"use client";
import { useEffect, useId, useRef, useState } from "react";
import { fmtAxis, fmtUnit, type Unit } from "@/components/insights/units";

/**
 * The Insights line chart (DESIGN §9): drawn at its real pixel width so 11px axis text stays 11px on a phone and a wide
 * screen. One y-axis only. 2px strokes, no area fill under lines; the optional "normal" band is a quiet range shade.
 * The primary series ends on the Signal dot. Crosshair + tooltip on hover, and ←/→ step through points from the keyboard.
 */

export type TrendSeries = { label: string; values: (number | null)[]; color?: string; dashed?: boolean };

export function TrendChart({
  labels,
  series,
  band,
  bandLabel = "Your normal range",
  target,
  height = 220,
  unit = "number",
  tooltipLabels,
  draw = false,
  yMin,
  yMax,
  ariaLabel,
}: {
  labels: string[];
  series: TrendSeries[];
  band?: { low: (number | null)[]; high: (number | null)[] };
  bandLabel?: string;
  target?: { value: number; label: string } | null;
  height?: number;
  /** How values are written on the axis and in the tooltip (a unit, so server components can pass it). */
  unit?: Unit;
  /** Longer labels for the tooltip (defaults to `labels`). */
  tooltipLabels?: string[];
  draw?: boolean;
  /** Lower bound of the y-axis (default 0; pass "auto" to zoom to the data when it sits far from zero). */
  yMin?: number | "auto";
  /** Fixed upper bound (e.g. 1 for shares of an audience). */
  yMax?: number;
  ariaLabel: string;
}) {
  const format = (n: number) => fmtUnit(n, unit);
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const clip = useId().replace(/:/g, "");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const padL = 44;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const values = [...series.flatMap((s) => s.values), ...(band ? [...band.low, ...band.high] : []), ...(target ? [target.value] : [])].filter((v): v is number => v !== null && Number.isFinite(v));
  const dataMax = Math.max(1e-9, ...values);
  const dataMin = values.length ? Math.min(...values) : 0;
  // Zoom to the data band for slowly moving levels (e.g. follower counts); otherwise start at zero.
  const zoom = yMin === "auto" && dataMin > 0.6 * dataMax;
  const lo = typeof yMin === "number" ? yMin : zoom ? dataMin - (dataMax - dataMin) * 0.25 : 0;
  const ticks = niceTicks(lo, yMax ?? dataMax + (dataMax - lo) * 0.08, 4);
  const top = ticks[ticks.length - 1]!;
  const bottom = ticks[0]!;
  const n = Math.max(2, labels.length);
  const px = (i: number) => padL + (i * (w - padL - padR)) / (n - 1);
  const py = (v: number) => padT + (1 - (v - bottom) / (top - bottom || 1)) * (H - padT - padB);
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((w - padL) / 72))));

  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const bandPath = () => {
    if (!band) return "";
    const idx = band.low.map((v, i) => (v !== null && band.high[i] !== null ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) return "";
    const upper = idx.map((i, k) => `${k ? "L" : "M"}${px(i).toFixed(1)} ${py(band.high[i]!).toFixed(1)}`).join("");
    const lower = [...idx].reverse().map((i) => `L${px(i).toFixed(1)} ${py(band.low[i]!).toFixed(1)}`).join("");
    return `${upper}${lower}Z`;
  };
  const primary = series[0];
  const lastIdx = primary ? primary.values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).pop() : undefined;
  const tips = tooltipLabels ?? labels;

  const onMove = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    const x = clientX - r.left;
    const i = Math.round(((x - padL) / (w - padL - padR)) * (n - 1));
    setHover(Math.max(0, Math.min(labels.length - 1, i)));
  };

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height: H }}>
      {w > 0 ? (
        <svg
          width={w}
          height={H}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          className="outline-none focus-visible:ring-2 focus-visible:ring-brand/60 rounded-md"
          onMouseMove={(e) => onMove(e.clientX, e.currentTarget)}
          onMouseLeave={() => setHover(null)}
          onTouchStart={(e) => onMove(e.touches[0]!.clientX, e.currentTarget)}
          onTouchMove={(e) => onMove(e.touches[0]!.clientX, e.currentTarget)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setHover((h) => Math.min(labels.length - 1, (h ?? -1) + 1));
            else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? labels.length) - 1));
            else if (e.key === "Escape") setHover(null);
            else return;
            e.preventDefault();
          }}
        >
          <defs>
            <clipPath id={`c${clip}`}>
              <rect x={padL} y={0} width={Math.max(0, w - padL - padR)} height={H - padB + 1} />
            </clipPath>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={py(t)} y2={py(t)} stroke="var(--border)" strokeOpacity={0.5} />
              <text x={padL - 8} y={py(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)" className="tabular">
                {fmtAxis(t, unit, top)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            (labels.length - 1 - i) % every === 0 ? (
              <text key={i} x={px(i)} y={H - 7} textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"} fontSize={11} fill="var(--text-muted)">
                {l}
              </text>
            ) : null,
          )}
          <g clipPath={`url(#c${clip})`}>
            {band ? <path d={bandPath()} fill="var(--text-secondary)" fillOpacity={0.12} stroke="none" /> : null}
            {target ? (
              <g>
                <line x1={padL} x2={w - padR} y1={py(target.value)} y2={py(target.value)} stroke="var(--accent-gold)" strokeDasharray="4 4" strokeOpacity={0.85} />
                <text x={w - padR - 2} y={py(target.value) - 6} textAnchor="end" fontSize={11} fill="var(--text-secondary)">
                  {target.label}
                </text>
              </g>
            ) : null}
            {series.map((s, si) => (
              <path
                key={s.label}
                d={path(s.values)}
                fill="none"
                stroke={s.color ?? (si === 0 ? "var(--brand)" : "var(--text-secondary)")}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={s.dashed ? "4 4" : undefined}
                pathLength={draw && si === 0 ? 1 : undefined}
                className={draw && si === 0 ? "trend-draw" : undefined}
              />
            ))}
          </g>
          {hover !== null ? (
            <g pointerEvents="none">
              <line x1={px(hover)} x2={px(hover)} y1={padT} y2={H - padB} stroke="var(--border-strong)" />
              {series.map((s, si) => {
                const v = s.values[hover];
                return v === null || v === undefined ? null : (
                  <circle key={s.label} cx={px(hover)} cy={py(v)} r={4} fill={s.color ?? (si === 0 ? "var(--brand)" : "var(--text-secondary)")} stroke="var(--surface-1)" strokeWidth={2} />
                );
              })}
            </g>
          ) : primary && lastIdx !== undefined && primary.values[lastIdx] != null ? (
            <g className={draw ? "trend-dot" : undefined} pointerEvents="none">
              <circle cx={px(lastIdx)} cy={py(primary.values[lastIdx]!)} r={4} fill={primary.color ?? "var(--brand)"} />
              <circle cx={px(lastIdx)} cy={py(primary.values[lastIdx]!)} r={4} fill="none" stroke={primary.color ?? "var(--brand)"} strokeOpacity={0.35} strokeWidth={6} />
            </g>
          ) : null}
          <style>{`
            .trend-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: trend-draw 1.4s cubic-bezier(0.16,1,0.3,1) 0.3s forwards; }
            .trend-dot { opacity: 0; animation: trend-dot 0.3s ease-out 1.5s forwards; }
            @keyframes trend-draw { to { stroke-dashoffset: 0; } }
            @keyframes trend-dot { to { opacity: 1; } }
            @media (prefers-reduced-motion: reduce) { .trend-draw { animation: none; stroke-dashoffset: 0; } .trend-dot { animation: none; opacity: 1; } }
          `}</style>
        </svg>
      ) : null}
      {hover !== null && w > 0 ? (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 min-w-[140px] rounded-md border border-border bg-surface-3 px-3 py-2 text-caption shadow-[0_12px_32px_rgba(21,16,26,0.18)]"
          style={{ left: Math.min(Math.max(0, px(hover) + 12), w - 160), transform: px(hover) > w - 180 ? "translateX(-110%)" : undefined }}
        >
          <div className="mb-1 font-medium text-fg">{tips[hover]}</div>
          {series.map((s, si) => (
            <div key={s.label} className="flex items-center justify-between gap-4 text-fg-2">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: s.color ?? (si === 0 ? "var(--brand)" : "var(--text-secondary)") }} />
                {s.label}
              </span>
              <span className="tabular text-fg">{s.values[hover] == null ? "–" : format(s.values[hover]!)}</span>
            </div>
          ))}
          {band && band.low[hover] != null ? (
            <div className="mt-1 flex items-center justify-between gap-4 text-fg-3">
              <span>{bandLabel}</span>
              <span className="tabular">
                {format(band.low[hover]!)}–{format(band.high[hover]!)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function niceTicks(min: number, max: number, count: number): number[] {
  const span = Math.max(1e-9, max - min);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let t = start; t <= max + step * 0.999; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

/** Legend row for a TrendChart (always shown for two or more series, or a band). */
export function TrendLegend({ items }: { items: { label: string; kind: "line" | "dashed" | "band" | "target"; color?: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-caption text-fg-3">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-2">
          {it.kind === "band" ? (
            <span aria-hidden className="h-2.5 w-4 rounded-[3px] bg-fg-2/15" />
          ) : (
            <svg width="16" height="6" aria-hidden>
              <line x1="1" x2="15" y1="3" y2="3" stroke={it.color ?? (it.kind === "target" ? "var(--accent-gold)" : "var(--brand)")} strokeWidth={2} strokeDasharray={it.kind === "line" ? undefined : "3 3"} strokeLinecap="round" />
            </svg>
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}
