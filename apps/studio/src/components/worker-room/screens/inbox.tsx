// Inbox screens: comments getting replies, a comment turning into a DM, a lead being saved.

import { at, Bubble, Check, CELL, EDGE, Heart, INK, LILAC, PINK, VIOLET, type SceneProps } from "./bits";

export function CommentReplies({ tint }: SceneProps) {
  return (
    <g>
      {[0, 1, 2].map((i) => {
        const y = 3 + i * 16.4;
        return (
          <g key={i}>
            <Bubble x={5} y={y} w={36} h={6.8} fill="#4d3a86" d={0.04 + i * 0.3}>
              <circle cx={37.4} cy={y + 3.4} r={1.5} fill={LILAC} />
            </Bubble>
            <Bubble x={31} y={y + 8.2} w={36} h={6.8} fill={i === 1 ? PINK : tint} d={0.18 + i * 0.3} ink="#fff" />
          </g>
        );
      })}
      <g className="i-pop" style={at(0.9)}>
        <Heart cx={10} cy={46.4} s={1.1} />
      </g>
    </g>
  );
}

export function DmCloser({ tint }: SceneProps) {
  return (
    <g>
      <Bubble x={4} y={8} w={25} h={11} fill="#4d3a86" d={0.04}>
        <Heart cx={24.4} cy={13.4} s={0.8} />
      </Bubble>
      <path className="i-pop" style={at(0.2)} d="M8,38 L22.4,31 L17.4,44 L15.6,39 Z" fill={PINK} />
      <path className="i-grow" style={at(0.24, 0.1)} d="M30.5,26 H36.4 M34.2,23.6 L36.6,26 L34.2,28.4" fill="none" stroke={INK} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" />
      <rect x={39} y={3} width={29} height={46.6} rx={3} fill="#1d1236" stroke={EDGE} strokeWidth={0.8} />
      <circle cx={44} cy={8} r={2.4} fill={LILAC} />
      <rect x={48} y={7} width={12} height={2} rx={1} fill={EDGE} />
      <Bubble x={42} y={13} w={17} h={6.6} fill="#4d3a86" d={0.34} />
      <Bubble x={48} y={22} w={17} h={6.6} fill={tint} d={0.5} ink="#fff" />
      <Bubble x={42} y={31} w={13} h={6.6} fill="#4d3a86" d={0.66} />
      <Bubble x={46} y={40} w={19} h={6.6} fill={PINK} d={0.82} ink="#fff" />
    </g>
  );
}

export function LeadLogger({ tint }: SceneProps) {
  return (
    <g>
      <g className="i-pop" style={at(0.04)}>
        <rect x={4} y={11} width={24} height={30} rx={2.6} fill="#f4eeff" />
        <circle cx={16} cy={20.6} r={4.8} fill={VIOLET} />
        <rect x={8} y={29.4} width={16} height={2.2} rx={1.1} fill="#6d5b96" />
        <rect x={10} y={34} width={12} height={2.2} rx={1.1} fill="#a898c8" />
      </g>
      <path className="i-grow" style={at(0.26, 0.1)} d="M29.6,26 H35 M32.8,23.6 L35.2,26 L32.8,28.4" fill="none" stroke={INK} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" />
      <rect x={37} y={4} width={31} height={44.6} rx={2.4} fill="#1d1236" stroke={EDGE} strokeWidth={0.8} />
      <rect x={37} y={4} width={31} height={5.6} rx={2.4} fill={EDGE} />
      {[0, 1, 2, 3, 4].map((i) => {
        const y = 12.4 + i * 7;
        const fresh = i === 3;
        if (i === 4) return <path key={i} d={`M39,${y - 1.2} H66`} stroke={EDGE} strokeWidth={0.5} />;
        return (
          <g key={i}>
            <path d={`M39,${y - 1.2} H66`} stroke={EDGE} strokeWidth={0.5} />
            {fresh && <rect className="i-grow" style={at(0.46, 0.14)} x={38} y={y - 0.6} width={29} height={5.8} rx={1.2} fill={tint} opacity={0.5} />}
            <g className={fresh ? "i-fade" : undefined} style={at(0.58)} opacity={fresh ? 1 : 0.55}>
              <circle cx={41.4} cy={y + 2.2} r={1.5} fill={fresh ? "#fff" : LILAC} />
              <rect x={44.6} y={y + 1.2} width={9} height={2} rx={1} fill={fresh ? "#fff" : CELL} stroke={fresh ? "none" : EDGE} strokeWidth={0.4} />
              <rect x={55.4} y={y + 1.2} width={6} height={2} rx={1} fill={fresh ? PINK : CELL} stroke={fresh ? "none" : EDGE} strokeWidth={0.4} />
            </g>
          </g>
        );
      })}
      <Check cx={63.6} cy={35.6} r={3.2} d={0.78} />
    </g>
  );
}
