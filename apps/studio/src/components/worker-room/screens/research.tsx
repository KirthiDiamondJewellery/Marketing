// Research screens: a feed being scanned, a rival video being measured, a video being read.

import { at, from, Check, EDGE, CELL, Lines, LILAC, PINK, Star, Thumb, VIOLET, Wave, WAVE_A, type SceneProps } from "./bits";

const SCAN_X = [5, 21.5, 38, 54.5] as const;
const TREND_BARS = [6, 9, 15, 7] as const;
const WIN = 2;

export function TrendScout({ tint }: SceneProps) {
  return (
    <g>
      {SCAN_X.map((x, i) => (
        <g key={x}>
          <Thumb x={x} y={4} w={12.5} h={22} n={[0, 4, 6, 9][i]!} />
          <rect className="i-fade" style={at(0.08 + i * 0.13)} x={x} y={4} width={12.5} height={22} fill="none" stroke="#fff" strokeWidth={0.9} />
          {i !== WIN && <rect className="i-fade" style={at(0.7)} x={x} y={4} width={12.5} height={22} fill="#0b0712" opacity={0.62} />}
          <rect className="i-rise" style={at(0.2 + i * 0.13, 0.12)} x={x} y={48 - TREND_BARS[i]!} width={12.5} height={TREND_BARS[i]!} rx={1} fill={i === WIN ? PINK : tint} opacity={i === WIN ? 1 : 0.55} />
        </g>
      ))}
      <g className="i-out" style={at(0.62)}>
        <g className="i-move" style={from(0.04, 0.56, -62, 0)}>
          <rect x={56} y={2.5} width={10} height={25} fill="url(#wr-scan-fade)" />
          <rect x={65.4} y={2.5} width={1.4} height={25} fill={PINK} />
        </g>
      </g>
      <g className="i-pop" style={at(0.72)}>
        <rect x={SCAN_X[WIN] - 1} y={3} width={14.5} height={24} fill="none" stroke={PINK} strokeWidth={1.6} rx={1} />
        <circle cx={SCAN_X[WIN] + 12} cy={5} r={4.2} fill={PINK} />
        <path d={`M${SCAN_X[WIN] + 12},7.2 v-4.4 m-2,2 l2,-2 l2,2`} fill="none" stroke="#fff" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
  );
}

const METRICS = [30, 18, 26, 12] as const;

export function CompetitorWatch({ tint }: SceneProps) {
  return (
    <g>
      <Thumb x={5} y={6} w={22} h={39} n={1} />
      <path className="i-pop" style={at(0.08)} d="M3,12 V4 H11 M21,4 H29 V12 M29,39 V47 H21 M11,47 H3 V39" fill="none" stroke={PINK} strokeWidth={1.3} strokeLinecap="round" />
      <g className="i-out" style={at(0.62)}>
        <rect className="i-move" style={from(0.1, 0.5, 0, -36)} x={5} y={42} width={22} height={1.6} fill={PINK} />
      </g>
      {METRICS.map((w, i) => (
        <g key={i}>
          <circle cx={34.5} cy={11 + i * 9} r={1.7} fill={i === 2 ? PINK : LILAC} />
          <rect x={39} y={9 + i * 9} width={29} height={4} rx={2} fill={CELL} stroke={EDGE} strokeWidth={0.5} />
          <rect className="i-grow" style={at(0.3 + i * 0.1, 0.15)} x={39} y={9 + i * 9} width={w * 0.95} height={4} rx={2} fill={i === 2 ? PINK : tint} />
        </g>
      ))}
      <g className="i-pop" style={at(0.82)}>
        <Star cx={64} cy={45.5} s={1.15} />
      </g>
    </g>
  );
}

export function TranscriptReader({ tint }: SceneProps) {
  return (
    <g>
      <Thumb x={5} y={5} w={18} h={32} n={5} />
      <path d="M11.6,17.4 L17.6,21 L11.6,24.6 Z" fill="#fff" opacity={0.92} />
      <rect x={5} y={40.5} width={18} height={2.2} rx={1.1} fill={CELL} />
      <rect className="i-grow" style={at(0.04, 0.88)} x={5} y={40.5} width={18} height={2.2} rx={1.1} fill={PINK} />
      <Wave x={28} cy={10} heights={WAVE_A} fill={tint === VIOLET ? LILAC : tint} />
      <Lines x={28} y={20} widths={[38, 34, 36]} gap={5} d0={0.12} step={0.12} />
      <rect className="i-grow" style={at(0.48, 0.08)} x={28} y={35} width={28} height={2} rx={1} fill={PINK} />
      <Lines x={28} y={40} widths={[37, 22]} gap={5} d0={0.6} step={0.12} />
      <Check cx={64.5} cy={45.5} r={4} d={0.86} />
    </g>
  );
}
