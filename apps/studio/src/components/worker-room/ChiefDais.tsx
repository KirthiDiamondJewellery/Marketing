// The Chief of Staff: the one robot in charge. It stands on a raised platform in the back corner behind a
// wraparound console, bigger than the workers, with a crown ring. The ticket over the console shows the last piece
// of work it handed out.

import { memo } from "react";
import { CHIEF_NAME } from "./cast";
import { Box } from "./Box";
import { floorPlane, iso, S } from "./iso";
import { CHIEF, CHIEF_SCALE } from "./layout";
import { P } from "./palette";
import { Robot, type Dir } from "./Robot";
import type { DeskStatus } from "./types";

const SEAT_Z = CHIEF.z + 0.55;

function Console() {
  return (
    <g>
      <Box b={[7.2, 4.3, CHIEF.z, 0.7, 2.9, 0.95]} color="#2a1c46" edge={P.pink} />
      <Box b={[4.3, 7.2, CHIEF.z, 3.6, 0.7, 0.95]} color="#2a1c46" edge={P.pink} />
      <g transform={floorPlane(CHIEF.z + 0.95)}>
        <rect x={4.6 * S} y={7.35 * S} width={2.4 * S} height={0.4 * S} rx={2} className="wr-console-glow" />
        <rect x={7.35 * S} y={4.6 * S} width={0.4 * S} height={2.4 * S} rx={2} className="wr-console-glow" />
      </g>
    </g>
  );
}

export function Ticket({ label, tint }: { label: string; tint: string }) {
  const w = Math.max(54, label.length * 5 + 30);
  return (
    <g>
      <rect x={-w / 2} y={-9} width={w} height={18} rx={9} fill="#120a20" stroke={tint} strokeWidth={1.3} />
      <rect x={-w / 2 + 6} y={-5.4} width={7.4} height={10.8} rx={1.6} fill="#fff" />
      <path d={`M${-w / 2 + 8.2},-2.4 L${-w / 2 + 11.6},0 L${-w / 2 + 8.2},2.4 Z`} fill={P.magenta} />
      <text x={7.4} y={3} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={7.6} fontWeight={600} fill="#fff">
        {label}
      </text>
    </g>
  );
}

/** The Studio mark: a violet ring broken by a gap at one o'clock. */
function Mark({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const pt = (deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const [x1, y1] = pt(47);
  const [x2, y2] = pt(373);
  return (
    <g className="wr-chief-logo">
      <circle cx={cx} cy={cy} r={r * 1.9} fill="url(#wr-glow-floor)" />
      <circle cx={cx} cy={cy} r={r + 6} fill="#0b0712" stroke={P.violet} strokeWidth={1} opacity={0.9} />
      <path d={`M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 1 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`} fill="none" stroke={P.magenta} strokeWidth={4.2} />
    </g>
  );
}

export const ChiefDais = memo(function ChiefDais({ status, dir, ticket, tint, off, onPick }: { status: DeskStatus; dir: Dir; ticket: { key: number; label: string } | null; tint: string; off: boolean; onPick: () => void }) {
  const [d0, d1] = CHIEF.dais;
  const [i0, i1] = CHIEF.inner;
  const [hx, hy] = iso(CHIEF.x, CHIEF.y, SEAT_Z);
  const [kx, ky] = iso(8.9, 4.9, CHIEF.z + 2.5);
  const tagW = CHIEF_NAME.length * 4.5 + 22;
  return (
    <g className={`wr-chief st-${status}${off ? " is-off" : ""}`} onClick={onPick}>
      <Box b={[d0, d0, 0, d1 - d0, d1 - d0, 0.25]} color="#190f2c" edge={P.magenta} />
      <Box b={[i0, i0, 0.25, i1 - i0, i1 - i0, 0.25]} color="#20143a" edge={P.pink} />
      <g transform={floorPlane(CHIEF.z)}>
        <circle cx={CHIEF.x * S} cy={CHIEF.y * S} r={2.3 * S} fill="url(#wr-glow-floor)" className="wr-chief-pool" />
        <circle cx={CHIEF.x * S} cy={CHIEF.y * S} r={1.5 * S} fill="none" stroke={P.pink} strokeWidth={1.2} strokeDasharray="4 6" className="wr-chief-spin" />
      </g>
      <Mark cx={hx} cy={hy - 191} r={13} />
      <Box b={[CHIEF.x - 0.5, CHIEF.y - 0.5, CHIEF.z, 1, 1, 0.55]} color="#3a2862" edge={P.pink} />
      <Robot x={CHIEF.x} y={CHIEF.y} z={SEAT_Z} scale={CHIEF_SCALE} status={status} dir={dir} tint={P.pink} chief />
      <Console />
      {ticket ? (
        <g key={ticket.key} transform={`translate(${kx} ${ky})`}>
          <g className="wr-ticket">
            <Ticket label={ticket.label} tint={tint} />
          </g>
        </g>
      ) : null}
      <g transform={`translate(${hx} ${hy - 143})`}>
        <rect x={-tagW / 2} y={-8.5} width={tagW} height={17} rx={8.5} fill="#0b0712" stroke={P.pink} strokeWidth={1.1} />
        <path d="M-4.4,2.6 l1.2,-4.8 l2,2.7 l1.2,-3.8 l1.2,3.8 l2,-2.7 l1.2,4.8 Z" fill={P.pink} transform={`translate(${-tagW / 2 + 11} 0.3)`} />
        <text x={6} y={3.2} textAnchor="middle" fontSize={8.8} fontWeight={650} fill={P.ink}>
          {CHIEF_NAME}
        </text>
      </g>
      <rect x={hx - 70} y={hy - 140} width={140} height={200} fill="transparent" className="wr-hit" />
    </g>
  );
});
