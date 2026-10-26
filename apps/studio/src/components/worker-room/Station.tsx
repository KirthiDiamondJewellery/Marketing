// One robot's station: a screen on a post, the robot on its stool and the desk in front. Drawn back to front so the
// desk covers the robot's seat. The screen plays its little story only while the real agent is working.

import { memo, type CSSProperties } from "react";
import type { RobotId } from "./cast";
import { Box, type BoxArgs } from "./Box";
import { floorPlane, iso, planeX, planeY, S, Z } from "./iso";
import { DESK, ROBOT_SCALE, SCREEN, SEAT, world, type Spot } from "./layout";
import { P } from "./palette";
import { Robot, type Dir } from "./Robot";
import { SCENES } from "./screens";
import { SH, SW } from "./screens/bits";
import type { DeskStatus } from "./types";

interface Props {
  spot: Spot;
  name: string;
  tint: string;
  status: DeskStatus;
  cycle: number;
  dir: Dir;
  breath: number;
  off: boolean;
  onPick: (id: RobotId) => void;
}

function local(spot: Spot, a: number, b: number, z: number, wa: number, db: number, h: number): BoxArgs {
  return spot.orient === "x" ? [spot.cx + a, spot.cy + b, z, wa, db, h] : [spot.cx + b, spot.cy + a, z, db, wa, h];
}

function screenPlane(spot: Spot): string {
  if (spot.orient === "x") return `${planeY(spot.cy - SCREEN.back, SCREEN.z1)} translate(${((spot.cx - SCREEN.half) * S).toFixed(2)} 0)`;
  return planeX(spot.cx - SCREEN.back, spot.cy + SCREEN.half, SCREEN.z1);
}

const DW = SCREEN.half * 2 * S;
const DH = (SCREEN.z1 - SCREEN.z0) * Z;

function Screen({ spot, name, tint, status, cycle }: Pick<Props, "spot" | "name" | "tint" | "status" | "cycle">) {
  const Scene = SCENES[spot.id];
  const tab = name.length * 3.7 + 14;
  const waiting = status === "wait" || status === "block";
  return (
    <g transform={screenPlane(spot)}>
      <rect x={-2.6} y={-2.6} width={DW + 5.2} height={DH + 5.2} rx={3.2} fill="#06040b" stroke={tint} strokeWidth={1.1} className="scr-frame" />
      <rect x={0} y={0} width={DW} height={DH} rx={1.4} fill="url(#wr-screen-bg)" />
      <svg x={0} y={0} width={DW} height={DH} viewBox={`0 0 ${SW} ${SH}`}>
        <g key={cycle} className="scene">
          <Scene tint={tint} />
        </g>
      </svg>
      <rect x={0} y={0} width={DW} height={DH} rx={1.4} fill="#07050a" className="scr-dim" />
      <circle cx={DW / 2} cy={DH / 2} r={2.2} className="scr-standby" />
      <g>
        <rect x={-2.6} y={-14.6} width={tab} height={10.4} rx={2.6} fill="#0b0712" stroke={tint} strokeWidth={0.7} className="scr-tab" />
        <circle cx={3.2} cy={-9.4} r={1.8} className="scr-led" />
        <text x={8} y={-7.1} fontSize={6.7} fontWeight={600} fill={P.ink} className="scr-name">
          {name}
        </text>
      </g>
      {waiting ? (
        <g className="scr-need">
          <circle cx={DW - 1} cy={1} r={5.4} fill={status === "block" ? P.red : P.amber} />
          <rect x={DW - 1.7} y={-2.4} width={1.4} height={3.6} rx={0.7} fill="#1a0f05" />
          <circle cx={DW - 1} cy={3.1} r={0.8} fill="#1a0f05" />
        </g>
      ) : null}
    </g>
  );
}

function Desk({ spot, tint }: { spot: Spot; tint: string }) {
  const { half, depth, top } = DESK;
  const [kx, ky] = world(spot, 0, -0.22);
  const strip = spot.orient === "x" ? planeY(spot.cy + depth, top) : planeX(spot.cx + depth, spot.cy + half, top);
  const stripX = spot.orient === "x" ? (spot.cx - half) * S : 0;
  return (
    <g>
      <Box b={local(spot, -half + 0.12, -depth + 0.1, 0, 0.16, depth * 2 - 0.2, top - 0.08)} color={P.metal} />
      <Box b={local(spot, half - 0.28, -depth + 0.1, 0, 0.16, depth * 2 - 0.2, top - 0.08)} color={P.metal} />
      <Box b={local(spot, -half, -depth, top - 0.1, half * 2, depth * 2, 0.1)} color={P.deskTop} edge="#4a3870" />
      <g transform={floorPlane(top)}>
        <rect x={kx * S - (spot.orient === "x" ? 14 : 5)} y={ky * S - (spot.orient === "x" ? 5 : 14)} width={spot.orient === "x" ? 28 : 10} height={spot.orient === "x" ? 10 : 28} rx={2} className="desk-keys" />
      </g>
      <g transform={strip}>
        <rect x={stripX + 5} y={2.4} width={half * 2 * S - 10} height={1.5} rx={0.75} fill={tint} className="desk-strip" />
      </g>
    </g>
  );
}

export const Station = memo(function Station({ spot, name, tint, status, cycle, dir, breath, off, onPick }: Props) {
  const [sx, sy] = world(spot, 0, -SEAT.back);
  const [px, py] = world(spot, 0, -SCREEN.back - 0.06);
  const [hx, hy] = iso(...world(spot, 0, -0.6), 0);
  return (
    <g className={`station st-${status}${off ? " is-off" : ""}`} style={{ "--tint": tint } as CSSProperties} onClick={() => onPick(spot.id)}>
      <g transform={floorPlane(0.14)}>
        <circle cx={sx * S} cy={sy * S} r={S * 1.3} className="st-pool" />
      </g>
      <Box b={[px - 0.3, py - 0.3, 0.14, 0.6, 0.6, 0.08]} color={P.metal} />
      <Box b={[px - 0.07, py - 0.07, 0.2, 0.14, 0.14, SCREEN.z0 - 0.2]} color={P.metalHi} />
      <Screen spot={spot} name={name} tint={tint} status={status} cycle={cycle} />
      <Box b={[sx - 0.34, sy - 0.34, 0.14, 0.68, 0.68, SEAT.z - 0.14]} color={P.metal} edge="#4a3870" />
      <Robot x={sx} y={sy} z={SEAT.z} scale={ROBOT_SCALE} status={status} dir={dir} tint={tint} breath={breath} />
      <Desk spot={spot} tint={tint} />
      <rect x={hx - 42} y={hy - 132} width={84} height={150} fill="transparent" className="wr-hit" />
    </g>
  );
});
