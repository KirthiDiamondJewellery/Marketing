"use client";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { PlatformGlyph, PLATFORM_NAMES } from "./PlatformGlyph";
import { usePacing } from "./pacing";
import { useShowcaseReduced } from "./reduced";
import { EASE_OUT, EASE_SIGNAL, SIGNAL_BLOOM, SNAP } from "./tokens";

const RATIO: Record<string, number> = { instagram: 4 / 5, facebook: 4 / 5, threads: 4 / 5, tiktok: 9 / 16, youtube: 9 / 16, linkedin: 1, x: 16 / 9, twitter: 16 / 9 };
const MAX_W: Record<string, number> = { tiktok: 300, youtube: 300, linkedin: 380, x: 440, twitter: 440 };

/**
 * Moment 3, post assembly (~2.4s): the platform frame draws its outline, the image resolves top to bottom behind a
 * Signal scanline, the caption types in at ~40 characters a second with hashtags settling last, then the frame snaps
 * to a filled card and the brand voice score counts up. `play` restarts it; when not playing it shows the end state.
 */
export function PostAssembly({ image, caption, platform, score, play }: { image?: string | null; caption: string; platform: string; score?: number; play: boolean }) {
  const reduced = useShowcaseReduced();
  const pace = usePacing();
  const [run, setRun] = useState(0);
  const prev = useRef(play);
  useEffect(() => {
    if (play && !prev.current) setRun((r) => r + 1);
    prev.current = play;
  }, [play]);
  useEffect(() => {
    if (play) setRun((r) => r + 1);
    // Play on mount when asked to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animate = play && !reduced && run > 0;
  const p = platform.toLowerCase();
  const ratio = RATIO[p] ?? 4 / 5;
  const s = (ms: number) => (animate ? ms / 1000 / pace : 0);
  const words = caption.split(/(\s+)/);
  const body = words.filter((w) => !/^#\w/.test(w)).join("").trim();
  const tags = words.filter((w) => /^#\w/.test(w));
  const cps = Math.max(40, body.length / 1.3) * pace;

  return (
    <div key={run} style={{ width: "100%", maxWidth: MAX_W[p] ?? 340, position: "relative" }}>
      {/* Frame outline, then fill. */}
      <motion.div
        aria-hidden
        initial={{ opacity: animate ? 0 : 1 }}
        animate={{ opacity: 1 }}
        transition={{ delay: s(2050), duration: s(220), ease: EASE_OUT }}
        style={{ position: "absolute", inset: 0, borderRadius: 16, background: "var(--surface-1)", border: "1px solid var(--border)" }}
      />
      <svg aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}>
        <motion.rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          rx="16"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth={1}
          initial={{ pathLength: animate ? 0 : 1, opacity: animate ? 1 : 0 }}
          animate={{ pathLength: 1, opacity: animate ? [1, 1, 0] : 0 }}
          transition={{ pathLength: { duration: s(450), ease: EASE_SIGNAL }, opacity: { duration: s(2300), times: [0, 0.92, 1] } }}
        />
      </svg>
      <motion.div
        initial={{ scale: 1 }}
        animate={animate ? { scale: [1, 1, 1.012, 1] } : { scale: 1 }}
        transition={animate ? { duration: s(2400), times: [0, 0.85, 0.92, 1] } : { duration: 0 }}
        style={{ position: "relative", padding: 12, display: "grid", gap: 12 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13, lineHeight: "20px" }}>
          <PlatformGlyph platform={p} />
          <span>{PLATFORM_NAMES[p] ?? platform}</span>
          <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 12 }}>Preview</span>
        </div>
        {/* The image resolves top to bottom behind a violet scanline. */}
        <div style={{ position: "relative", aspectRatio: String(ratio), borderRadius: 10, overflow: "hidden", background: "var(--surface-2)" }}>
          <motion.div
            initial={{ clipPath: animate ? "inset(0 0 100% 0)" : "inset(0 0 0% 0)" }}
            animate={{ clipPath: "inset(0 0 0% 0)" }}
            transition={{ delay: s(350), duration: s(950), ease: [0.45, 0, 0.25, 1] }}
            style={{ position: "absolute", inset: 0 }}
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <TextCover caption={body} />
            )}
          </motion.div>
          {animate && (
            <motion.div
              aria-hidden
              initial={{ y: "0%", opacity: 0 }}
              animate={{ y: "100%", opacity: [0, 1, 1, 0] }}
              transition={{ y: { delay: s(350), duration: s(950), ease: [0.45, 0, 0.25, 1] }, opacity: { delay: s(350), duration: s(1000), times: [0, 0.06, 0.9, 1] } }}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              <div style={{ position: "absolute", left: 0, right: 0, top: -1, height: 2, background: "var(--brand)", boxShadow: SIGNAL_BLOOM }} />
            </motion.div>
          )}
        </div>
        <div style={{ minHeight: 48, fontSize: 14, lineHeight: "21px", color: "var(--text-primary)" }}>
          <Typed text={body} cps={cps} delayMs={animate ? 1150 / pace : 0} instant={!animate} />{" "}
          {tags.map((t, i) => (
            <motion.span
              key={`${t}-${i}`}
              initial={{ opacity: animate ? 0 : 1, y: animate ? -6 : 0 }}
              animate={{ opacity: 1, y: 0 }}
              transition={animate ? { ...SNAP, delay: (1150 + (body.length / cps) * 1000 * pace + 60 * i) / 1000 / pace } : { duration: 0 }}
              style={{ display: "inline-block", marginRight: 6, color: "var(--text-on-tint)" }}
            >
              {t}
            </motion.span>
          ))}
        </div>
        {score !== undefined && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, lineHeight: "20px", color: "var(--text-secondary)" }}>
            <span>Brand voice</span>
            <CountUp value={score} delayMs={animate ? 2050 / pace : 0} durMs={animate ? 600 / pace : 0} />
          </div>
        )}
      </motion.div>
    </div>
  );
}

function TextCover({ caption }: { caption: string }) {
  const line = caption.split(/(?<=[.?!])\s/)[0] ?? caption;
  // A quiet carousel cover when the post has no image yet: the hook set large, framed like a printed card.
  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--surface-2)", padding: 12 }}>
      <div style={{ position: "absolute", inset: 12, borderRadius: 6, boxShadow: "inset 0 0 0 1px var(--border)" }} />
      <div style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 16 }}>
        <span style={{ fontSize: 12, lineHeight: "16px", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>1 of 7</span>
        <span style={{ fontFamily: "var(--font-display)", fontSize: 32, lineHeight: "36px", color: "var(--text-primary)", textWrap: "balance" }}>{line}</span>
      </div>
    </div>
  );
}

function Typed({ text, cps, delayMs, instant }: { text: string; cps: number; delayMs: number; instant: boolean }) {
  const [n, setN] = useState(instant ? text.length : 0);
  useEffect(() => {
    if (instant) {
      setN(text.length);
      return;
    }
    setN(0);
    let raf = 0;
    const start = performance.now() + delayMs;
    const loop = (now: number) => {
      const k = Math.max(0, Math.floor(((now - start) / 1000) * cps));
      setN(Math.min(text.length, k));
      if (k < text.length) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [text, cps, delayMs, instant]);
  return (
    <span>
      {text.slice(0, n)}
      <span style={{ visibility: "hidden" }}>{text.slice(n)}</span>
    </span>
  );
}

export function CountUp({ value, delayMs = 0, durMs = 600, format = (n: number) => String(Math.round(n)) }: { value: number; delayMs?: number; durMs?: number; format?: (n: number) => string }) {
  const [v, setV] = useState(durMs ? 0 : value);
  useEffect(() => {
    if (!durMs) {
      setV(value);
      return;
    }
    let raf = 0;
    const start = performance.now() + delayMs;
    const loop = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / durMs));
      setV(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [value, delayMs, durMs]);
  return <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontWeight: 500 }}>{format(v)}</span>;
}
