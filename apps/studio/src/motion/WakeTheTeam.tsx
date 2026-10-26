"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { AgentLive } from "@/lib/live";
import { AgentMonogram } from "./AgentMonogram";
import { pacing } from "./pacing";
import { useShowcaseReduced } from "./reduced";
import { EASE_OUT, EASE_SIGNAL, GAP_CENTER_DEG, GAP_DEG, SIGNAL_BLOOM_FILTER, SNAP, STAGGER_MS, arcPath, polar, ringPath } from "./tokens";

const KEY = "aos.wake.day";
const ORDER = ["chief_of_staff", "strategist", "copywriter", "art_director", "publisher", "community", "analyst"];

type Target = { key: string; x: number; y: number; size: number };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function findTargets(agents: AgentLive[], w: number, h: number): { targets: Target[]; anchored: boolean } {
  const found: Target[] = [];
  for (const a of agents) {
    const els = [...document.querySelectorAll<HTMLElement>(`[data-agent-anchor="${a.key}"], [data-agent-monogram="${a.monogram}"]`)];
    const el = els.find((e) => {
      if (e.closest("[data-wake-overlay]")) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < h && r.right > 0 && r.left < w;
    });
    if (!el) break;
    const r = el.getBoundingClientRect();
    found.push({ key: a.key, x: r.left + r.width / 2, y: r.top + r.height / 2, size: Math.min(r.width, r.height) });
  }
  if (found.length === agents.length && agents.length) return { targets: found, anchored: true };
  const gap = Math.min(96, (w - 64) / Math.max(1, agents.length));
  const x0 = w / 2 - (gap * (agents.length - 1)) / 2;
  return { targets: agents.map((a, i) => ({ key: a.key, x: x0 + gap * i, y: h / 2 + Math.min(150, h * 0.17), size: 56 })), anchored: false };
}

/**
 * Moment 1, wake the team (~2.2s). A violet point draws the AttentionOS ring, the ring fractures into one arc per
 * agent, each arc flies to its monogram (`[data-agent-anchor]` or any on-screen AgentMonogram, else a centred row) and
 * curls into a ring, then the workspace fades up while the status line types in. Plays once per day unless `force`.
 * Click or Esc skips to the end state.
 */
export function WakeTheTeam({ agents, onDone, force, tasks }: { agents: AgentLive[]; onDone?: () => void; force?: boolean; tasks?: number }) {
  const [play, setPlay] = useState<null | { w: number; h: number; targets: Target[]; anchored: boolean; pace: number; ring: { x: number; y: number; r: number } | null }>(null);
  const [leaving, setLeaving] = useState(false);
  const reduced = useShowcaseReduced();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const finished = useRef(false);

  useLayoutEffect(() => {
    if (!agents.length) return;
    let seen = "";
    try {
      seen = window.localStorage.getItem(KEY) ?? "";
    } catch {
      // Storage blocked: treat it as not seen today, so the intro plays.
    }
    if (!force && seen === today()) return;
    try {
      window.localStorage.setItem(KEY, today());
    } catch {
      // Storage blocked: the intro may play again on the next visit, which is harmless.
    }
    const sorted = [...agents].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
    const w = window.innerWidth;
    const h = window.innerHeight;
    finished.current = false;
    setLeaving(false);
    // If the page has a home for the ring (the command view's Signal ring), draw it exactly there.
    const ringEl = [...document.querySelectorAll<HTMLElement>("[data-wake-ring]")].find((e) => e.getBoundingClientRect().width > 0);
    const rr = ringEl?.getBoundingClientRect();
    const ring = rr ? { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2, r: rr.width / 2 - 4 } : null;
    setPlay({ w, h, ...findTargets(sorted, w, h), pace: pacing.get(), ring });
    // Re-run only when forced again or the roster first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [force, agents.length > 0]);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    setLeaving(true);
    setTimeout(() => {
      setPlay(null);
      doneRef.current?.();
    }, 220);
  }, []);

  useEffect(() => {
    if (!play) return;
    const total = reduced ? 200 : 2600 / play.pace;
    const t = setTimeout(finish, total);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish();
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [play, reduced, finish]);

  if (!play || typeof document === "undefined") return null;
  const { w, h, targets, anchored, pace, ring } = play;
  const s = (ms: number) => ms / 1000 / pace;
  const cx = ring?.x ?? w / 2;
  const cy = ring?.y ?? h / 2 - (anchored ? 0 : Math.min(40, h * 0.05));
  const R = ring?.r ?? Math.min(64, w * 0.09);
  const n = targets.length;
  const span = (360 - GAP_DEG) / n;
  const queued = tasks ?? agents.reduce((sum, a) => sum + a.pendingApprovals + (a.state === "working" ? 1 : 0), 0);
  const status = `Your team is online. ${agents.length} agents, ${queued} ${queued === 1 ? "task" : "tasks"} queued.`;
  const statusY = anchored ? cy + R + 56 : (targets[0]?.y ?? cy) + 76;

  const overlay = (
    <motion.div
      data-wake-overlay
      role="presentation"
      onClick={finish}
      initial={{ opacity: 1 }}
      animate={{ opacity: leaving ? 0 : 1 }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      style={{ position: "fixed", inset: 0, zIndex: 90, pointerEvents: leaving ? "none" : "auto" }}
    >
      {/* The page behind fades up at 1700ms. */}
      <motion.div
        aria-hidden
        initial={{ opacity: 1 }}
        animate={{ opacity: 0 }}
        transition={{ delay: reduced ? 0 : s(1700), duration: reduced ? 0.2 : s(500), ease: EASE_OUT }}
        style={{ position: "absolute", inset: 0, background: "var(--bg)" }}
      />
      {!reduced && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", inset: 0, overflow: "visible" }} aria-hidden>
          <motion.g initial={{ opacity: 1 }} animate={{ opacity: 0.0 }} transition={{ delay: s(2000), duration: s(300) }} style={{ filter: SIGNAL_BLOOM_FILTER }}>
            {/* 0ms: the point. */}
            <motion.circle cx={cx} cy={cy} r={3} fill="var(--brand)" initial={{ scale: 0, opacity: 0 }} animate={{ scale: [0, 1.4, 1], opacity: [0, 1, 1, 0] }} transition={{ duration: s(420), times: [0, 0.3, 0.6, 1] }} />
            {/* 200ms: the ring draws clockwise from the gap and stops at 1 o'clock. */}
            <motion.path
              d={ringPath(cx, cy, R)}
              fill="none"
              stroke="var(--brand)"
              strokeWidth={2}
              initial={{ pathLength: 0, opacity: 1 }}
              animate={{ pathLength: 1, opacity: [1, 1, 0] }}
              transition={{ pathLength: { delay: s(200), duration: s(680), ease: EASE_SIGNAL }, opacity: { delay: s(200), duration: s(700), times: [0, 0.99, 1] } }}
            />
            {/* 900ms: the ring fractures into one arc per agent and each flies to its monogram. */}
            {targets.map((t, i) => {
              const from = GAP_CENTER_DEG + GAP_DEG / 2 + span * i + 2;
              const to = from + span - 4;
              const scale = (anchored ? t.size / 2 - 3 : t.size / 2 + 3) / R;
              // Motion transforms SVG around the element's own box, so travel from the arc's midpoint.
              const mid = polar(cx, cy, R * Math.cos(((span / 4) * Math.PI) / 180), (from + to) / 2);
              return (
                <motion.path
                  key={t.key}
                  d={arcPath(cx, cy, R, from, to)}
                  fill="none"
                  stroke="var(--brand)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  initial={{ opacity: 0, x: 0, y: 0, scale: 1, rotate: 0 }}
                  animate={{ opacity: [0, 1, 1, 0], x: t.x - mid.x, y: t.y - mid.y, scale, rotate: 140 }}
                  transition={{
                    opacity: { delay: s(890), duration: s(470), times: [0, 0.05, 0.85, 1] },
                    default: { delay: s(900 + i * 14), duration: s(400), ease: EASE_SIGNAL },
                  }}
                  style={{ vectorEffect: "non-scaling-stroke" }}
                />
              );
            })}
            {/* 1300ms: each arc curls into a full monogram ring. */}
            {targets.map((t, i) => (
              <motion.circle
                key={`ring-${t.key}`}
                cx={t.x}
                cy={t.y}
                r={anchored ? t.size / 2 - 3 : t.size / 2 + 3}
                fill="none"
                stroke="var(--brand)"
                strokeWidth={2}
                initial={{ pathLength: 0.15, opacity: 0, rotate: -90 }}
                animate={{ pathLength: 1, opacity: [0, 1, 1, 0] }}
                transition={{ pathLength: { delay: s(1300 + i * STAGGER_MS), duration: s(320), ease: EASE_SIGNAL }, opacity: { delay: s(1300 + i * STAGGER_MS), duration: s(900), times: [0, 0.05, 0.7, 1] } }}
              />
            ))}
          </motion.g>
        </svg>
      )}
      {/* Monograms snap in, staggered 60ms. */}
      {targets.map((t, i) => {
        const a = agents.find((x) => x.key === t.key)!;
        const ms = t.size >= 48 ? 56 : t.size >= 30 ? 32 : 24;
        const fit = anchored ? t.size / (ms + 8) : 1;
        return (
          <motion.div
            key={`m-${t.key}`}
            initial={{ opacity: 0, scale: reduced ? fit : 0.6 * fit }}
            animate={{ opacity: anchored ? [0, 1, 1, 0] : 1, scale: fit }}
            transition={
              reduced
                ? { duration: 0.2 }
                : { scale: { ...SNAP, delay: s(1300 + i * STAGGER_MS) }, opacity: anchored ? { delay: s(1300 + i * STAGGER_MS), duration: s(1000 - i * STAGGER_MS), times: [0, 0.1, 0.6, 1] } : { delay: s(1300 + i * STAGGER_MS), duration: s(120) } }
            }
            style={{ position: "absolute", left: t.x, top: t.y, translateX: "-50%", translateY: "-50%", display: "grid", justifyItems: "center", gap: 8 }}
          >
            <AgentMonogram agent={{ ...a, state: "idle" }} size={ms} />
            {!anchored && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: reduced ? 0 : s(1500 + i * STAGGER_MS), duration: s(240) }}
                style={{ position: "absolute", top: "100%", marginTop: 10, whiteSpace: "nowrap", fontSize: 12, lineHeight: "16px", color: "var(--text-secondary)" }}
              >
                {a.name}
              </motion.span>
            )}
          </motion.div>
        );
      })}
      {/* 1700ms: the status line types in. */}
      <TypeLine text={status} delayMs={reduced ? 0 : 1700 / pace} cps={reduced ? 10_000 : 52 * pace} x={cx} y={statusY} />
    </motion.div>
  );
  return createPortal(overlay, document.body);
}

function TypeLine({ text, delayMs, cps, x, y }: { text: string; delayMs: number; cps: number; x: number; y: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now() + delayMs;
    const loop = (now: number) => {
      const k = Math.max(0, Math.floor(((now - start) / 1000) * cps));
      setN(Math.min(text.length, k));
      if (k < text.length) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [text, delayMs, cps]);
  return (
    <div
      aria-live="polite"
      style={{ position: "absolute", left: x, top: y, transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: 15, lineHeight: "24px", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums", minHeight: 24, padding: n > 0 ? "4px 14px" : 0, borderRadius: 999, background: "var(--bg)" }}
    >
      {text.slice(0, n)}
      <span style={{ opacity: n > 0 && n < text.length ? 1 : 0, color: "var(--brand-fg)", marginLeft: 1 }}>▍</span>
    </div>
  );
}
