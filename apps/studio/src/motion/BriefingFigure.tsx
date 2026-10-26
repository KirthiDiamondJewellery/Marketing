"use client";
import { motion } from "motion/react";
import { usePacing } from "./pacing";
import { useShowcaseReduced } from "./reduced";
import { EASE_OUT, EASE_SIGNAL, SIGNAL_BLOOM, STAGGER_MS } from "./tokens";

const DIGITS = Array.from({ length: 20 }, (_, i) => i % 10);

/**
 * Moment 8, weekly briefing reveal: the headline figure in Sora rolls up digit by digit like an odometer while
 * a Signal underline draws beneath it on `--ease-signal`. Replays whenever `value` changes.
 */
export function BriefingFigure({ value, format = (n) => n.toLocaleString("en-US"), label, size = "l" }: { value: number; format?: (n: number) => string; label: string; size?: "l" | "xl" }) {
  const reduced = useShowcaseReduced();
  const pace = usePacing();
  const text = format(value);
  const fs = size === "xl" ? 56 : 40;
  const lh = size === "xl" ? 60 : 44;
  const animate = !reduced;
  const s = (ms: number) => ms / 1000 / pace;
  let digitIndex = 0;

  return (
    <div key={text} style={{ display: "inline-grid", gap: 8, width: "fit-content", justifySelf: "start" }}>
      <div aria-label={text} role="text" style={{ position: "relative", display: "inline-flex", fontFamily: "var(--font-display)", fontSize: fs, lineHeight: `${lh}px`, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums", paddingBottom: 10 }}>
        {[...text].map((ch, i) => {
          if (!/\d/.test(ch)) {
            return (
              <motion.span key={i} aria-hidden initial={{ opacity: animate ? 0 : 1 }} animate={{ opacity: 1 }} transition={{ delay: s(200), duration: s(300) }}>
                {ch}
              </motion.span>
            );
          }
          const d = Number(ch);
          const k = digitIndex++;
          return (
            <span key={i} aria-hidden style={{ display: "inline-block", height: lh, overflow: "hidden", position: "relative" }}>
              <motion.span
                initial={{ y: animate ? 0 : `${(-(10 + d) * 100) / 20}%` }}
                animate={{ y: `${(-(10 + d) * 100) / 20}%` }}
                transition={animate ? { delay: s(k * STAGGER_MS), duration: s(1100 + k * 40), ease: EASE_SIGNAL } : { duration: 0 }}
                style={{ display: "flex", flexDirection: "column" }}
              >
                {DIGITS.map((n, j) => (
                  <span key={j} style={{ height: lh, display: "block", textAlign: "center" }}>
                    {n}
                  </span>
                ))}
              </motion.span>
            </span>
          );
        })}
        <motion.span
          aria-hidden
          initial={{ scaleX: animate ? 0 : 1 }}
          animate={{ scaleX: 1 }}
          transition={animate ? { delay: s(250), duration: s(1200), ease: EASE_SIGNAL } : { duration: 0 }}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "var(--brand)", transformOrigin: "0 50%" }}
        />
        {animate && (
          <motion.span
            aria-hidden
            initial={{ scaleX: 0, opacity: 1 }}
            animate={{ scaleX: 1, opacity: [1, 1, 0] }}
            transition={{ scaleX: { delay: s(250), duration: s(1200), ease: EASE_SIGNAL }, opacity: { duration: s(1900), times: [0, 0.7, 1] } }}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "var(--brand)", boxShadow: SIGNAL_BLOOM, transformOrigin: "0 50%" }}
          />
        )}
      </div>
      <motion.span
        initial={{ opacity: animate ? 0 : 1, y: animate ? 8 : 0 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: animate ? s(500) : 0, duration: s(320), ease: EASE_OUT }}
        style={{ fontSize: 13, lineHeight: "20px", color: "var(--text-secondary)" }}
      >
        {label}
      </motion.span>
    </div>
  );
}
