"use client";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check } from "lucide-react";
import { PlatformGlyph, PLATFORM_NAMES } from "./PlatformGlyph";
import { usePacing } from "./pacing";
import { useShowcaseReduced } from "./reduced";
import { EASE_OUT, EASE_SIGNAL, SIGNAL_BLOOM_FILTER, SNAP } from "./tokens";

const ROW = 44;
const W = 300;

/**
 * Moment 4, go live (~1.6s): the card compresses and releases, the Signal shoots out of its left edge and splits into one
 * beam per platform, each platform lights with a ring ripple 80ms apart, and "Live on N platforms" rolls up with a
 * success check. `play` restarts it; when not playing it shows the published end state.
 */
export function GoLiveBurst({
  platforms,
  play,
  onDone,
  compact = false,
  layout = "column",
}: {
  platforms: string[];
  play: boolean;
  onDone?: () => void;
  compact?: boolean;
  /** "row": the Signal leaves from the bottom-left corner and fans up into a row of platforms (command view dial). */
  layout?: "column" | "row";
}) {
  const reduced = useShowcaseReduced();
  const pace = usePacing();
  const [run, setRun] = useState(play ? 1 : 0);
  const prev = useRef(play);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (play && !prev.current) setRun((r) => r + 1);
    prev.current = play;
  }, [play]);
  const animate = play && !reduced && run > 0;

  useEffect(() => {
    if (!play || run === 0) return;
    const t = setTimeout(() => done.current?.(), reduced ? 200 : 1600 / pace);
    return () => clearTimeout(t);
  }, [run, play, reduced, pace]);

  const list = platforms.length ? platforms : ["instagram"];
  const n = list.length;
  if (layout === "row") return <BurstRow key={run} list={list} animate={animate} pace={pace} />;
  const row = compact ? 36 : ROW;
  const H = n * row;
  const mid = H / 2;
  const split = W * 0.34;
  const ix = W - 150;
  const s = (ms: number) => (animate ? ms / 1000 / pace : 0);

  return (
    <motion.div
      key={run}
      role="status"
      aria-label={`Live on ${n} ${n === 1 ? "platform" : "platforms"}`}
      initial={{ scale: 1 }}
      animate={animate ? { scale: [1, 0.97, 1] } : { scale: 1 }}
      transition={animate ? { duration: s(260), times: [0, 0.45, 1], ease: EASE_OUT } : { duration: 0 }}
      style={{ width: W, display: "grid", gap: 12 }}
    >
      <div style={{ position: "relative", height: H }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden style={{ position: "absolute", inset: 0, overflow: "visible", filter: SIGNAL_BLOOM_FILTER }}>
          {/* The card edge the Signal leaves from. */}
          <motion.line
            x1={1}
            x2={1}
            y1={mid - Math.min(H / 2, 28)}
            y2={mid + Math.min(H / 2, 28)}
            stroke="var(--brand)"
            strokeWidth={2}
            initial={{ opacity: animate ? 1 : 0 }}
            animate={{ opacity: 0 }}
            transition={{ delay: s(520), duration: s(300) }}
          />
          {animate && (
            <>
              <motion.path
                d={`M 1 ${mid} L ${split} ${mid}`}
                fill="none"
                stroke="var(--brand)"
                strokeWidth={2}
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 1 }}
                animate={{ pathLength: 1, opacity: [1, 1, 0] }}
                transition={{ pathLength: { delay: s(140), duration: s(220), ease: EASE_SIGNAL }, opacity: { delay: s(140), duration: s(900), times: [0, 0.7, 1] } }}
              />
              {list.map((p, i) => {
                const y = row * i + row / 2;
                return (
                  <motion.path
                    key={p + i}
                    d={`M ${split} ${mid} C ${split + 50} ${mid}, ${ix - 70} ${y}, ${ix - 18} ${y}`}
                    fill="none"
                    stroke="var(--brand)"
                    strokeWidth={2}
                    strokeLinecap="round"
                    initial={{ pathLength: 0, opacity: 1 }}
                    animate={{ pathLength: 1, opacity: [1, 1, 0] }}
                    transition={{ pathLength: { delay: s(340), duration: s(380), ease: EASE_SIGNAL }, opacity: { delay: s(340), duration: s(900), times: [0, 0.6, 1] } }}
                  />
                );
              })}
            </>
          )}
        </svg>
        {list.map((p, i) => {
          const y = row * i + row / 2;
          const at = 700 + 80 * i;
          return (
            <div key={p + i} style={{ position: "absolute", left: ix - 16, top: y - 16, display: "flex", alignItems: "center", gap: 10, height: 32 }}>
              <span style={{ position: "relative", width: 32, height: 32, display: "grid", placeItems: "center" }}>
                <motion.span
                  initial={{ opacity: animate ? 0 : 1 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: s(at), duration: s(160) }}
                  style={{ position: "absolute", inset: 0, borderRadius: 999, background: "var(--brand-tint)" }}
                />
                {animate && (
                  <motion.span
                    initial={{ scale: 1, opacity: 0 }}
                    animate={{ scale: 1.9, opacity: [0, 0.9, 0] }}
                    transition={{ delay: s(at), duration: s(520), ease: EASE_OUT }}
                    style={{ position: "absolute", inset: 0, borderRadius: 999, border: "1.5px solid var(--brand)" }}
                  />
                )}
                <motion.span
                  initial={{ color: animate ? "var(--text-muted)" : "var(--text-on-tint)" }}
                  animate={{ color: "var(--text-on-tint)" }}
                  transition={{ delay: s(at), duration: s(160) }}
                  style={{ position: "relative", display: "grid" }}
                >
                  <PlatformGlyph platform={p} />
                </motion.span>
              </span>
              <motion.span
                initial={{ opacity: animate ? 0.4 : 1 }}
                animate={{ opacity: 1 }}
                transition={{ delay: s(at), duration: s(160) }}
                style={{ fontSize: 13, lineHeight: "20px", color: "var(--text-primary)" }}
              >
                {PLATFORM_NAMES[p.toLowerCase()] ?? p}
              </motion.span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, lineHeight: "24px", color: "var(--text-primary)", fontWeight: 500 }}>
        <motion.span
          initial={{ scale: animate ? 0 : 1, opacity: animate ? 0 : 1 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={animate ? { ...SNAP, delay: s(1250) } : { duration: 0 }}
          style={{ width: 20, height: 20, borderRadius: 999, display: "grid", placeItems: "center", background: "var(--success)", color: "var(--bg)" }}
        >
          <Check size={13} strokeWidth={2.5} />
        </motion.span>
        <motion.span initial={{ opacity: animate ? 0 : 1 }} animate={{ opacity: 1 }} transition={{ delay: s(880), duration: s(200) }}>
          Live on <Roll to={n} delayMs={animate ? 900 / pace : 0} durMs={animate ? 420 / pace : 0} /> {n === 1 ? "platform" : "platforms"}
        </motion.span>
      </div>
    </motion.div>
  );
}

const GAP = 40;
const X0 = 40;
const OY = 40;

function BurstRow({ list, animate, pace }: { list: string[]; animate: boolean; pace: number }) {
  const n = list.length;
  const s = (ms: number) => (animate ? ms / 1000 / pace : 0);
  const textX = X0 + (n - 1) * GAP + 30;
  return (
    <div role="status" aria-label={`Live on ${n} ${n === 1 ? "platform" : "platforms"}`} style={{ position: "relative", width: textX + 190, height: OY + 4 }}>
      <svg width={textX} height={OY + 4} aria-hidden style={{ position: "absolute", inset: 0, overflow: "visible", filter: SIGNAL_BLOOM_FILTER }}>
        {animate &&
          list.map((p, i) => {
            const x = X0 + i * GAP;
            return (
              <motion.path
                key={p + i}
                d={`M 0 ${OY} C ${x * 0.5} ${OY}, ${x} ${OY - 2}, ${x} 34`}
                fill="none"
                stroke="var(--brand)"
                strokeWidth={2}
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 1 }}
                animate={{ pathLength: 1, opacity: [1, 1, 0] }}
                transition={{ pathLength: { delay: s(120 + i * 40), duration: s(520), ease: EASE_SIGNAL }, opacity: { delay: s(120), duration: s(1100), times: [0, 0.65, 1] } }}
              />
            );
          })}
      </svg>
      {list.map((p, i) => {
        const at = 620 + 80 * i;
        return (
          <span key={p + i} style={{ position: "absolute", left: X0 + i * GAP - 16, top: 2, width: 32, height: 32, display: "grid", placeItems: "center" }}>
            <motion.span initial={{ opacity: animate ? 0 : 1 }} animate={{ opacity: 1 }} transition={{ delay: s(at), duration: s(160) }} style={{ position: "absolute", inset: 0, borderRadius: 999, background: "var(--brand-tint)" }} />
            {animate && (
              <motion.span
                initial={{ scale: 1, opacity: 0 }}
                animate={{ scale: 1.9, opacity: [0, 0.9, 0] }}
                transition={{ delay: s(at), duration: s(520), ease: EASE_OUT }}
                style={{ position: "absolute", inset: 0, borderRadius: 999, border: "1.5px solid var(--brand)" }}
              />
            )}
            <motion.span initial={{ opacity: animate ? 0 : 1 }} animate={{ opacity: 1 }} transition={{ delay: s(at), duration: s(160) }} style={{ position: "relative", display: "grid", color: "var(--text-on-tint)" }}>
              <PlatformGlyph platform={p} />
            </motion.span>
          </span>
        );
      })}
      <motion.div
        initial={{ opacity: animate ? 0 : 1, x: animate ? -6 : 0 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: s(820 + n * 40), duration: s(260), ease: EASE_OUT }}
        style={{ position: "absolute", left: textX, top: 2, height: 32, display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", fontSize: 15, fontWeight: 500, color: "var(--text-primary)" }}
      >
        <motion.span
          initial={{ scale: animate ? 0 : 1 }}
          animate={{ scale: 1 }}
          transition={animate ? { ...SNAP, delay: s(1250) } : { duration: 0 }}
          style={{ width: 18, height: 18, borderRadius: 999, display: "grid", placeItems: "center", background: "var(--success)", color: "var(--bg)" }}
        >
          <Check size={12} strokeWidth={2.5} />
        </motion.span>
        <span>
          Live on <Roll to={n} delayMs={animate ? (840 + n * 40) / pace : 0} durMs={animate ? 380 / pace : 0} /> {n === 1 ? "platform" : "platforms"}
        </span>
      </motion.div>
    </div>
  );
}

/** A single odometer digit-roll from 0 to `to`. */
function Roll({ to, delayMs, durMs }: { to: number; delayMs: number; durMs: number }) {
  const [v, setV] = useState(durMs ? 0 : to);
  useEffect(() => {
    if (!durMs) return setV(to);
    let raf = 0;
    const start = performance.now() + delayMs;
    const loop = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / durMs));
      setV(Math.round(to * p));
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [to, delayMs, durMs]);
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>;
}
