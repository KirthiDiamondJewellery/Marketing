// Unfinished feature: a responsive single-series line chart with an optional goal line. Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A single-series line chart drawn at its real pixel width, so axis text stays 11px on a phone and on a wide
 * screen alike. 2px stroke, no area fill, the Signal as the leading point, an optional dashed goal line.
 * `draw` animates the line left to right on mount (the briefing reveal, Moment 8).
 */
export function FluidLineChart({
  values,
  labels,
  label,
  height = 180,
  goal,
  draw = false,
  format = (n: number) => String(n),
}: {
  values: number[];
  labels: string[];
  label: string;
  height?: number;
  goal?: number | null;
  draw?: boolean;
  format?: (n: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const padL = 28;
  const padR = 10;
  const padT = 12;
  const padB = 24;
  const maxV = Math.max(1, ...values, goal ?? 0) * 1.15;
  const ticks = niceTicks(maxV, 3);
  const n = Math.max(2, values.length);
  const px = (i: number) => padL + (i * (w - padL - padR)) / (n - 1);
  const py = (v: number) => padT + (1 - v / maxV) * (H - padT - padB);
  const every = w < 480 ? Math.ceil(labels.length / 4) : 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const last = values.length ? { x: px(values.length - 1), y: py(values[values.length - 1]!) } : null;

  return (
    <div ref={ref} className="w-full" style={{ height: H }}>
      {w > 0 ? (
        <svg width={w} height={H} role="img" aria-label={`${label}: ${values.map((v, i) => `${labels[i]} ${format(v)}`).join(", ")}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={py(t)} y2={py(t)} stroke="var(--border)" strokeOpacity={0.5} />
              <text x={padL - 8} y={py(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)" className="tabular">
                {format(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            (labels.length - 1 - i) % every === 0 ? (
              <text key={i} x={px(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"} fontSize={11} fill="var(--text-muted)">
                {l}
              </text>
            ) : null,
          )}
          {goal ? <line x1={padL} x2={w - padR} y1={py(goal)} y2={py(goal)} stroke="var(--accent-gold)" strokeDasharray="4 4" strokeOpacity={0.8} /> : null}
          <path d={d} fill="none" stroke="var(--brand)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" pathLength={draw ? 1 : undefined} className={draw ? "fluid-draw" : undefined} />
          {values.map((v, i) => (
            <circle key={i} cx={px(i)} cy={py(v)} r={10} fill="transparent">
              <title>{`Week of ${labels[i] ?? ""}: ${format(v)} ${label.toLowerCase()}`}</title>
            </circle>
          ))}
          {last ? (
            <g className={draw ? "fluid-dot" : undefined}>
              <circle cx={last.x} cy={last.y} r={4} fill="var(--brand)" />
              <circle cx={last.x} cy={last.y} r={4} fill="none" stroke="var(--brand)" strokeOpacity={0.35} strokeWidth={6} />
            </g>
          ) : null}
          <style>{`
            .fluid-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: fluid-draw 1.4s cubic-bezier(0.16,1,0.3,1) 0.35s forwards; }
            .fluid-dot { opacity: 0; animation: fluid-dot 0.3s ease-out 1.6s forwards; }
            @keyframes fluid-draw { to { stroke-dashoffset: 0; } }
            @keyframes fluid-dot { to { opacity: 1; } }
            @media (prefers-reduced-motion: reduce) { .fluid-draw { animation: none; stroke-dashoffset: 0; } .fluid-dot { animation: none; opacity: 1; } }
          `}</style>
        </svg>
      ) : null}
    </div>
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
