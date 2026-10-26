/**
 * Isometric math for the worker room. 2:1 dimetric projection.
 * World units are floor tiles. +x runs to the lower right, +y to the lower left, +z up.
 */

export const S = 24;
export const Z = 27.7;

export type Pt = readonly [number, number];

export function iso(x: number, y: number, z = 0): Pt {
  return [(x - y) * S, ((x + y) * S) / 2 - z * Z];
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

export function poly(points: readonly Pt[]): string {
  return `M${points.map((p) => `${f(p[0])},${f(p[1])}`).join("L")}Z`;
}

export function line(points: readonly Pt[]): string {
  return `M${points.map((p) => `${f(p[0])},${f(p[1])}`).join("L")}`;
}

export interface BoxFaces {
  top: string;
  right: string;
  left: string;
}

/** The three visible faces of an axis-aligned box. */
export function box(x: number, y: number, z: number, w: number, d: number, h: number): BoxFaces {
  const t = z + h;
  return {
    top: poly([iso(x, y, t), iso(x + w, y, t), iso(x + w, y + d, t), iso(x, y + d, t)]),
    right: poly([iso(x + w, y, z), iso(x + w, y + d, z), iso(x + w, y + d, t), iso(x + w, y, t)]),
    left: poly([iso(x, y + d, z), iso(x + w, y + d, z), iso(x + w, y + d, t), iso(x, y + d, t)]),
  };
}

/** The floor, or any horizontal surface at height z. In this plane (u, v) = (x * S, y * S). */
export const floorPlane = (z = 0): string => `matrix(1 0.5 -1 0.5 0 ${f(-z * Z)})`;

/** A plane standing on the line y = c, facing +y. u = x * S, v = (top - z) * Z. */
export const planeY = (c: number, top: number): string => `matrix(1 0.5 0 1 ${f(-c * S)} ${f((c * S) / 2 - top * Z)})`;

/** A plane standing on the line x = c, facing +x, read left to right. u = (yMax - y) * S. */
export const planeX = (c: number, yMax: number, top: number): string =>
  `matrix(1 -0.5 0 1 ${f((c - yMax) * S)} ${f(((c + yMax) * S) / 2 - top * Z)})`;

export function bezier(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/** Control point for a handoff arc: above the midpoint, higher for longer throws. */
export function arcControl(a: Pt, b: Pt, lift = 1): Pt {
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - (26 + dist * 0.22) * lift];
}

export function bounds(points: readonly Pt[], pad = 0): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/** Mix a hex color toward black. amount 0 keeps it, 1 is black. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const k = 1 - Math.max(0, Math.min(1, amount));
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Three face colors for a box. The top is lit, the +y face is dimmer, the +x face is darkest. */
export function faces(hex: string): { top: string; left: string; right: string } {
  return { top: hex, left: shade(hex, 0.22), right: shade(hex, 0.42) };
}

/** 3358151 becomes "3.4M", 862536 becomes "863K". Rounds a real number, never invents one. */
export function compact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

export function grouped(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
