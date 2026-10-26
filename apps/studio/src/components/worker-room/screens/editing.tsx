// Editing screens: a timeline being cut, captions popping on, one video fanning into ten.

import type { CSSProperties } from "react";
import { at, from, CELL, EDGE, INK, LILAC, MAGENTA, PINK, Thumb, VIOLET, Wave, type SceneProps } from "./bits";

const shift = (d: number, tx: number): CSSProperties => ({ "--d": d, "--tx": `${tx}px` }) as CSSProperties;

export function Cutter({ tint }: SceneProps) {
  return (
    <g>
      <Thumb x={5} y={5} w={14} h={25} n={2} />
      <path d="M24,8 H68 M24,6.5 V9.5 M35,7 V9 M46,6.5 V9.5 M57,7 V9 M68,6.5 V9.5" stroke={EDGE} strokeWidth={0.7} fill="none" />
      <rect x={24} y={13} width={44} height={10} rx={1.5} fill={CELL} />
      <rect x={24} y={13} width={14} height={10} rx={1.5} fill={VIOLET} />
      <rect className="i-out" style={at(0.46)} x={38.6} y={13} width={9.8} height={10} rx={1.5} fill="#5a2a55" />
      <g className="i-shift" style={shift(0.6, -10.4)}>
        <rect x={49} y={13} width={19} height={10} rx={1.5} fill={VIOLET} />
        <rect x={49} y={26} width={19} height={6.5} rx={1.5} fill={CELL} stroke={EDGE} strokeWidth={0.5} />
        <Wave x={50.5} cy={29.2} heights={[3, 4.5, 2.5, 5, 3.5, 4]} gap={2.9} w={1.5} fill={LILAC} loop={false} />
      </g>
      <rect x={24} y={26} width={14} height={6.5} rx={1.5} fill={CELL} stroke={EDGE} strokeWidth={0.5} />
      <Wave x={25.5} cy={29.2} heights={[4, 2.5, 5, 3, 4.5]} gap={2.6} w={1.5} fill={LILAC} loop={false} />
      <path className="i-pop" style={at(0.24)} d="M38.3,11 V34.5" stroke="#fff" strokeWidth={1.1} />
      <path className="i-pop" style={at(0.36)} d="M48.7,11 V34.5" stroke="#fff" strokeWidth={1.1} />
      {[24, 34, 45].map((x, i) => (
        <rect key={x} className="i-pop" style={at(0.72 + i * 0.07)} x={x} y={37} width={[8, 9, 7][i]} height={4.4} rx={1.2} fill={i === 1 ? PINK : tint} />
      ))}
      <g className="i-move" style={from(0, 0.92, -42, 0)}>
        <path d="M66,10 V44" stroke={PINK} strokeWidth={1} />
        <path d="M63.6,8 H68.4 L66,11.6 Z" fill={PINK} />
      </g>
      <rect x={5} y={34} width={14} height={2.2} rx={1.1} fill={CELL} />
      <rect className="i-grow" style={at(0, 0.92)} x={5} y={34} width={14} height={2.2} rx={1.1} fill={PINK} />
    </g>
  );
}

const WORDS: readonly (readonly [number, number, number, boolean, number])[] = [
  [27.2, 32, 5.6, false, 0.18],
  [33.6, 32, 7.2, true, 0.36],
  [41.6, 32, 5, false, 0.52],
  [29.6, 37.6, 8, false, 0.68],
  [38.4, 37.6, 6.4, true, 0.84],
];

export function Captions({ tint }: SceneProps) {
  return (
    <g>
      <rect x={24.6} y={2.6} width={22.8} height={47.4} rx={3} fill="#05030a" stroke={EDGE} strokeWidth={0.8} />
      <Thumb x={26} y={4} w={20} h={44.6} n={7} edge="none" />
      {WORDS.map(([x, y, w, hot, d]) => (
        <rect key={`${x}-${y}`} className="i-pop" style={at(d)} x={x} y={y} width={w} height={4.2} rx={1} fill={hot ? PINK : "#fff"} />
      ))}
      <Wave x={5} cy={26} heights={[6, 12, 8, 16, 10, 7]} gap={3} w={1.9} fill={tint === MAGENTA ? PINK : tint} />
      <text x={59.5} y={22} textAnchor="middle" fontSize={12} fontWeight={700} fill={INK}>
        Aa
      </text>
      {[54, 59.5, 65].map((cx, i) => (
        <circle key={cx} cx={cx} cy={33} r={2.5} fill={["#fff", PINK, VIOLET][i]} />
      ))}
      <circle className="i-pop" style={at(0.4)} cx={59.5} cy={33} r={4.1} fill="none" stroke="#fff" strokeWidth={0.9} />
    </g>
  );
}

const WASH = ["none", PINK, VIOLET, "#ffffff", MAGENTA, VIOLET, "none", PINK, "#000000", MAGENTA] as const;

export function Remix({ tint }: SceneProps) {
  return (
    <g>
      {WASH.map((wash, i) => {
        const x = 5 + (i % 5) * 12.8;
        const y = 5 + Math.floor(i / 5) * 22;
        return (
          <g key={i} className="i-move" style={from(0.08 + i * 0.065, 0.2, 30.6 - x, 16 - y, 0.5, 0)}>
            <Thumb x={x} y={y} w={10.8} h={19} n={3} edge={tint} />
            {wash !== "none" && <rect x={x} y={y} width={10.8} height={19} fill={wash} opacity={0.3} />}
            <rect x={x + 1.6} y={y + 3 + ((i * 5) % 11)} width={7.6} height={2} rx={0.6} fill={i % 3 === 1 ? PINK : "#fff"} />
          </g>
        );
      })}
    </g>
  );
}
