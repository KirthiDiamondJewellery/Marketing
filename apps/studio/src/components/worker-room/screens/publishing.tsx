// Publishing screens: a cover being picked, a calendar filling up, one video going to every platform.

import type { ReactNode } from "react";
import { at, Check, CELL, EDGE, INK, PINK, Star, Thumb, VIOLET, type SceneProps } from "./bits";

const FRAME_X = [6, 27.5, 49] as const;

export function Thumbnails({ tint }: SceneProps) {
  return (
    <g>
      {FRAME_X.map((x, i) => (
        <g key={x} className={i === 1 ? "i-emph" : undefined} style={at(0.62)}>
          <Thumb x={x} y={9} w={17} h={30} n={8} />
          {i === 0 && <rect x={x + 2} y={30} width={13} height={3.4} rx={0.8} fill="#fff" />}
          {i === 1 && <rect x={x + 2} y={13} width={13} height={4} rx={0.8} fill={PINK} />}
          {i === 1 && <rect x={x + 2} y={18.4} width={9} height={3} rx={0.8} fill="#fff" />}
          {i === 2 && <rect x={x} y={9} width={17} height={30} fill={VIOLET} opacity={0.32} />}
          {i === 2 && <rect x={x + 3} y={22} width={11} height={3.4} rx={0.8} fill="#fff" />}
          {i !== 1 && <rect className="i-blip" style={at(i === 0 ? 0.1 : 0.32, 0.2)} x={x - 1.4} y={7.6} width={19.8} height={32.8} rx={1.4} fill="none" stroke="#fff" strokeWidth={1.2} />}
          {i !== 1 && <rect className="i-fade" style={at(0.64)} x={x} y={9} width={17} height={30} fill="#0b0712" opacity={0.6} />}
        </g>
      ))}
      <g className="i-pop" style={at(0.56)}>
        <rect x={FRAME_X[1] - 2.6} y={6.4} width={22.2} height={35.2} rx={1.8} fill="none" stroke={PINK} strokeWidth={1.6} />
      </g>
      <g className="i-pop" style={at(0.8)}>
        <Star cx={36} cy={46.6} s={1.1} fill={tint === VIOLET ? PINK : tint} />
      </g>
    </g>
  );
}

const BOOKED = [1, 3, 5, 8, 10, 12, 15, 17, 19, 22, 24, 26] as const;

export function Scheduler({ tint }: SceneProps) {
  const cells = Array.from({ length: 28 }, (_, i) => i);
  return (
    <g>
      {[0, 1, 2, 3, 4, 5, 6].map((c) => (
        <rect key={c} x={5.6 + c * 7.8} y={5} width={5.4} height={1.8} rx={0.9} fill={EDGE} />
      ))}
      {cells.map((i) => (
        <rect key={i} x={5 + (i % 7) * 7.8} y={10 + Math.floor(i / 7) * 9.6} width={6.6} height={8.2} rx={1.3} fill={CELL} stroke={EDGE} strokeWidth={0.4} />
      ))}
      {BOOKED.map((i, n) => (
        <g key={i} className="i-pop" style={at(0.06 + n * 0.068)}>
          <rect x={5 + (i % 7) * 7.8} y={10 + Math.floor(i / 7) * 9.6} width={6.6} height={8.2} rx={1.3} fill={n % 3 === 0 ? PINK : tint} />
          <path d={`M${6.9 + (i % 7) * 7.8},${12.6 + Math.floor(i / 7) * 9.6} l3.2,1.6 l-3.2,1.6 Z`} fill="#fff" />
        </g>
      ))}
      <circle cx={64.4} cy={14.6} r={4.6} fill={CELL} stroke={INK} strokeWidth={0.9} />
      <path d="M64.4,11.8 V14.6 L66.4,15.8" fill="none" stroke={INK} strokeWidth={0.9} strokeLinecap="round" />
      {[0, 1, 2].map((i) => (
        <rect key={i} className="i-pop" style={at(0.5 + i * 0.14)} x={60.4} y={24.6 + i * 6.6} width={8} height={4.6} rx={1.2} fill={i === 0 ? PINK : tint} />
      ))}
    </g>
  );
}

/** Simple line marks that hint at each platform. Not logos. */
const MARKS: readonly ReactNode[] = [
  <g key="ig" fill="none" stroke="#fff" strokeWidth={0.9}>
    <rect x={2.9} y={2.9} width={5.2} height={5.2} rx={1.6} />
    <circle cx={5.5} cy={5.5} r={1.3} />
  </g>,
  <path key="tt" d="M5.4,2.6 V6.9 A1.5,1.5 0 1 1 4,5.5 M5.4,2.6 Q5.8,4.3 7.8,4.5" fill="none" stroke="#fff" strokeWidth={1} strokeLinecap="round" />,
  <g key="yt">
    <rect x={2.2} y={3.3} width={6.6} height={4.4} rx={1.3} fill="#fff" />
    <path d="M4.8,4.3 L6.9,5.5 L4.8,6.7 Z" fill="#1c1331" />
  </g>,
  <path key="x" d="M3.3,3.3 L7.7,7.7 M7.7,3.3 L3.3,7.7" fill="none" stroke="#fff" strokeWidth={1.1} strokeLinecap="round" />,
  <text key="in" x={5.5} y={7.6} textAnchor="middle" fontSize={5.6} fontWeight={700} fill="#fff">
    in
  </text>,
  <text key="fb" x={5.6} y={8.2} textAnchor="middle" fontSize={7.2} fontWeight={700} fill="#fff">
    f
  </text>,
];

export function CrossPoster({ tint }: SceneProps) {
  return (
    <g>
      <Thumb x={5} y={11} w={17} h={30} n={9} edge={PINK} />
      {MARKS.map((mark, i) => {
        const x = 32 + (i % 3) * 13;
        const y = 8 + Math.floor(i / 3) * 24;
        const d = 0.1 + i * 0.125;
        return (
          <g key={i}>
            <path d={`M22,26 L${x + 5.5},${y + 5.5}`} stroke={EDGE} strokeWidth={0.6} />
            <path className="i-fade" style={at(d)} d={`M22,26 L${x + 5.5},${y + 5.5}`} stroke={PINK} strokeWidth={0.9} />
            <rect x={x} y={y} width={11} height={11} rx={2.6} fill={CELL} stroke={EDGE} strokeWidth={0.6} />
            <rect className="i-pop" style={at(d + 0.06)} x={x} y={y} width={11} height={11} rx={2.6} fill={i % 2 === 0 ? PINK : tint} />
            <g transform={`translate(${x} ${y})`}>{mark}</g>
            <Check cx={x + 10.4} cy={y + 0.8} r={2.4} d={d + 0.12} fill="#fff" />
          </g>
        );
      })}
    </g>
  );
}
