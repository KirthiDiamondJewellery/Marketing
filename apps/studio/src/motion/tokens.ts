/** Showcase motion tokens (DESIGN §6.2) as values the JS animation engine can use. */
export const EASE_SIGNAL = [0.16, 1, 0.3, 1] as const;
export const EASE_CINEMATIC = [0.7, 0, 0.2, 1] as const;
export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
export const EASE_IN = [0.4, 0, 1, 1] as const;
/** `--ease-snap`: elements locking into place. */
export const SNAP = { type: "spring", stiffness: 420, damping: 32 } as const;
export const STAGGER_MS = 60;
export const SIGNAL_BLOOM = "0 0 24px rgba(149, 74, 251, 0.45)";
/** The bloom as a CSS filter, for SVG Signal layers. */
export const SIGNAL_BLOOM_FILTER = "drop-shadow(0 0 6px rgba(149, 74, 251, 0.55)) drop-shadow(0 0 18px rgba(149, 74, 251, 0.35))";
/** The signature gap in the AttentionOS ring, centred on 1 o'clock (30° clockwise from 12). */
export const GAP_CENTER_DEG = 30;
export const GAP_DEG = 22;

/** Cubic-bezier evaluator so rAF-driven layers (comets, orbits) share the CSS curves exactly. */
export function bezier(p1x: number, p1y: number, p2x: number, p2y: number): (t: number) => number {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dsx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = sx(t) - x;
      if (Math.abs(d) < 1e-5) break;
      const ds = dsx(t);
      if (Math.abs(ds) < 1e-6) break;
      t -= d / ds;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}

export const easeSignal = bezier(...EASE_SIGNAL);
export const easeCinematic = bezier(...EASE_CINEMATIC);
export const easeOut = bezier(...EASE_OUT);

/** Point on a circle, angle in degrees clockwise from 12 o'clock. */
export function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const a = ((deg - 90) * Math.PI) / 180;
  // Rounded so server and client render identical SVG (Math.cos can differ in the last bit between engines).
  return { x: Math.round((cx + r * Math.cos(a)) * 1000) / 1000, y: Math.round((cy + r * Math.sin(a)) * 1000) / 1000 };
}

/** SVG arc path clockwise from `fromDeg` to `toDeg` (degrees clockwise from 12 o'clock). */
export function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const sweep = ((toDeg - fromDeg) % 360 + 360) % 360 || 360;
  const a = polar(cx, cy, r, fromDeg);
  if (sweep >= 359.99) {
    const m = polar(cx, cy, r, fromDeg + 180);
    return `M ${a.x} ${a.y} A ${r} ${r} 0 1 1 ${m.x} ${m.y} A ${r} ${r} 0 1 1 ${a.x} ${a.y}`;
  }
  const b = polar(cx, cy, r, fromDeg + sweep);
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
}

/** The AttentionOS ring: a full circle broken by the signature gap at 1 o'clock, drawn clockwise from the gap. */
export function ringPath(cx: number, cy: number, r: number, gapDeg = GAP_DEG): string {
  return arcPath(cx, cy, r, GAP_CENTER_DEG + gapDeg / 2, GAP_CENTER_DEG - gapDeg / 2 + 360);
}
