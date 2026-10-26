"use client";
import { useRef } from "react";
import { useFrame } from "./frame";
import { useShowcaseReduced } from "./reduced";
import { GAP_DEG, SIGNAL_BLOOM_FILTER, ringPath } from "./tokens";

/**
 * The AttentionOS ring: the Signal drawn as a circle broken by the signature gap at 1 o'clock (DESIGN §10).
 * `sweep` adds a brighter arc that glides around the ring (command view); `bloom` is for showcase moments only.
 */
export function SignalRing({
  size = 96,
  strokeWidth = 2,
  closed = false,
  sweep = false,
  bloom = false,
  periodMs = 9000,
  dim = 0.42,
  className,
}: {
  size?: number;
  strokeWidth?: number;
  closed?: boolean;
  sweep?: boolean;
  bloom?: boolean;
  periodMs?: number;
  /** Opacity of the base ring when `sweep` is on. */
  dim?: number;
  className?: string;
}) {
  const reduced = useShowcaseReduced();
  const arc = useRef<SVGPathElement>(null);
  const c = size / 2;
  const r = c - strokeWidth - (bloom ? 0 : 0);
  const d = ringPath(c, c, r, closed ? 0.0001 : GAP_DEG);
  const len = 2 * Math.PI * r * (closed ? 1 : (360 - GAP_DEG) / 360);
  const seg = len * 0.22;

  useFrame((t) => {
    const el = arc.current;
    if (!el) return;
    const p = (t % periodMs) / periodMs;
    // Travel through the full path plus the segment length so the arc slides into and out of the gap.
    el.style.strokeDashoffset = String(seg - p * (len + seg));
  }, sweep && !reduced);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={className} style={{ overflow: "visible", filter: bloom ? SIGNAL_BLOOM_FILTER : undefined }}>
      <path d={d} fill="none" stroke="var(--brand)" strokeWidth={strokeWidth} strokeLinecap="butt" opacity={sweep && !reduced ? dim : 1} />
      {sweep && !reduced && (
        <path ref={arc} d={d} fill="none" stroke="var(--brand)" strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={`${seg} ${len + seg}`} strokeDashoffset={seg} />
      )}
    </svg>
  );
}
