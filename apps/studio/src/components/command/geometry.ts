/**
 * Orbit geometry for the command view (Moment 5) and the compact agent map. Everything is in stage units on a square
 * stage that is scaled uniformly to its container, so a 4K monitor, a laptop and a 9:16 crop show the same composition.
 */
import { polar } from "@/motion/tokens";

export type Geometry = {
  /** Stage width and height (stage units). */
  S: number;
  H: number;
  /** Centre. */
  c: number;
  cy: number;
  /** Vertical squash of the agent tracks (1 = circles; <1 = ellipses that fill a wide panel). */
  squash: number;
  inner: number;
  outer: number;
  /** Radius of the scheduled-post track, or null for no post track. */
  post: number | null;
  ring: number;
  brand: number;
  mono: 56 | 64;
  name: number;
  status: number | null;
  /** Comet tail length in stage units (~40px on a typical screen). */
  tail: number;
};

export const FULL: Geometry = { S: 900, H: 900, c: 450, cy: 450, squash: 1, inner: 178, outer: 296, post: 400, ring: 92, brand: 118, mono: 56, name: 13, status: 11.5, tail: 84 };
export const COMPACT: Geometry = { S: 780, H: 470, c: 390, cy: 222, squash: 0.6, inner: 168, outer: 300, post: null, ring: 62, brand: 76, mono: 56, name: 17, status: null, tail: 70 };

/** Who commonly hands work to whom: the production loop, plus the Chief of Staff connected to everyone. */
export const NETWORK: [string, string][] = [
  ["strategist", "copywriter"],
  ["copywriter", "art_director"],
  ["art_director", "publisher"],
  ["publisher", "community"],
  ["community", "analyst"],
  ["analyst", "strategist"],
  ...(["strategist", "copywriter", "art_director", "publisher", "community", "analyst"].map((k) => ["chief_of_staff", k]) as [string, string][]),
];

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

type Seat = { track: "inner" | "outer"; angle: number };

/** The Chief of Staff sits on the inner track with the planners; the makers orbit outside. */
export const SEATS: Record<string, Seat> = {
  chief_of_staff: { track: "inner", angle: 320 },
  strategist: { track: "inner", angle: 80 },
  analyst: { track: "inner", angle: 200 },
  copywriter: { track: "outer", angle: 22 },
  art_director: { track: "outer", angle: 112 },
  publisher: { track: "outer", angle: 202 },
  community: { track: "outer", angle: 292 },
};

/** Milliseconds per revolution; the tracks counter-rotate. */
export const PERIOD = { inner: 150_000, outer: -230_000 } as const;

/** Per-agent orbit clock so hovering one agent pauses only that agent. */
export class OrbitClock {
  private held = new Map<string, number>();
  private offset = new Map<string, number>();

  hold(key: string, t: number): void {
    if (!this.held.has(key)) this.held.set(key, t);
  }

  release(key: string, t: number): void {
    const since = this.held.get(key);
    if (since === undefined) return;
    this.held.delete(key);
    this.offset.set(key, (this.offset.get(key) ?? 0) + (t - since));
  }

  local(key: string, t: number): number {
    const since = this.held.get(key);
    return (since ?? t) - (this.offset.get(key) ?? 0);
  }
}

export function seatAngle(key: string, localT: number): number {
  const seat = SEATS[key] ?? { track: "outer" as const, angle: 0 };
  return seat.angle + (360 * localT) / PERIOD[seat.track];
}

export function seatPoint(g: Geometry, key: string, localT: number): { x: number; y: number } {
  const seat = SEATS[key] ?? { track: "outer" as const, angle: 0 };
  const p = polar(0, 0, seat.track === "inner" ? g.inner : g.outer, seatAngle(key, localT));
  return { x: g.c + p.x, y: g.cy + p.y * g.squash };
}

/**
 * Where a post sits on the outer track. Live mode maps real time to the dial on a log scale (the next hour gets most of
 * the travel, 72 hours sit near 1 o'clock); the dial reads clockwise toward "now" at 12 o'clock.
 */
export const POST_ENTRY_DEG = 34;
const K_MS = 12 * 60_000;
const H_MS = 72 * 3600_000;

export function liveAngle(msUntil: number): number | null {
  if (msUntil > H_MS) return null;
  if (msUntil <= 0) return 360;
  const f = Math.log1p(msUntil / K_MS) / Math.log1p(H_MS / K_MS);
  return 360 - (360 - POST_ENTRY_DEG) * f;
}

/** Show the work, not the wiring: a bare job id ("Running editing.prep") reads as "Working". */
export function plainLabel(label: string): string {
  return /^Running [\w-]+\.[\w.-]+$/.test(label) ? "Working" : label;
}
