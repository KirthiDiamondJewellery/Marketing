// Small parts shared by the desk screens. Every screen is drawn in a 72 by 52 box and tells its story with shapes
// that appear in order while the agent works. Timing is a fraction of the work step: at(0.5) means halfway through.

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";

export const SW = 72;
export const SH = 52.6;

export const INK = "#f4eeff";
export const CELL = "#3a2868";
export const EDGE = "#6a52a8";
export const PINK = "#b566ff";
export const MAGENTA = "#8139fa";
export const VIOLET = "#8b5cf6";
export const LILAC = "#c4b5fd";

/** The workspace's own post covers, so desk screens show its real work. Empty draws soft gradient tiles. */
export const CoversContext = createContext<readonly string[]>([]);

type Vars = CSSProperties & Record<`--${string}`, string | number>;

export function at(d: number, l?: number): CSSProperties {
  const v: Vars = { "--d": d };
  if (l !== undefined) v["--l"] = l;
  return v;
}

export function from(d: number, l: number, fx: number, fy: number, scale = 1, opacity = 1): CSSProperties {
  const v: Vars = { "--d": d, "--l": l, "--fx": `${fx}px`, "--fy": `${fy}px`, "--fs": scale, "--fo": opacity };
  return v;
}

export interface SceneProps {
  tint: string;
}

/** One of the workspace's own covers, cropped to a small tile. */
export function Thumb({ x, y, w, h, n, edge = EDGE }: { x: number; y: number; w: number; h: number; n: number; edge?: string }) {
  const covers = useContext(CoversContext);
  const cover = covers.length ? covers[((n % covers.length) + covers.length) % covers.length] : null;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="url(#wr-thumb-blank)" />
      {cover ? (
        <image href={cover} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid slice" />
      ) : (
        <>
          <rect x={x + w * 0.18} y={y + h * 0.62} width={w * 0.64} height={Math.max(1, h * 0.06)} rx={0.6} fill="#fff" opacity={0.55} />
          <rect x={x + w * 0.18} y={y + h * 0.72} width={w * 0.42} height={Math.max(1, h * 0.05)} rx={0.6} fill="#fff" opacity={0.35} />
        </>
      )}
      <rect x={x} y={y} width={w} height={h} fill="none" stroke={edge} strokeWidth={0.7} />
    </g>
  );
}

export function Lines({ x, y, widths, gap, h = 2, d0, step, fill = LILAC, len = 0.08 }: { x: number; y: number; widths: readonly number[]; gap: number; h?: number; d0: number; step: number; fill?: string; len?: number }) {
  return (
    <g>
      {widths.map((w, i) => (
        <rect key={i} className="i-grow" style={at(d0 + i * step, len)} x={x} y={y + i * gap} width={w} height={h} rx={h / 2} fill={fill} />
      ))}
    </g>
  );
}

export function Check({ cx, cy, r = 5, d, fill = PINK }: { cx: number; cy: number; r?: number; d: number; fill?: string }) {
  const k = r / 5;
  return (
    <g className="i-pop" style={at(d)}>
      <circle cx={cx} cy={cy} r={r} fill={fill} />
      <path d={`M${cx - 2.2 * k},${cy + 0.2 * k} L${cx - 0.6 * k},${cy + 1.9 * k} L${cx + 2.4 * k},${cy - 1.7 * k}`} fill="none" stroke="#fff" strokeWidth={1.3 * k} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

export function Bubble({ x, y, w, h, fill, d, ink = INK, children }: { x: number; y: number; w: number; h: number; fill: string; d: number; ink?: string; children?: ReactNode }) {
  return (
    <g className="i-pop" style={at(d)}>
      <rect x={x} y={y} width={w} height={h} rx={Math.min(3.2, h / 2)} fill={fill} />
      <rect x={x + 3} y={y + h / 2 - 0.9} width={w * 0.52} height={1.8} rx={0.9} fill={ink} opacity={0.9} />
      {children}
    </g>
  );
}

export function Heart({ cx, cy, s = 1, fill = PINK }: { cx: number; cy: number; s?: number; fill?: string }) {
  return <path transform={`translate(${cx} ${cy}) scale(${s})`} d="M0,2.6 C-4.2,-0.4 -2.2,-3.4 0,-1.2 C2.2,-3.4 4.2,-0.4 0,2.6 Z" fill={fill} />;
}

export function Star({ cx, cy, s = 1, fill = PINK }: { cx: number; cy: number; s?: number; fill?: string }) {
  return <path transform={`translate(${cx} ${cy}) scale(${s})`} d="M0,-4 L1.2,-1.3 L4,-1.2 L1.8,0.7 L2.5,3.6 L0,2 L-2.5,3.6 L-1.8,0.7 L-4,-1.2 L-1.2,-1.3 Z" fill={fill} />;
}

export function Wave({ x, cy, heights, w = 1.8, gap = 3, fill = LILAC, loop = true }: { x: number; cy: number; heights: readonly number[]; w?: number; gap?: number; fill?: string; loop?: boolean }) {
  return (
    <g>
      {heights.map((h, i) => (
        <rect key={i} className={loop ? "loop-wave" : undefined} style={{ animationDelay: `${-((i * 0.17) % 0.9)}s` }} x={x + i * gap} y={cy - h / 2} width={w} height={h} rx={w / 2} fill={fill} />
      ))}
    </g>
  );
}

export const WAVE_A = [4, 8, 5, 10, 6, 12, 7, 9, 4, 11, 6, 8, 5, 7] as const;
