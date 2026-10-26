/**
 * The relay comet (Moment 2): a bright Signal head with a 60–90px fading tail on a curved path. Imperative SVG so dozens
 * can fly at 60fps; endpoints are re-resolved every frame, so comets track moving targets (command view orbits).
 */
import { easeSignal } from "./tokens";

export type Pt = { x: number; y: number };
export type Resolver = (id: string) => Pt | null;

type Comet = {
  from: string;
  to: string;
  start: number;
  dur: number;
  tail: number;
  bend: number;
  strength: number;
  els: SVGElement[];
  arrived: boolean;
  onArrive?: () => void;
};

type Ripple = { at: string; start: number; dur: number; el: SVGCircleElement; max: number };

const NS = "http://www.w3.org/2000/svg";
// Tail segments from the faint end to the head, plus a soft halo over the front half (the Signal's own light).
const LAYERS = [
  { frac: [1, 0.7], opacity: 0.16, width: 1.5 },
  { frac: [0.7, 0.45], opacity: 0.36, width: 2 },
  { frac: [0.45, 0.2], opacity: 0.66, width: 2.6 },
  { frac: [0.2, 0], opacity: 1, width: 3.2 },
  { frac: [0.5, 0], opacity: 0.22, width: 8 },
] as const;

/** The comet curve's control point, shared with anything that draws the same path (network edges). */
export function cometControl(a: Pt, b: Pt, bend: number, center?: Pt): Pt {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (center) return { x: mx + (center.x - mx) * 0.42, y: my + (center.y - my) * 0.42 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { x: mx - dy * bend, y: my + dx * bend };
}

export type CometOptions = {
  /** Where the curve bows: "center" pulls toward `center`, a number bends sideways by that fraction of the distance. */
  bend?: number;
  center?: Pt;
  scale?: number;
};

export class CometField {
  private comets: Comet[] = [];
  private ripples: Ripple[] = [];
  private now = 0;

  constructor(
    private group: SVGGElement,
    private resolve: Resolver,
    private opts: CometOptions = {},
  ) {}

  get size(): number {
    return this.comets.length;
  }

  launch(c: { from: string; to: string; delayMs?: number; durationMs?: number; tail?: number; bend?: number; strength?: number; onArrive?: () => void }): void {
    const s = this.opts.scale ?? 1;
    const els: SVGElement[] = [];
    for (const l of LAYERS) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "var(--brand)");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-width", String(l.width * s));
      p.setAttribute("opacity", "0");
      this.group.appendChild(p);
      els.push(p);
    }
    const head = document.createElementNS(NS, "circle");
    head.setAttribute("r", String(3.8 * s));
    head.setAttribute("fill", "var(--text-on-tint)");
    head.setAttribute("opacity", "0");
    this.group.appendChild(head);
    els.push(head);
    this.comets.push({
      from: c.from,
      to: c.to,
      start: this.now + (c.delayMs ?? 0),
      dur: c.durationMs ?? 900,
      tail: (c.tail ?? 70) * s,
      bend: c.bend ?? this.opts.bend ?? 0.22,
      strength: c.strength ?? 1,
      els,
      arrived: false,
      onArrive: c.onArrive,
    });
  }

  ripple(at: string, max = 22, dur = 520): void {
    const s = this.opts.scale ?? 1;
    const el = document.createElementNS(NS, "circle");
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "var(--brand)");
    el.setAttribute("stroke-width", String(1.5 * s));
    el.setAttribute("opacity", "0");
    this.group.appendChild(el);
    this.ripples.push({ at, start: this.now, dur, el, max: max * s });
  }

  private control(a: Pt, b: Pt, bend: number): Pt {
    return cometControl(a, b, bend, this.opts.center);
  }

  /** Advance to paced time `t` (ms). */
  tick(t: number): void {
    this.now = t;
    const done: Comet[] = [];
    for (const c of this.comets) {
      const a = this.resolve(c.from);
      const b = this.resolve(c.to);
      const p = (t - c.start) / c.dur;
      if (!a || !b) {
        done.push(c);
        continue;
      }
      if (p < 0) continue;
      const k = this.control(a, b, c.bend);
      const at = (u: number): Pt => {
        const v = 1 - u;
        return { x: v * v * a.x + 2 * v * u * k.x + u * u * b.x, y: v * v * a.y + 2 * v * u * k.y + u * u * b.y };
      };
      const len = Math.hypot(k.x - a.x, k.y - a.y) + Math.hypot(b.x - k.x, b.y - k.y);
      const head = easeSignal(Math.min(1, p));
      // After arrival the tail drains into the target over a short beat.
      const drain = p > 1 ? Math.min(1, (p - 1) * 4) : 0;
      const tailU = Math.max(0.0001, (c.tail / Math.max(1, len)) * (1 - drain));
      const fadeIn = Math.min(1, p * 6);
      LAYERS.forEach((l, i) => {
        const el = c.els[i]!;
        const u0 = Math.max(0, head - tailU * l.frac[0]);
        const u1 = Math.max(0, head - tailU * l.frac[1]);
        if (u1 - u0 < 1e-4) {
          el.setAttribute("opacity", "0");
          return;
        }
        let d = "";
        for (let j = 0; j <= 4; j++) {
          const q = at(u0 + ((u1 - u0) * j) / 4);
          d += `${j ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
        }
        el.setAttribute("d", d);
        el.setAttribute("opacity", String(l.opacity * fadeIn * c.strength * (1 - drain)));
      });
      const h = at(head);
      const headEl = c.els[LAYERS.length]!;
      headEl.setAttribute("cx", h.x.toFixed(1));
      headEl.setAttribute("cy", h.y.toFixed(1));
      headEl.setAttribute("opacity", String(fadeIn * c.strength * (1 - drain)));
      if (p >= 1 && !c.arrived) {
        c.arrived = true;
        this.ripple(c.to, 38, 680);
        c.onArrive?.();
      }
      if (drain >= 1) done.push(c);
    }
    for (const c of done) {
      for (const el of c.els) el.remove();
      this.comets.splice(this.comets.indexOf(c), 1);
      if (!c.arrived) c.onArrive?.();
    }
    const gone: Ripple[] = [];
    for (const r of this.ripples) {
      const p = (t - r.start) / r.dur;
      const at = this.resolve(r.at);
      if (p >= 1 || !at) {
        gone.push(r);
        continue;
      }
      const e = 1 - Math.pow(1 - p, 3);
      r.el.setAttribute("cx", at.x.toFixed(1));
      r.el.setAttribute("cy", at.y.toFixed(1));
      r.el.setAttribute("r", String(4 + (r.max - 4) * e));
      r.el.setAttribute("opacity", String(0.9 * (1 - p)));
    }
    for (const r of gone) {
      r.el.remove();
      this.ripples.splice(this.ripples.indexOf(r), 1);
    }
  }

  clear(): void {
    for (const c of this.comets) for (const el of c.els) el.remove();
    for (const r of this.ripples) r.el.remove();
    this.comets = [];
    this.ripples = [];
  }
}
