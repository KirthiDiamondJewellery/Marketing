// Unfinished feature: the standalone full-screen command view (replaced by the Command tab on Agents). Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { LiveEvent } from "@/lib/live";
import { useLive } from "@/lib/use-live";
import { useReel } from "@/components/reel/ReelProvider";
import { useFrame } from "@/motion/frame";
import { WakeTheTeam } from "@/motion/WakeTheTeam";
import { Orbit } from "./Orbit";
import { useNow } from "./AgentCard";

/**
 * Moment 5, the command view: the hero shot for any reel. Full screen, outside the OS shell. The brand sits at the
 * centre of the rotating Signal ring, the team orbits it, live work flies between them as relay comets, and scheduled
 * posts ride the outer dial toward "now". Runs continuously and loops seamlessly.
 */
export function CommandView() {
  const live = useLive();
  const reel = useReel();
  const snap = live.snapshot;
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [idle, setIdle] = useState(false);
  const [loopQuery, setLoopQuery] = useState(false);
  // Wake the team flies to the orbiting monograms, so it waits until the orbit has laid out and taken a few frames.
  const [orbitReady, setOrbitReady] = useState(false);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const statusRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLDivElement>(null);
  const hudRects = useCallback(() => {
    const base = root.current?.getBoundingClientRect();
    if (!base) return [];
    return [statusRef.current, clockRef.current].flatMap((el) => {
      if (!el) return [];
      const r = el.getBoundingClientRect();
      return [{ left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top }];
    });
  }, []);
  const onOrbitScale = useCallback((scale: number) => {
    if (scale > 0 && !readyTimer.current) readyTimer.current = setTimeout(() => setOrbitReady(true), 350);
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setLoopQuery(new URLSearchParams(window.location.search).get("loop") === "1");
    // The back affordance steps aside when the pointer rests, so an office monitor shows only the view.
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), 3000);
    };
    wake();
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  const portrait = size.h > size.w * 1.15;
  // Interface scale: 1 on a 1440×900 laptop, larger on a 4K monitor, legible in a 1080×1920 reel.
  const k = portrait ? Math.max(0.85, Math.min(2.4, Math.min(size.w / 1080, size.h / 1920) * 1.55)) : Math.max(0.8, Math.min(2.6, Math.min(size.w / 1440, size.h / 900)));
  const pad = Math.round(28 * k);
  const tickerH = Math.round(44 * k);
  const statusH = Math.round(64 * k);
  // 9:16: keep the action inside the centre 1080×1350 safe area and clear of the bottom 20% (captions, buttons).
  const safeTop = Math.round(size.h * 0.148);
  const safeBottom = Math.round(size.h * 0.8);
  const tickerBottom = portrait ? size.h - safeBottom : pad * 0.5;
  const insets = useMemo(
    () =>
      portrait
        ? { top: safeTop + statusH + pad * 0.9, bottom: tickerBottom + tickerH + pad * 0.3, left: 0, right: 0 }
        : { top: pad * 0.6, bottom: tickerH + pad * 0.6, left: pad, right: pad },
    [portrait, statusH, tickerH, pad, safeTop, tickerBottom],
  );

  const agents = snap?.agents ?? [];
  const queued = (snap?.queue.queued ?? 0) + (snap?.queue.running ?? 0);
  const waiting = snap?.approvals.length ?? 0;
  const online = (snap?.workerOnline ?? false) || agents.some((a) => a.state === "working");
  const loop = reel.on || loopQuery;
  const frame = reel.frame;
  const showBack = !reel.on && !idle;

  return (
    <div
      ref={root}
      style={{
        position: "fixed",
        left: frame?.x ?? 0,
        top: frame?.y ?? 0,
        width: frame?.w ?? "100vw",
        height: frame?.h ?? "100dvh",
        background: "var(--bg)",
        overflow: "hidden",
        color: "var(--text-primary)",
      }}
    >
      {size.w > 0 && <Orbit avoid={hudRects} onScale={onOrbitScale} variant="full" loopPosts={loop} insets={insets} textScale={portrait ? 1.42 : 1} labelSide={portrait ? "inner" : "outer"} monoSize={portrait ? 64 : 56} showreel={reel.on} />}

      {/* Top left: the way back, then the team's status. */}
      <div style={{ position: "absolute", left: pad, top: portrait ? safeTop - 30 * k : pad, right: portrait ? pad : "auto", display: "grid", gap: 10 * k, pointerEvents: "none" }}>
        <Link
          href="/"
          aria-label="Back to Studio"
          tabIndex={reel.on ? -1 : 0}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            width: "fit-content",
            fontSize: 13 * Math.min(k, 1.4),
            lineHeight: "20px",
            color: "var(--text-secondary)",
            textDecoration: "none",
            padding: "4px 10px 4px 6px",
            marginLeft: -6,
            borderRadius: 10,
            opacity: showBack ? 1 : 0,
            transition: "opacity 320ms var(--ease-out)",
            pointerEvents: showBack ? "auto" : "none",
          }}
        >
          <ArrowLeft size={16 * Math.min(k, 1.4)} strokeWidth={1.5} />
          Studio
        </Link>
        <div ref={statusRef} style={{ display: "grid", gap: 2 * k, width: "fit-content" }}>
          <div style={{ fontSize: 17 * k, lineHeight: 1.35, fontWeight: 500, letterSpacing: "-0.005em" }}>
            {online ? "Your team is online." : "Your team is standing by."}{" "}
            <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
              {agents.length || 7} agents, {queued} {queued === 1 ? "task" : "tasks"} queued.
            </span>
          </div>
          {portrait && <ClockLine k={k} name={snap?.workspace.name ?? ""} tz={snap?.workspace.timezone} />}
          {waiting > 0 && (
            <div style={{ fontSize: 13 * k, lineHeight: 1.5, color: "var(--text-on-tint)" }}>
              {waiting} {waiting === 1 ? "item needs" : "items need"} your approval
            </div>
          )}
        </div>
      </div>

      {/* Top right: whose brand, and the time where it lives. */}
      {!portrait && <Clock ref={clockRef} k={k} pad={pad} name={snap?.workspace.name ?? ""} tz={snap?.workspace.timezone} />}

      <Ticker events={live.events} names={Object.fromEntries(agents.map((a) => [a.key, a.name]))} k={k} height={tickerH} bottom={tickerBottom} pad={pad} />

      {agents.length > 0 && orbitReady && <WakeTheTeam agents={agents} tasks={queued} />}
    </div>
  );
}

function useClock(tz?: string) {
  const now = useNow(1000);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const time = mounted ? new Date(now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : "";
  const day = mounted ? new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: tz }) : "";
  return { time, day };
}

function ClockLine({ k, name, tz }: { k: number; name: string; tz?: string }) {
  const { time, day } = useClock(tz);
  return (
    <div style={{ fontSize: 13 * k, lineHeight: 1.5, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
      {[name, day, time].filter(Boolean).join(" · ")}
    </div>
  );
}

function Clock({ k, pad, name, tz, ref }: { k: number; pad: number; name: string; tz?: string; ref?: React.Ref<HTMLDivElement> }) {
  const { time, day } = useClock(tz);
  return (
    <div ref={ref} style={{ position: "absolute", right: pad, top: pad, textAlign: "right", display: "grid", gap: 2 * k, pointerEvents: "none" }}>
      <div style={{ fontSize: 17 * k, lineHeight: 1.35, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{time}</div>
      <div style={{ fontSize: 13 * k, lineHeight: 1.5, color: "var(--text-secondary)" }}>
        {name}
        {day ? ` · ${day}` : ""}
      </div>
    </div>
  );
}

function actorName(agent: string, names: Record<string, string>): string {
  if (names[agent]) return names[agent]!;
  if (agent.startsWith("user:")) return "You";
  if (agent === "system") return "AttentionOS";
  return agent.replace(/_/g, " ");
}

/** The latest work, in the agent log voice, scrolling like a wire. */
function Ticker({ events, names, k, height, bottom, pad }: { events: LiveEvent[]; names: Record<string, string>; k: number; height: number; bottom: number; pad: number }) {
  const items = useMemo(() => {
    const seen = new Set<number>();
    return events.filter((e) => e.kind !== "cost" && e.kind !== "tool" && !seen.has(e.id) && seen.add(e.id)).slice(-14);
  }, [events]);
  const track = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLDivElement>(null);
  const x = useRef(0);
  useFrame((_, dt) => {
    const el = track.current;
    const w = first.current?.offsetWidth ?? 0;
    if (!el || !w) return;
    x.current -= (dt / 1000) * 42 * k;
    if (-x.current >= w) x.current += w;
    el.style.transform = `translate3d(${x.current.toFixed(2)}px, 0, 0)`;
  });
  if (!items.length) return null;
  const row = (ref?: React.Ref<HTMLDivElement>) => (
    <div ref={ref} style={{ display: "flex", flex: "none" }}>
      {items.map((e) => (
        <span key={e.id} style={{ display: "inline-flex", alignItems: "baseline", gap: 10 * k, paddingRight: 40 * k, whiteSpace: "nowrap" }}>
          <span style={{ color: "var(--text-muted)" }}>{new Date(e.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
          <span style={{ color: e.kind === "error" ? "var(--danger)" : "var(--text-secondary)" }}>{actorName(e.agent, names)}</span>
          <span style={{ color: "var(--text-primary)" }}>{e.message}</span>
        </span>
      ))}
    </div>
  );
  return (
    <div
      aria-label="Latest agent activity"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom,
        height,
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
        fontFamily: "var(--font-mono)",
        fontSize: 13 * k,
        lineHeight: 1.5,
        maskImage: `linear-gradient(90deg, transparent, #000 ${pad * 2}px, #000 calc(100% - ${pad * 2}px), transparent)`,
        WebkitMaskImage: `linear-gradient(90deg, transparent, #000 ${pad * 2}px, #000 calc(100% - ${pad * 2}px), transparent)`,
        pointerEvents: "none",
      }}
    >
      <div ref={track} style={{ display: "flex", willChange: "transform" }}>
        {row(first)}
        {row()}
        {row()}
      </div>
    </div>
  );
}
