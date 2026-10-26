// Planning screens: ideas sorted and one picked, the lanes brought into balance, today's film list ticking off.

import { at, from, Check, CELL, EDGE, INK, LILAC, Lines, PINK, Star, Thumb, VIOLET, type SceneProps } from "./bits";

const IDEA_X = [5, 21, 37, 53] as const;
const PICKED = 2;

export function IdeaPicker({ tint }: SceneProps) {
  return (
    <g>
      {IDEA_X.map((x, i) => (
        <g key={x} className="i-move" style={from(0.04 + i * 0.1, 0.18, 0, 14, 0.7, 0)}>
          <rect x={x} y={5} width={14} height={30} rx={2} fill={CELL} stroke={EDGE} strokeWidth={0.6} />
          <Thumb x={x + 1.5} y={6.5} w={11} h={14} n={i + 2} edge="none" />
          <rect x={x + 2} y={23.5} width={10} height={1.8} rx={0.9} fill={INK} opacity={0.85} />
          <rect x={x + 2} y={27} width={7} height={1.8} rx={0.9} fill={LILAC} opacity={0.6} />
          {i !== PICKED && <rect className="i-fade" style={at(0.7)} x={x - 0.5} y={4.5} width={15} height={31} rx={2} fill="#0b0712" opacity={0.6} />}
        </g>
      ))}
      <g className="i-pop" style={at(0.66)}>
        <rect x={IDEA_X[PICKED] - 1.6} y={3.4} width={17.2} height={33.2} rx={2.6} fill="none" stroke={PINK} strokeWidth={1.6} />
        <Star cx={IDEA_X[PICKED] + 12.6} cy={5} s={1.05} />
      </g>
      <rect x={5} y={41} width={62} height={6.4} rx={2} fill={CELL} stroke={EDGE} strokeWidth={0.5} />
      <rect className="i-grow" style={at(0.74, 0.16)} x={5} y={41} width={40} height={6.4} rx={2} fill={tint} />
      <rect className="i-pop" style={at(0.86)} x={8} y={43.3} width={18} height={1.8} rx={0.9} fill="#fff" />
    </g>
  );
}

const LANES = [
  { from: 34, to: 22, c: PINK },
  { from: 10, to: 20, c: VIOLET },
  { from: 26, to: 18, c: LILAC },
  { from: 6, to: 16, c: "#6d7cff" },
] as const;

export function LaneBalance({ tint }: SceneProps) {
  return (
    <g>
      {LANES.map((l, i) => {
        const y = 6 + i * 9.4;
        return (
          <g key={i}>
            <circle cx={8} cy={y + 2.6} r={2.2} fill={l.c} />
            <rect x={13} y={y} width={48} height={5.2} rx={2.6} fill={CELL} stroke={EDGE} strokeWidth={0.5} />
            <rect x={13} y={y} width={l.from * 1.4} height={5.2} rx={2.6} fill={l.c} opacity={0.35} />
            <rect className="i-grow" style={at(0.18 + i * 0.12, 0.2)} x={13} y={y} width={l.to * 1.4} height={5.2} rx={2.6} fill={i === 1 ? tint : l.c} />
          </g>
        );
      })}
      <path d="M41,4 V43" stroke="#fff" strokeWidth={0.7} strokeDasharray="1.6 2" opacity={0.6} />
      <Check cx={64} cy={45} r={4.4} d={0.84} />
    </g>
  );
}

export function FilmList({ tint }: SceneProps) {
  return (
    <g>
      <rect x={4} y={3} width={42} height={46.6} rx={2.4} fill="#f4eeff" />
      <rect x={8} y={7} width={16} height={3} rx={1.5} fill={PINK} />
      {[0, 1, 2, 3].map((i) => {
        const y = 15 + i * 8.4;
        return (
          <g key={i}>
            <rect x={8} y={y} width={4.4} height={4.4} rx={1} fill="none" stroke="#6d5b96" strokeWidth={0.7} />
            <path className="i-pop" style={at(0.3 + i * 0.16)} d={`M8.9,${y + 2.3} l1.3,1.4 l2.4,-2.9`} fill="none" stroke={tint} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
            <Lines x={15} y={y + 1.2} widths={[[26], [22], [27], [20]][i]!} gap={0} h={1.8} d0={0.06 + i * 0.16} step={0.04} fill="#6d5b96" />
          </g>
        );
      })}
      <circle cx={58.5} cy={16} r={9} fill={CELL} stroke={EDGE} strokeWidth={0.7} />
      <circle cx={58.5} cy={16} r={3.6} fill="none" stroke={INK} strokeWidth={1} />
      <circle className="loop-blink" cx={58.5} cy={16} r={1.6} fill={PINK} />
      {[0, 1, 2].map((i) => (
        <rect key={i} className="i-pop" style={at(0.5 + i * 0.12)} x={50} y={31 + i * 6} width={17} height={4.2} rx={1.2} fill={i === 0 ? PINK : tint} />
      ))}
    </g>
  );
}
