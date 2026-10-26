// Scripting screens: three hooks and one winner, a script filling in, a voice match.

import { at, Check, CELL, EDGE, INK, LILAC, Lines, PINK, Star, Wave, WAVE_A, type SceneProps } from "./bits";

const HOOK_Y = [4.5, 20, 35.5] as const;
const PICK = 1;

export function HookWriter({ tint }: SceneProps) {
  return (
    <g>
      {HOOK_Y.map((y, i) => (
        <g key={y}>
          <rect className="i-pop" style={at(0.03 + i * 0.2)} x={5} y={y} width={62} height={12} rx={2.4} fill={CELL} stroke={EDGE} strokeWidth={0.6} />
          <circle className="i-pop" style={at(0.06 + i * 0.2)} cx={11} cy={y + 6} r={2.4} fill={i === PICK ? PINK : tint} />
          <Lines x={16.5} y={y + 3.4} widths={[[42, 30], [44, 36], [38, 26]][i]!} gap={4} h={1.9} d0={0.1 + i * 0.2} step={0.07} fill={INK} />
          {i !== PICK && <rect className="i-fade" style={at(0.74)} x={4.5} y={y - 0.5} width={63} height={13} fill="#0b0712" opacity={0.62} />}
        </g>
      ))}
      <g className="i-pop" style={at(0.76)}>
        <rect x={4} y={HOOK_Y[PICK] - 1} width={64} height={14} rx={3} fill="none" stroke={PINK} strokeWidth={1.6} />
        <Star cx={61.5} cy={HOOK_Y[PICK] + 6} s={1.05} />
      </g>
    </g>
  );
}

const PAGE_LINES = [32, 30, 32, 26, 31, 29, 32, 24, 17] as const;

export function ScriptWriter({ tint }: SceneProps) {
  return (
    <g>
      <rect x={6} y={3.5} width={41} height={46} rx={2} fill="#f4eeff" />
      <rect x={10} y={7.5} width={15} height={3} rx={1.5} fill={PINK} />
      <Lines x={10} y={14} widths={PAGE_LINES} gap={3.7} h={1.8} d0={0.05} step={0.095} fill="#6d5b96" />
      <rect className="loop-blink" x={28.2} y={43} width={1.6} height={3.2} fill={PINK} />
      {[6, 20.5, 35].map((y, i) => (
        <g key={y}>
          <rect x={52} y={y} width={15} height={11.5} rx={2.2} fill={CELL} stroke={EDGE} strokeWidth={0.6} />
          <rect className="i-fade" style={at(0.28 + i * 0.27)} x={52} y={y} width={15} height={11.5} rx={2.2} fill={tint} />
          <rect x={55} y={y + 4.8} width={9} height={1.9} rx={0.95} fill={INK} opacity={0.9} />
        </g>
      ))}
    </g>
  );
}

export function VoiceCheck({ tint }: SceneProps) {
  return (
    <g>
      <circle cx={8.5} cy={12} r={3.2} fill={LILAC} />
      <Wave x={15} cy={12} heights={WAVE_A} gap={3.8} w={2.1} fill={LILAC} loop={false} />
      <circle cx={8.5} cy={28} r={3.2} fill={PINK} />
      <g>
        {WAVE_A.map((h, i) => (
          <rect key={i} className="i-pop" style={at(0.1 + i * 0.045)} x={15 + i * 3.8} y={28 - h / 2} width={2.1} height={h} rx={1.05} fill={PINK} />
        ))}
      </g>
      <rect x={6} y={41} width={46} height={4.4} rx={2.2} fill={CELL} stroke={EDGE} strokeWidth={0.5} />
      <rect className="i-grow" style={at(0.2, 0.56)} x={6} y={41} width={46} height={4.4} rx={2.2} fill={tint} />
      <Check cx={62} cy={43.2} r={5.4} d={0.8} />
    </g>
  );
}
