"use client";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { usePacing } from "./pacing";
import { useShowcaseReduced } from "./reduced";
import { EASE_SIGNAL, GAP_CENTER_DEG, GAP_DEG, SIGNAL_BLOOM_FILTER, arcPath } from "./tokens";

/**
 * Moment 7, autopilot engaged (~1.4s): the AttentionOS ring with its gap at 1 o'clock; the Signal closes the gap, the
 * bloom intensifies for a beat, then the ring contracts. It stays closed while autopilot is on (`closed`).
 * Pass `contractTo` (px) to finish at a monogram ring's size.
 */
export function AutopilotRing({ play, closed, size = 120, contractTo, strokeWidth = 2 }: { play: boolean; closed: boolean; size?: number; contractTo?: number; strokeWidth?: number }) {
  const reduced = useShowcaseReduced();
  const pace = usePacing();
  const [run, setRun] = useState(play ? 1 : 0);
  const prev = useRef(play);
  useEffect(() => {
    if (play && !prev.current) setRun((r) => r + 1);
    prev.current = play;
  }, [play]);
  const animate = play && !reduced && run > 0;
  const s = (ms: number) => ms / 1000 / pace;

  const c = size / 2;
  const r = c - strokeWidth * 2;
  const gapStart = GAP_CENTER_DEG - GAP_DEG / 2;
  const base = arcPath(c, c, r, GAP_CENTER_DEG + GAP_DEG / 2, gapStart + 360);
  // The closing stroke: the Signal travels across the gap from its trailing end.
  const bridge = arcPath(c, c, r, gapStart - 0.5, GAP_CENTER_DEG + GAP_DEG / 2 + 0.5);
  const endScale = contractTo ? contractTo / size : 0.86;
  const isClosed = closed || play;

  return (
    <motion.div
      key={run}
      aria-label={isClosed ? "Autopilot on" : "Autopilot off"}
      role="img"
      initial={{ scale: 1 }}
      animate={animate ? { scale: [1, 1, 1.04, endScale] } : { scale: play ? endScale : 1 }}
      transition={animate ? { duration: s(1400), times: [0, 0.55, 0.7, 1], ease: [0.7, 0, 0.2, 1] } : { duration: reduced && play ? 0.2 : 0 }}
      style={{ width: size, height: size, display: "inline-block" }}
    >
      <div style={{ position: "relative", width: size, height: size }}>
        {/* Bloom layers: steady during the sequence, intensifying for one beat as the gap closes, then gone. */}
        {animate && (
          <>
            <motion.svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ position: "absolute", inset: 0, overflow: "visible", filter: SIGNAL_BLOOM_FILTER }} initial={{ opacity: 1 }} animate={{ opacity: [1, 1, 0] }} transition={{ duration: s(1400), times: [0, 0.6, 1] }}>
              <path d={base} fill="none" stroke="var(--brand)" strokeWidth={strokeWidth} />
            </motion.svg>
            <motion.svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ position: "absolute", inset: 0, overflow: "visible", filter: "drop-shadow(0 0 10px rgba(149, 74, 251, 0.85)) drop-shadow(0 0 28px rgba(149, 74, 251, 0.6))" }} initial={{ opacity: 0 }} animate={{ opacity: [0, 0, 1, 0] }} transition={{ duration: s(1400), times: [0, 0.5, 0.6, 0.85] }}>
              <circle cx={c} cy={c} r={r} fill="none" stroke="var(--brand)" strokeWidth={strokeWidth} />
            </motion.svg>
          </>
        )}
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: "absolute", inset: 0, overflow: "visible", display: "block" }}>
          <path d={base} fill="none" stroke="var(--brand)" strokeWidth={strokeWidth} />
          <motion.path
            d={bridge}
            fill="none"
            stroke="var(--brand)"
            strokeWidth={strokeWidth}
            initial={{ pathLength: animate ? 0 : isClosed ? 1 : 0 }}
            animate={{ pathLength: isClosed ? 1 : 0 }}
            transition={animate ? { delay: s(150), duration: s(650), ease: EASE_SIGNAL } : { duration: reduced ? 0.2 : 0 }}
          />
        </svg>
      </div>
    </motion.div>
  );
}
