// A little robot agent. Its state shows on its body, not in words: hands tap while it works, the antenna and chest
// light up, the eyes smile and the body leans toward the next desk while it hands work off. Waiting robots glow amber
// and look up; idle robots power down and breathe slowly. Motion is driven by classes in worker-room.css.

import { memo, type CSSProperties } from "react";
import { iso } from "./iso";
import { P } from "./palette";
import type { DeskStatus } from "./types";

export type Dir = "l" | "r" | "0";

const TORSO = "M-7.6,-19 Q-7.6,-21.6 -4.6,-21.6 L4.6,-21.6 Q7.6,-21.6 7.6,-19 L6.7,-3.4 Q6.4,-0.9 4,-0.8 L-4,-0.8 Q-6.4,-0.9 -6.7,-3.4 Z";
const TORSO_SHADE = "M1.2,-21.6 L4.6,-21.6 Q7.6,-21.6 7.6,-19 L6.7,-3.4 Q6.4,-0.9 4,-0.8 L1.2,-0.8 Z";

function Arm({ side }: { side: "l" | "r" }) {
  const k = side === "l" ? -1 : 1;
  return (
    <g className={`bot-arm ${side}`}>
      <path d={`M${8 * k},-16 Q${11.4 * k},-10 ${6.9 * k},-6.2`} stroke={P.arm} strokeWidth={3.9} strokeLinecap="round" fill="none" />
      <circle className={`bot-hand ${side}`} cx={6.9 * k} cy={-6.2} r={2.35} fill={P.head} />
    </g>
  );
}

function Antenna({ x }: { x: number }) {
  return (
    <g>
      <path d={`M${x},-40.6 L${x},-45.4`} stroke={P.headShade} strokeWidth={1.1} strokeLinecap="round" />
      <circle className="bot-halo" cx={x} cy={-47} r={7.5} style={{ transformOrigin: `${x}px -47px` }} />
      <circle className="bot-orb" cx={x} cy={-47} r={2} />
    </g>
  );
}

function Face() {
  return (
    <g className="bot-face">
      <rect x={-7.6} y={-37.6} width={15.2} height={9.6} rx={4.4} fill={P.visor} />
      <g className="bot-eyes">
        <rect className="bot-eye" x={-5} y={-34.6} width={3.2} height={3.6} rx={1.5} />
        <rect className="bot-eye" x={1.8} y={-34.6} width={3.2} height={3.6} rx={1.5} />
      </g>
      <path className="bot-smile" d="M-5.2,-31.8 q1.7,-2.6 3.4,0 M1.8,-31.8 q1.7,-2.6 3.4,0" fill="none" strokeWidth={1.3} strokeLinecap="round" />
    </g>
  );
}

function Head({ chief }: { chief: boolean }) {
  return (
    <g className="bot-head">
      {chief ? (
        <>
          <Antenna x={-5} />
          <Antenna x={5} />
        </>
      ) : (
        <Antenna x={0} />
      )}
      <rect x={-11.7} y={-35.6} width={2.6} height={5.6} rx={1.3} className="bot-ear" />
      <rect x={9.1} y={-35.6} width={2.6} height={5.6} rx={1.3} className="bot-ear" />
      <rect x={-10} y={-41} width={20} height={16.5} rx={7.5} fill={P.head} />
      <path d="M2,-41 L2.5,-41 Q10,-41 10,-33.5 L10,-32 Q10,-24.5 2.5,-24.5 L2,-24.5 Q6.4,-32.7 2,-41 Z" fill={P.headShade} opacity={0.6} />
      <Face />
      <ellipse cx={-4.2} cy={-39.3} rx={3.3} ry={1} fill="#fff" opacity={0.9} />
      {chief && <ellipse className="bot-crown" cx={0} cy={-53.5} rx={10} ry={2.7} fill="none" stroke={P.pink} strokeWidth={1.3} />}
    </g>
  );
}

/** A robot on its seat. (x, y, z) is the seat surface and everything hangs off that point. */
export const Robot = memo(function Robot({ x, y, z, scale, status, dir, tint, chief = false, breath = 0 }: { x: number; y: number; z: number; scale: number; status: DeskStatus; dir: Dir; tint: string; chief?: boolean; breath?: number }) {
  const [sx, sy] = iso(x, y, z);
  const body = chief ? "#f1eaff" : P.body;
  const shade = chief ? "#c9b8f5" : P.bodyShade;
  return (
    <g transform={`translate(${sx.toFixed(2)} ${sy.toFixed(2)}) scale(${scale})`}>
      <g className={`bot st-${status} dir-${dir}${chief ? " is-chief" : ""}`} style={{ "--tint": tint, "--breath": `${-breath}s` } as CSSProperties}>
        <g className="bot-lean">
          <Arm side="l" />
          <Arm side="r" />
          <path d={TORSO} fill={body} className="bot-torso" />
          <path d={TORSO_SHADE} fill={shade} opacity={0.75} />
          {chief && <path d="M-7.4,-17 L7.4,-12.4 L7.2,-9.6 L-7.2,-14.2 Z" fill={P.magenta} />}
          <circle cx={0} cy={chief ? -7 : -12.2} r={3.2} fill={P.visor} opacity={0.55} />
          <circle className="bot-chest" cx={0} cy={chief ? -7 : -12.2} r={2.1} />
          <rect x={-2.2} y={-24.8} width={4.4} height={3.8} rx={1.2} fill={P.arm} />
          <Head chief={chief} />
        </g>
      </g>
    </g>
  );
});
