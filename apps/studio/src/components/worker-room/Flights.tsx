// Everything that flies, each one caused by something real: work handed to an agent, a spark from the brain when an
// agent starts, a check back to the Chief when it finishes, a post out to the feed, a comment in to the Inbox.
// Each packet moves itself from the shared clock, so React only mounts and unmounts them.

import { memo, useEffect, useRef, type ReactNode } from "react";
import { Ticket } from "./ChiefDais";
import type { Clock } from "./clock";
import { arcControl, bezier, type Pt } from "./iso";
import { anchor } from "./layout";
import { P } from "./palette";
import type { Flight, FlightKind } from "./types";

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const SMALL: readonly FlightKind[] = ["read", "scan"];

function arcPath(a: Pt, c: Pt, b: Pt): string {
  return `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${c[0].toFixed(1)},${c[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
}

function Packet({ flight }: { flight: Flight }): ReactNode {
  const { kind, tint } = flight;
  if (kind === "read" || kind === "scan") {
    return (
      <g>
        <circle r={9} fill="url(#wr-glow-pink)" />
        <circle r={2.8} fill={kind === "scan" ? P.lilac : "#fff"} />
      </g>
    );
  }
  if (kind === "job") {
    return (
      <g>
        <circle r={22} fill="url(#wr-glow-pink)" opacity={0.5} />
        <Ticket label={flight.label ?? "Brief"} tint={tint} />
      </g>
    );
  }
  if (kind === "done") {
    return (
      <g>
        <circle r={18} fill="url(#wr-glow-pink)" opacity={0.6} />
        <circle r={8.4} fill="#fff" stroke={tint} strokeWidth={1.6} />
        <path d="M-3.6,0.3 L-1,3 L4,-3" fill="none" stroke={P.magenta} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    );
  }
  if (kind === "comment") {
    return (
      <g>
        <circle r={17} fill="url(#wr-glow-pink)" opacity={0.55} />
        <path d="M-9,-7 h18 a3,3 0 0 1 3,3 v7 a3,3 0 0 1 -3,3 h-9 l-5,4 v-4 h-4 a3,3 0 0 1 -3,-3 v-7 a3,3 0 0 1 3,-3 Z" fill="#fff" />
        <path d="M0,3.4 C-5,-0.4 -2.6,-4.2 0,-1.6 C2.6,-4.2 5,-0.4 0,3.4 Z" fill={P.magenta} />
      </g>
    );
  }
  const post = kind === "post";
  return (
    <g>
      <circle r={post ? 24 : 16} fill="url(#wr-glow-pink)" opacity={post ? 0.75 : 0.5} />
      <rect x={-6.5} y={-10.5} width={13} height={21} rx={3} fill={post ? "#fff" : tint} stroke="#fff" strokeWidth={1.2} />
      <path d="M-2.4,-3.6 L3.4,0 L-2.4,3.6 Z" fill={post ? P.magenta : "#fff"} />
    </g>
  );
}

const FlightView = memo(
  function FlightView({ flight, clock }: { flight: Flight; clock: Clock }) {
    const ref = useRef<SVGGElement>(null);
    const trail = useRef<SVGPathElement>(null);
    const small = SMALL.includes(flight.kind);
    const a = anchor(flight.from, flight.phone ?? 0);
    const b = anchor(flight.to, flight.phone ?? 0);
    const c = arcControl(a, b, small ? 0.45 : 1);

    useEffect(() => {
      const draw = (t: number) => {
        const p = clamp01((t - flight.start) / flight.dur);
        const [x, y] = bezier(a, c, b, ease(p));
        ref.current?.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        if (trail.current) trail.current.style.opacity = String(Math.max(0, Math.min(p / 0.15, (1 - p) / 0.2, 1)) * (small ? 0.4 : 0.7));
      };
      draw(clock.now());
      return clock.subscribe(draw);
      // A flight never changes once it is in the air, so this runs once.
    }, []);

    return (
      <g pointerEvents="none">
        <path ref={trail} d={arcPath(a, c, b)} fill="none" stroke={small ? P.pink : flight.tint} strokeWidth={small ? 1 : 1.7} strokeDasharray={small ? "1 5" : "2 6"} strokeLinecap="round" style={{ opacity: 0 }} />
        <g ref={ref} transform={`translate(${a[0]} ${a[1]})`}>
          <Packet flight={flight} />
        </g>
      </g>
    );
  },
  (prev, next) => prev.flight.id === next.flight.id,
);

export function Flights({ flights, clock }: { flights: readonly Flight[]; clock: Clock }) {
  return (
    <g>
      {flights.map((f) => (
        <FlightView key={f.id} flight={f} clock={clock} />
      ))}
    </g>
  );
}
