"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import type { AgentLive } from "@/lib/live";
import { useLive } from "@/lib/use-live";
import { AgentMonogram } from "@/motion/AgentMonogram";
import { ApproveAllCascade } from "@/motion/ApproveAllCascade";
import { AutopilotRing } from "@/motion/AutopilotRing";
import { BriefingFigure } from "@/motion/BriefingFigure";
import { GoLiveBurst } from "@/motion/GoLiveBurst";
import { PostAssembly } from "@/motion/PostAssembly";
import { RelayLayer } from "@/motion/RelayLayer";
import { WakeTheTeam } from "@/motion/WakeTheTeam";
import { usePacing } from "@/motion/pacing";
import { relay, relayListenerCount } from "@/motion/relay-bus";
import { EASE_OUT, EASE_SIGNAL, SIGNAL_BLOOM_FILTER, STAGGER_MS } from "@/motion/tokens";
import { STORYLINES } from "./storylines";
import { onUnclaimedMoment, type MomentId } from "./moment-bus";
import { useReelPulse } from "./reel-pulse";
import { useReel, type Frame } from "./ReelProvider";

type Shot = { id: number; m: MomentId };

/** Base lengths (ms at 100%) before an overlay moment clears itself. */
const HOLD: Partial<Record<MomentId, number>> = { 2: 3600, 3: 4800, 4: 3400, 6: 3600, 7: 3600, 8: 4600 };

function handoffs() {
  return STORYLINES.flatMap((s) => s.steps.filter((x): x is Extract<typeof x, { kind: "handoff" }> => x.kind === "handoff"));
}

function shuffle<T>(list: T[]): T[] {
  return [...list].sort(() => Math.random() - 0.5);
}

/**
 * Plays reel-mode moments nobody claimed in place, draws the 9:16 framing mask, shows the brief pacing hint, and keeps
 * the reel pulse running. Mount once inside <LiveProvider> and <ReelProvider>.
 */
export function ReelOverlayHost() {
  const reel = useReel();
  const live = useLive();
  const router = useRouter();
  const pace = usePacing();
  const [shot, setShot] = useState<Shot | null>(null);
  const seq = useRef(0);
  useReelPulse();

  const fireRelays = useCallback(() => {
    shuffle(handoffs())
      .slice(0, 3)
      .forEach((h, i) => setTimeout(() => relay(h.agent, h.to, h.message), i * 120));
  }, []);

  useEffect(
    () =>
      onUnclaimedMoment((m) => {
        if (m === 5) return router.push("/agents?view=command");
        if (m === 2 && relayListenerCount() > 0) return fireRelays();
        setShot({ id: ++seq.current, m });
      }),
    [router, fireRelays],
  );

  const close = useCallback(() => setShot(null), []);
  useEffect(() => {
    if (!shot) return;
    const hold = HOLD[shot.m];
    const t = hold ? setTimeout(close, hold / pace) : undefined;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [shot, pace, close]);

  const agents = live.snapshot?.agents ?? [];
  const frame = reel.frame;

  return (
    <>
      {shot?.m === 1 && agents.length > 0 && <WakeTheTeam key={shot.id} agents={agents} force onDone={close} tasks={(live.snapshot?.queue.queued ?? 0) + (live.snapshot?.queue.running ?? 0)} />}
      <AnimatePresence>
        {shot && shot.m !== 1 && (
          <motion.div
            key={shot.id}
            data-reel-overlay
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
            style={{
              position: "fixed",
              zIndex: 80,
              left: frame?.x ?? 0,
              top: frame?.y ?? 0,
              width: frame?.w ?? "100vw",
              height: frame?.h ?? "100vh",
              background: "color-mix(in srgb, var(--bg) 97%, transparent)",
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
            }}
          >
            <Stage frame={frame}>
              {shot.m === 2 && <RelayStage agents={agents} onReady={fireRelays} />}
              {shot.m === 3 && <AssemblyShot />}
              {shot.m === 4 && <GoLiveShot />}
              {shot.m === 6 && <CascadeShot agents={agents} />}
              {shot.m === 7 && <AutopilotShot agents={agents} />}
              {shot.m === 8 && <BriefingShot />}
            </Stage>
          </motion.div>
        )}
      </AnimatePresence>
      {frame && <VerticalMask frame={frame} />}
      <AnimatePresence>
        {reel.hint && (
          <motion.div
            key={reel.hint.id}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            style={{ position: "fixed", top: 16, left: "50%", translateX: "-50%", zIndex: 95, padding: "4px 12px", borderRadius: 999, background: "var(--surface-3)", color: "var(--text-secondary)", fontSize: 12, lineHeight: "20px", pointerEvents: "none" }}
          >
            {reel.hint.text}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Keeps each shot inside the 1080×1350 safe area when framing for 9:16. */
function Stage({ frame, children }: { frame: Frame | null; children: ReactNode }) {
  return (
    <div onClick={(e) => e.stopPropagation()} style={{ width: frame ? frame.w : "auto", maxHeight: frame ? (frame.h * 1350) / 1920 : "none", display: "grid", placeItems: "center", padding: 24, transform: frame ? `translateY(${-frame.h * 0.03}px)` : undefined }}>
      {children}
    </div>
  );
}

function VerticalMask({ frame }: { frame: Frame }) {
  const [guides, setGuides] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setGuides(false), 2400);
    return () => clearTimeout(t);
  }, []);
  const dim = "rgba(5, 3, 7, 0.86)";
  const common = { position: "fixed" as const, background: dim, zIndex: 85, pointerEvents: "none" as const };
  const safeTop = frame.y + (frame.h * (1920 - 1350)) / 2 / 1920;
  const safeH = (frame.h * 1350) / 1920;
  return (
    <>
      <div aria-hidden style={{ ...common, left: 0, top: 0, width: frame.x, height: "100vh" }} />
      <div aria-hidden style={{ ...common, left: frame.x + frame.w, top: 0, right: 0, height: "100vh" }} />
      <div aria-hidden style={{ ...common, left: frame.x, top: 0, width: frame.w, height: frame.y }} />
      <div aria-hidden style={{ ...common, left: frame.x, top: frame.y + frame.h, width: frame.w, bottom: 0 }} />
      <AnimatePresence>
        {guides && (
          <motion.div aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} style={{ position: "fixed", inset: 0, zIndex: 86, pointerEvents: "none" }}>
            <div style={{ position: "fixed", left: frame.x, top: safeTop, width: frame.w, height: safeH, boxShadow: "inset 0 0 0 1px var(--border-strong)" }} />
            <div style={{ position: "fixed", left: frame.x, top: frame.y + frame.h * 0.8, width: frame.w, height: 1, background: "var(--warning)", opacity: 0.6 }} />
            <div style={{ position: "fixed", left: frame.x + frame.w - 80, top: safeTop + 8, width: 68, textAlign: "right", fontSize: 12, color: "var(--text-secondary)" }}>Safe area</div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Moment 2 on a page without a relay surface: the team in a row, with comets flying between them. */
function RelayStage({ agents, onReady }: { agents: AgentLive[]; onReady: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = useState<Record<string, { x: number; y: number }>>({});
  const list = agents.filter((a) => a.key !== "chief_of_staff").concat(agents.filter((a) => a.key === "chief_of_staff"));
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const out: Record<string, { x: number; y: number }> = {};
    el.querySelectorAll<HTMLElement>("[data-relay-key]").forEach((n) => {
      const b = n.getBoundingClientRect();
      out[n.dataset.relayKey!] = { x: b.left - r.left + b.width / 2, y: b.top - r.top + b.height / 2 };
    });
    setAnchors(out);
  }, []);
  useEffect(() => {
    if (!Object.keys(anchors).length) return;
    const t = setTimeout(onReady, 250);
    return () => clearTimeout(t);
  }, [anchors, onReady]);
  // Two arcs of monograms so comets have room to curve.
  return (
    <div ref={box} style={{ position: "relative", width: "min(860px, 92vw)", height: 340 }}>
      {list.map((a, i) => {
        const n = list.length;
        const u = n > 1 ? i / (n - 1) : 0.5;
        const x = 6 + u * 88;
        const y = 50 + Math.sin(u * Math.PI * 2) * 22;
        return (
          <div key={a.key} data-relay-key={a.key} style={{ position: "absolute", left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)", display: "grid", justifyItems: "center" }}>
            <AgentMonogram agent={a} size={56} />
            <span style={{ position: "absolute", top: "100%", marginTop: 8, fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{a.name}</span>
          </div>
        );
      })}
      {Object.keys(anchors).length > 0 && <RelayLayer anchors={anchors} />}
    </div>
  );
}

function pickPost(live: ReturnType<typeof useLive>) {
  const snap = live.snapshot;
  for (const a of snap?.approvals ?? []) {
    const p = a.preview as { caption?: unknown; platform?: unknown } | null;
    if (p && typeof p.caption === "string") return { caption: p.caption, platform: typeof p.platform === "string" ? p.platform : "instagram" };
  }
  const post = snap?.posts.find((p) => p.caption);
  if (post?.caption) return { caption: post.caption, platform: post.platform };
  return { caption: "Three mistakes that cost new clients a month. Comment CHECKLIST for the free checklist. #smallbusiness #tips", platform: "instagram" };
}

function AssemblyShot() {
  const live = useLive();
  const [post] = useState(() => pickPost(live));
  const caption = /#\w/.test(post.caption) ? post.caption : `${post.caption} #smallbusiness #tips`;
  return (
    <div style={{ width: 340 }}>
      <PostAssembly caption={caption} platform={post.platform} score={92} play />
    </div>
  );
}

function GoLiveShot() {
  const live = useLive();
  const [platforms] = useState(() => {
    const posts = live.snapshot?.posts ?? [];
    const title = posts.find((p) => p.status === "scheduled")?.title;
    const list = [...new Set(posts.filter((p) => p.title === title).map((p) => p.platform))];
    return list.length >= 2 ? list.slice(0, 4) : ["instagram", "tiktok", "youtube", "linkedin"];
  });
  return (
    <div style={{ display: "grid", gap: 16, padding: 24, borderRadius: 16, background: "var(--surface-1)", boxShadow: "inset 0 0 0 1px var(--border)" }}>
      <div style={{ fontSize: 13, lineHeight: "20px", color: "var(--text-secondary)" }}>Publisher · approved just now</div>
      <GoLiveBurst platforms={platforms} play />
    </div>
  );
}

function CascadeShot({ agents }: { agents: AgentLive[] }) {
  const live = useLive();
  const pace = usePacing();
  const [play, setPlay] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setPlay(true), 900 / pace);
    return () => clearTimeout(t);
  }, [pace]);
  const byKey = Object.fromEntries(agents.map((a) => [a.key, a]));
  const real = (live.snapshot?.approvals ?? []).map((a) => ({ agent: a.agent, summary: a.summary }));
  const extra = STORYLINES.flatMap((s) => s.steps.filter((x) => x.kind === "approval").map((x) => ({ agent: x.agent, summary: (x as { summary: string }).summary })));
  const rows = [...real, ...extra].slice(0, 6);
  return (
    <div style={{ width: "min(560px, 88vw)" }}>
      <div style={{ fontSize: 20, lineHeight: "28px", fontWeight: 500, marginBottom: 16, color: "var(--text-primary)" }}>Approvals</div>
      <ApproveAllCascade play={play}>
        {rows.map((r, i) => {
          const a = byKey[r.agent];
          return (
            <div key={i} className="signal-left" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderRadius: 10, background: "var(--surface-1)" }}>
              {a && <AgentMonogram agent={{ ...a, state: "idle" }} size={32} />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, lineHeight: "20px", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.summary}</div>
                <div style={{ fontSize: 12, lineHeight: "16px", color: "var(--text-muted)" }}>{a?.name ?? r.agent}</div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 500, padding: "4px 12px", borderRadius: 8, background: "var(--brand)", color: "var(--on-brand)" }}>Approve</span>
            </div>
          );
        })}
      </ApproveAllCascade>
    </div>
  );
}

function AutopilotShot({ agents }: { agents: AgentLive[] }) {
  const pace = usePacing();
  const cos = agents.find((a) => a.key === "chief_of_staff") ?? agents[0];
  return (
    <div style={{ display: "grid", justifyItems: "center", gap: 28 }}>
      <div style={{ position: "relative", width: 220, height: 220, display: "grid", placeItems: "center" }}>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <AutopilotRing play closed size={220} contractTo={72} />
        </div>
        {cos && (
          <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 1.25 / pace, type: "spring", stiffness: 420, damping: 32 }}>
            <AgentMonogram agent={{ ...cos, state: "idle" }} size={56} />
          </motion.div>
        )}
      </div>
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.4 / pace, duration: 0.32, ease: EASE_OUT }} style={{ textAlign: "center", display: "grid", gap: 4 }}>
        <div style={{ fontSize: 20, lineHeight: "28px", fontWeight: 500, color: "var(--text-primary)" }}>Full autopilot is on</div>
        <div style={{ fontSize: 15, lineHeight: "24px", color: "var(--text-secondary)" }}>Your team acts, then reports back.</div>
      </motion.div>
    </div>
  );
}

const CHART = [12, 14, 13, 17, 16, 21, 19, 24, 23, 28, 31, 30, 36, 41];

function BriefingShot() {
  const pace = usePacing();
  const metrics = [
    { label: "New followers", value: "+412" },
    { label: "Saves", value: "1,906" },
    { label: "Leads from DMs", value: "14" },
  ];
  return (
    <div style={{ width: "min(560px, 88vw)", display: "grid", gap: 28 }}>
      <div style={{ fontSize: 13, lineHeight: "20px", color: "var(--text-secondary)" }}>Weekly briefing</div>
      <BriefingFigure value={48210} label="Views this week, up 31% on last week" size="xl" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {metrics.map((m, i) => (
          <motion.div key={m.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: (600 + i * STAGGER_MS) / 1000 / pace, duration: 0.32 / pace, ease: EASE_OUT }} style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 13, lineHeight: "20px", color: "var(--text-secondary)" }}>{m.label}</span>
            <span style={{ fontSize: 28, lineHeight: "34px", fontWeight: 500, fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{m.value}</span>
          </motion.div>
        ))}
      </div>
      <DrawnChart values={CHART} />
    </div>
  );
}

/** A line chart drawing left to right with the Signal as its leading point. */
function DrawnChart({ values }: { values: number[] }) {
  const pace = usePacing();
  const W = 560;
  const H = 120;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pts = values.map((v, i) => ({ x: (i / (values.length - 1)) * W, y: H - 8 - ((v - min) / (max - min || 1)) * (H - 24) }));
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const path = useRef<SVGPathElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  useEffect(() => {
    const el = path.current;
    const head = dot.current;
    if (!el || !head) return;
    const len = el.getTotalLength();
    const start = performance.now() + 700 / pace;
    const dur = 1200 / pace;
    let raf = 0;
    const loop = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / dur));
      const e = 1 - Math.pow(1 - p, 3);
      el.style.strokeDasharray = `${len}`;
      el.style.strokeDashoffset = String(len * (1 - e));
      const q = el.getPointAtLength(len * e);
      head.setAttribute("cx", String(q.x));
      head.setAttribute("cy", String(q.y));
      head.setAttribute("opacity", p > 0 && p < 1 ? "1" : p >= 1 ? "1" : "0");
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pace]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" aria-label="Views by day, rising through the week" role="img" style={{ overflow: "visible" }}>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--border)" strokeOpacity={0.5} />
      ))}
      <path ref={path} d={d} fill="none" stroke="var(--brand)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ strokeDasharray: 2000, strokeDashoffset: 2000 }} />
      <g style={{ filter: SIGNAL_BLOOM_FILTER }}>
        <circle ref={dot} r={4} fill="var(--brand)" opacity={0} />
      </g>
      <motion.line x1={0} x2={W} y1={H} y2={H} stroke="var(--border-strong)" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6 / pace, ease: EASE_SIGNAL }} />
    </svg>
  );
}
