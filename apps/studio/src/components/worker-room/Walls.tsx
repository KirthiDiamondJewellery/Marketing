// The two back walls: dark slatted panels with a neon cap, and one line of the workspace's real totals along the top.

import { memo } from "react";
import { iso, line, planeX, planeY, poly, S, Z } from "./iso";
import { D, H, PHONE, W } from "./layout";
import { P } from "./palette";

const T = 0.34;
const TICK_V = (H - PHONE.z1) * Z - 7;

function Panel({ length }: { length: number }) {
  const slats = Array.from({ length: Math.floor(length / 2) - 1 }, (_, i) => (i + 1) * 2 * S);
  return (
    <g>
      <rect x={0} y={0} width={length * S} height={H * Z} fill="url(#wr-wall-fill)" />
      {slats.map((u) => (
        <path key={u} d={`M${u},0 V${H * Z}`} stroke="#1f1430" strokeWidth={1} />
      ))}
      <rect x={0} y={H * Z - 5} width={length * S} height={5} fill={P.magenta} opacity={0.5} />
    </g>
  );
}

function Ticker({ u, text }: { u: number; text: string }) {
  return (
    <text x={u} y={TICK_V} fontFamily="var(--font-mono)" fontSize={8.4} fontWeight={500} letterSpacing={1.1} fill={P.lilac}>
      {text}
    </text>
  );
}

export const Walls = memo(function Walls({ right, left }: { right: string; left: string }) {
  return (
    <g>
      <path d={poly([iso(0, 0, H), iso(W, 0, H), iso(W, -T, H), iso(-T, -T, H), iso(-T, D, H), iso(0, D, H)])} fill={P.wallCap} />
      <g transform={planeY(0, H)}>
        <Panel length={W} />
        {right ? <Ticker u={PHONE.first * S} text={right} /> : null}
      </g>
      <g transform={planeX(0, D, H)}>
        <Panel length={D} />
        {left ? <Ticker u={(D - PHONE.first) * S - left.length * 6.2} text={left} /> : null}
      </g>
      <path d={line([iso(0, 0, 0), iso(0, 0, H)])} stroke="#2c1c44" strokeWidth={1.2} />
      <path d={line([iso(0, D, H), iso(0, 0, H), iso(W, 0, H)])} fill="none" stroke={P.pink} strokeWidth={4.5} opacity={0.22} strokeLinejoin="round" />
      <path d={line([iso(0, D, H), iso(0, 0, H), iso(W, 0, H)])} fill="none" stroke={P.pink} strokeWidth={1.5} strokeLinejoin="round" />
    </g>
  );
});
