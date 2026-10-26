"use client";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AgentLive, LiveEvent, ScheduledPost } from "@/lib/live";
import { useLive } from "@/lib/use-live";
import { BrandMark } from "@/components/brand-mark";
import { AgentMonogram } from "@/motion/AgentMonogram";
import { CometField, cometControl } from "@/motion/comet";
import { useFrame } from "@/motion/frame";
import { GoLiveBurst } from "@/motion/GoLiveBurst";
import { PlatformGlyph, PLATFORM_NAMES } from "@/motion/PlatformGlyph";
import { onRelay } from "@/motion/relay-bus";
import { useShowcaseReduced } from "@/motion/reduced";
import { SignalRing } from "@/motion/SignalRing";
import { EASE_OUT, SIGNAL_BLOOM_FILTER, polar } from "@/motion/tokens";
import { COMPACT, FULL, NETWORK, OrbitClock, POST_ENTRY_DEG, edgeKey, liveAngle, plainLabel, seatPoint, type Geometry } from "./geometry";
import { STORYLINES } from "@/components/reel/storylines";
import { AgentCard } from "./AgentCard";
import { claimMoments } from "@/components/reel/moment-bus";

const ORDER = ["chief_of_staff", "strategist", "analyst", "copywriter", "art_director", "publisher", "community"];
const LOOP_MS = 40_000;
const HANDOFF_LINES = STORYLINES.flatMap((s) => s.steps.flatMap((x) => (x.kind === "handoff" ? [x] : [])));

type Insets = { top: number; right: number; bottom: number; left: number };
type PostItem = { id: string; title: string; platforms: string[]; at: number | null };
type Burst = { id: number; platforms: string[]; title: string };
type Note = { id: number; text: string };

function groupPosts(posts: ScheduledPost[], loop: boolean): PostItem[] {
  const groups = new Map<string, PostItem>();
  for (const p of posts) {
    const title = (p.title ?? p.caption ?? "Scheduled post").split("\n")[0]!.trim();
    const at = p.at ? new Date(p.at).getTime() : null;
    const key = loop ? title : `${title}|${at ? Math.round(at / 60_000) : "x"}`;
    const g = groups.get(key);
    if (g) {
      if (!g.platforms.includes(p.platform)) g.platforms.push(p.platform);
    } else groups.set(key, { id: p.id, title, platforms: [p.platform], at });
  }
  const list = [...groups.values()];
  if (!loop) return list.filter((p) => p.at !== null);
  if (!list.length) return [];
  // Keep the conveyor busy enough to read as a schedule: at least four tiles, evenly spaced.
  const out: PostItem[] = [];
  for (let i = 0; out.length < Math.max(4, list.length); i++) {
    const p = list[i % list.length]!;
    out.push({ ...p, id: `${p.id}#${i}` });
  }
  return out.slice(0, 8);
}

/**
 * The orbit: brand mark at the centre inside the rotating Signal ring, agents on two counter-rotating tracks, relay comets
 * between them and the centre, and (full variant) scheduled posts riding the outer dial toward "now" at 12 o'clock.
 */
export function Orbit({
  variant = "full",
  loopPosts = false,
  insets = { top: 0, right: 0, bottom: 0, left: 0 },
  onScale,
  textScale = 1,
  labelSide = "outer",
  monoSize,
  showreel = false,
  avoid,
}: {
  /** Frame-relative rectangles (px) of HUD blocks that post labels must keep clear of. */
  avoid?: () => { left: number; top: number; right: number; bottom: number }[];
  /** Larger monograms for small-screen captures. */
  monoSize?: 56 | 64;
  /** Reel mode: keep relays flowing along the network and the dial busy, so any 10s clip has a story. */
  showreel?: boolean;
  variant?: "full" | "compact";
  loopPosts?: boolean;
  insets?: Insets;
  onScale?: (scale: number) => void;
  /** Enlarges labels for small-screen captures (9:16 reels). */
  textScale?: number;
  /** Where post titles sit: outside the dial (landscape) or inside it (portrait, where the dial fills the width). */
  labelSide?: "outer" | "inner";
}) {
  const ts = textScale;
  const base: Geometry = variant === "full" ? FULL : COMPACT;
  const g: Geometry = useMemo(() => (monoSize ? { ...base, mono: monoSize } : base), [base, monoSize]);
  const live = useLive();
  const liveRef = useRef(live);
  liveRef.current = live;
  const snap = live.snapshot;
  const reduced = useShowcaseReduced();
  const agents = useMemo(() => [...(snap?.agents ?? [])].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key)), [snap?.agents]);
  const agentsRef = useRef<AgentLive[]>(agents);
  agentsRef.current = agents;
  const byKey = useMemo(() => Object.fromEntries(agents.map((a) => [a.key, a])) as Record<string, AgentLive>, [agents]);

  // Stage fit.
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ scale: 0, left: 0, top: 0, w: 0, h: 0 });
  const boxRef = useRef(box);
  boxRef.current = box;
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const aw = Math.max(1, w - insets.left - insets.right);
      const ah = Math.max(1, h - insets.top - insets.bottom);
      if (g.post) {
        // Fit the dial (with its tiles) edge to edge; the "Now" label and burst may use the inset above it.
        const fit = 2 * (g.post + 30);
        const scale = Math.min(aw, ah) / fit;
        setBox({ scale, left: insets.left + aw / 2 - g.c * scale, top: insets.top + ah / 2 - g.cy * scale, w, h });
        return;
      }
      const scale = Math.min(aw / g.S, ah / g.H);
      setBox({ scale, left: insets.left + (aw - g.S * scale) / 2, top: insets.top + (ah - g.H * scale) / 2, w, h });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [g.S, g.H, g.post, g.c, g.cy, insets.left, insets.right, insets.top, insets.bottom]);
  useEffect(() => onScale?.(box.scale), [box.scale, onScale]);

  // Live positions, written every frame.
  const clock = useRef(new OrbitClock());
  const pos = useRef<Record<string, { x: number; y: number }>>({});
  const nodes = useRef<Record<string, HTMLDivElement | null>>({});
  const tiles = useRef<Record<string, HTMLDivElement | null>>({});
  const tileLabels = useRef<Record<string, HTMLDivElement | null>>({});
  const statusEls = useRef<Record<string, HTMLDivElement | null>>({});
  const nameEls = useRef<Record<string, HTMLDivElement | null>>({});
  const noteEls = useRef<Record<string, HTMLDivElement | null>>({});
  const labelSize = useRef<Record<string, { w: number; h: number; at: number }>>({});
  const hoveredRef = useRef<string | null>(null);
  const ticks = useRef<SVGGElement>(null);
  const cometGroup = useRef<SVGGElement>(null);
  const field = useRef<CometField | null>(null);
  const tNow = useRef(0);
  const ambient = useRef<Record<string, number>>({});
  const [hovered, setHovered] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [ignite, setIgnite] = useState<Record<string, number>>({});
  const [centerNote, setCenterNote] = useState<Note | null>(null);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [latest, setLatest] = useState<Record<string, string>>({});
  const seq = useRef(0);

  const posts = useMemo(() => (g.post ? groupPosts(snap?.posts ?? [], loopPosts) : []), [snap?.posts, loopPosts, g.post]);
  const avoidRef = useRef(avoid);
  avoidRef.current = avoid;
  const showreelRef = useRef(showreel);
  showreelRef.current = showreel;
  const labelSideRef = useRef(labelSide);
  labelSideRef.current = labelSide;
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const prevPost = useRef<Record<string, number>>({});

  const resolve = useCallback(
    (id: string) => {
      if (id.startsWith("center:")) {
        const p = pos.current[id.slice(7)];
        if (!p) return { x: g.c, y: g.cy };
        const dx = p.x - g.c;
        const dy = p.y - g.cy;
        const d = Math.hypot(dx, dy) || 1;
        return { x: g.c + (dx / d) * (g.ring + 4), y: g.cy + (dy / d) * (g.ring + 4) };
      }
      if (id === "center") return { x: g.c, y: g.cy };
      if (id === "ringtop") return { x: g.c, y: g.cy - g.ring - 4 };
      if (id === "now" && g.post) return { x: g.c, y: g.cy - g.post };
      return pos.current[id] ?? null;
    },
    [g],
  );

  useEffect(() => {
    if (!cometGroup.current) return;
    field.current = new CometField(cometGroup.current, resolve, { center: { x: g.c, y: g.cy }, bend: 0.18, scale: variant === "full" ? 1 : 1.5 });
    return () => field.current?.clear();
  }, [resolve, g.c, g.cy, variant]);

  const heat = useRef<Record<string, { start: number; dur: number }>>({});
  const edgeBase = useRef<Record<string, SVGPathElement | null>>({});
  const edgeLit = useRef<Record<string, SVGPathElement | null>>({});
  const lastHandoff = useRef(0);
  const [centerFlash, setCenterFlash] = useState(0);
  const flash = useCallback((key: string) => setIgnite((s) => ({ ...s, [key]: ++seq.current })), []);
  const note = useCallback((key: string, text: string) => {
    const id = ++seq.current;
    setNotes((s) => ({ ...s, [key]: { id, text } }));
    setTimeout(() => setNotes((s) => (s[key]?.id === id ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== key)) : s)), 3200);
  }, []);
  const say = useCallback((text: string) => {
    const id = ++seq.current;
    setCenterNote({ id, text });
    setTimeout(() => setCenterNote((n) => (n?.id === id ? null : n)), 3600);
  }, []);

  const send = useCallback(
    (from: string, to: string, opts: { summary?: string; dur?: number; strength?: number; delay?: number } = {}) => {
      const arrive = () => {
        const target = to.startsWith("center") ? null : to;
        if (target) {
          flash(target);
          if (opts.summary && variant === "full") note(target, opts.summary);
        } else if (opts.summary && variant === "full") say(opts.summary);
      };
      if (reduced || !field.current) return arrive();
      if (!from.startsWith("center") && !to.startsWith("center") && from !== "now" && to !== "now") {
        heat.current[edgeKey(from, to)] = { start: tNow.current + (opts.delay ?? 0), dur: opts.dur ?? 900 };
        lastHandoff.current = tNow.current;
      }
      field.current.launch({ from, to, durationMs: opts.dur ?? 900, strength: opts.strength ?? 1, delayMs: opts.delay ?? 0, tail: g.tail, onArrive: arrive });
    },
    [reduced, flash, note, say, g.tail, variant],
  );

  // Real events drive the comets.
  const lastLaunch = useRef(0);
  useEffect(() => {
    const stagger = () => {
      const d = Math.max(0, lastLaunch.current + 120 - tNow.current);
      lastLaunch.current = tNow.current + d;
      return d;
    };
    const names = () => Object.fromEntries(agentsRef.current.map((a) => [a.key, a.name])) as Record<string, string>;
    const off = liveRef.current.onEvent((e: LiveEvent) => {
      const known = agentsRef.current.some((a) => a.key === e.agent);
      if (!known) return;
      if (e.kind === "handoff" && e.to) send(e.agent, e.to, { summary: e.message, delay: stagger() });
      else if (e.kind === "progress" || e.kind === "text") {
        setLatest((s) => ({ ...s, [e.agent]: e.message }));
        send(e.agent, `center:${e.agent}`, { dur: 1100, strength: 0.75, delay: stagger() });
      } else if (e.kind === "approval") send(e.agent, `center:${e.agent}`, { summary: `${names()[e.agent] ?? e.agent}: ${e.message}`, dur: 1100, delay: stagger() });
      else if (e.kind === "error") flash(e.agent);
    });
    const offRelay = onRelay((r) => send(r.from, r.to, { summary: r.summary ?? `${names()[r.from] ?? r.from} → ${names()[r.to] ?? r.to}`, delay: stagger() }));
    return () => {
      off();
      offRelay();
    };
  }, [send, flash]);

  /**
   * Compact map labels sit outside each monogram, pointing away from the centre, and step aside (fade) whenever they
   * would collide with another agent, another label or the centre ring. Hovering an agent always shows its name.
   */
  const placeCompactLabels = (t: number) => {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const r = g.mono / 2 + 4;
    const order = [...agentsRef.current].sort((a, b) => (a.key === hoveredRef.current ? -1 : b.key === hoveredRef.current ? 1 : 0) || rank(a) - rank(b));
    for (const a of order) {
      const el = nameEls.current[a.key];
      const p = pos.current[a.key];
      if (!el || !p) continue;
      let size = labelSize.current[a.key];
      if (!size || t - size.at > 2000) size = labelSize.current[a.key] = { w: el.offsetWidth, h: el.offsetHeight, at: t };
      const dx = p.x - g.c;
      const dy = (p.y - g.cy) / g.squash;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      const gap = r + 6;
      // Candidate spots, best first: pointing away from the centre, then below, right, left and above.
      const out = Math.abs(ux) > 0.55 ? (ux > 0 ? "right" : "left") : uy > 0 ? "below" : "above";
      const spots = [out, "below", "right", "left", "above"] as const;
      const rect = (side: (typeof spots)[number]) => {
        const x0 = side === "right" ? p.x + gap : side === "left" ? p.x - gap - size.w : p.x - size.w / 2;
        const y0 = side === "below" ? p.y + gap - 4 : side === "above" ? p.y - gap - size.h + 4 : p.y - size.h / 2;
        return { x0, y0, x1: x0 + size.w, y1: y0 + size.h };
      };
      // The visible area of the frame, in stage units (the panel is often wider than the stage).
      const bx = boxRef.current;
      const minX = -bx.left / bx.scale + 4;
      const maxX = (bx.w - bx.left) / bx.scale - 4;
      const minY = -bx.top / bx.scale + 2;
      const maxY = (bx.h - bx.top) / bx.scale - 2;
      const free = (box: { x0: number; y0: number; x1: number; y1: number }) => {
        const hits = (cx: number, cy: number, rad: number) => {
          const nx = Math.max(box.x0, Math.min(cx, box.x1));
          const ny = Math.max(box.y0, Math.min(cy, box.y1));
          return Math.hypot(nx - cx, ny - cy) < rad;
        };
        if (box.x0 < minX || box.x1 > maxX || box.y0 < minY || box.y1 > maxY) return false;
        if (hits(g.c, g.cy, g.ring + 26)) return false;
        for (const o of agentsRef.current) {
          const q = pos.current[o.key];
          if (o.key !== a.key && q && hits(q.x, q.y, r + 2)) return false;
        }
        for (const o of placed) if (box.x0 < o.x1 + 6 && box.x1 > o.x0 - 6 && box.y0 < o.y1 + 2 && box.y1 > o.y0 - 2) return false;
        return true;
      };
      let box = rect(out);
      let clear = false;
      for (const side of spots) {
        const cand = rect(side);
        if (free(cand)) {
          box = cand;
          clear = true;
          break;
        }
      }
      if (a.key === hoveredRef.current) clear = true;
      if (clear) placed.push(box);
      el.style.transform = `translate3d(${(box.x0 - p.x).toFixed(1)}px, ${(box.y0 - p.y).toFixed(1)}px, 0)`;
      const want = clear ? "1" : "0";
      if (el.style.opacity !== want) el.style.opacity = want;
    }
  };

  /** Screen regions post labels must not cover (status, clock, the go-live row), in stage units. */
  const hudRects = () => {
    const bx = boxRef.current;
    const sc = bx.scale || 1;
    const out = (avoidRef.current?.() ?? []).map((r) => ({ x0: (r.left - bx.left) / sc - 8, y0: (r.top - bx.top) / sc - 6, x1: (r.right - bx.left) / sc + 8, y1: (r.bottom - bx.top) / sc + 6 }));
    if (g.post) out.push({ x0: g.c - 4, y0: g.cy - g.post - 52, x1: g.c + 380, y1: g.cy - g.post + 4 });
    return out;
  };

  // One frame loop for the whole stage.
  useFrame((t) => {
    tNow.current = t;
    const still = reduced;
    for (const a of agentsRef.current) {
      const p = seatPoint(g, a.key, still ? 0 : clock.current.local(a.key, t));
      pos.current[a.key] = p;
      const el = nodes.current[a.key];
      if (el) el.style.transform = `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0)`;
      // Working agents keep receiving work from the centre, so a busy team always reads as busy.
      if (a.state === "working" && !still) {
        const next = ambient.current[a.key] ?? t + 800 + Math.random() * 1600;
        if (t >= next) {
          send(`center:${a.key}`, a.key, { dur: 1000, strength: 0.6 });
          ambient.current[a.key] = t + 5200 + Math.random() * 3800;
        } else ambient.current[a.key] = next;
      }
    }
    // A working agent's status line steps aside while a neighbour passes underneath it.
    for (const a of agentsRef.current) {
      const el = statusEls.current[a.key];
      const p = pos.current[a.key];
      if (!el || !p) continue;
      let clear = true;
      for (const b of agentsRef.current) {
        const q = pos.current[b.key];
        if (b.key === a.key || !q) continue;
        if (Math.abs(q.x - p.x) < 150 && q.y - p.y > -10 && q.y - p.y < 110) clear = false;
      }
      const want = clear ? "1" : "0";
      if (el.style.opacity !== want) el.style.opacity = want;
    }
    // The network: hairlines between agents who hand off, lit by the Signal while a comet travels them.
    for (const [a, b] of NETWORK) {
      const k = edgeKey(a, b);
      const el = edgeBase.current[k];
      const lit = edgeLit.current[k];
      const p = pos.current[a];
      const q = pos.current[b];
      if (!el || !p || !q) continue;
      const c = cometControl(p, q, 0, { x: g.c, y: g.cy });
      const d = `M${p.x.toFixed(1)} ${p.y.toFixed(1)}Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
      el.setAttribute("d", d);
      if (lit) {
        const h = heat.current[k];
        let o = 0;
        if (h) {
          const u = (t - h.start) / h.dur;
          o = u < 0 ? 0 : u < 0.2 ? u / 0.2 : u < 1 ? 1 : Math.max(0, 1 - (u - 1) / 1.1);
          if (u > 2.2) delete heat.current[k];
        }
        lit.setAttribute("d", d);
        lit.setAttribute("opacity", (o * 0.55).toFixed(3));
      }
    }
    if (showreelRef.current && !still && t - lastHandoff.current > 3300 && agentsRef.current.length > 1) {
      lastHandoff.current = t;
      const keys = new Set<string>(agentsRef.current.map((x) => x.key));
      const options = NETWORK.filter(([a, b]) => keys.has(a) && keys.has(b));
      const [a, b] = options[Math.floor(Math.random() * options.length)]!;
      const [from, to] = Math.random() < 0.7 ? [a, b] : [b, a];
      const names = Object.fromEntries(agentsRef.current.map((x) => [x.key, x.name])) as Record<string, string>;
      const line = HANDOFF_LINES.find((h) => h.agent === from && h.to === to);
      send(from, to, { summary: line?.message ?? `${names[from]} → ${names[to]}` });
    }
    // Relay summaries stay on screen: shift a chip sideways when its agent sits near the frame edge.
    {
      const bx = boxRef.current;
      // Visible frame in stage units, 16px in from each edge.
      const m = 16 / (bx.scale || 1);
      const minX = -bx.left / (bx.scale || 1) + m;
      const maxX = (bx.w - bx.left) / (bx.scale || 1) - m;
      for (const a of agentsRef.current) {
        const el = noteEls.current[a.key];
        const p = pos.current[a.key];
        if (!el || !p) continue;
        for (const node of Array.from(el.children)) {
          const chip = node as HTMLElement;
          // Never wider than the frame; the ellipsis is the last resort.
          const cap = `${Math.floor(Math.min(340 * ts, maxX - minX))}px`;
          if (chip.style.maxWidth !== cap) chip.style.maxWidth = cap;
          const w = chip.offsetWidth;
          const shift = p.x - w / 2 < minX ? minX - (p.x - w / 2) : p.x + w / 2 > maxX ? maxX - (p.x + w / 2) : 0;
          chip.style.position = "relative";
          chip.style.left = `${shift.toFixed(1)}px`;
        }
      }
    }
    if (variant === "compact") placeCompactLabels(t);
    if (ticks.current && !still) ticks.current.setAttribute("transform", `rotate(${((-t / 260_000) * 360).toFixed(3)} ${g.c} ${g.cy})`);
    field.current?.tick(t);

    if (!g.post) return;
    const list = postsRef.current;
    const n = list.length;
    const nowMs = Date.now();
    list.forEach((p, i) => {
      const el = tiles.current[p.id];
      const label = tileLabels.current[p.id];
      if (!el) return;
      let angle: number | null;
      let opacity = 1;
      if (loopPosts) {
        const u = (((still ? 0 : t) / (showreelRef.current ? 26_000 : LOOP_MS) + i / n) % 1 + 1) % 1;
        angle = POST_ENTRY_DEG + (360 - POST_ENTRY_DEG) * u;
        opacity = Math.min(1, u / 0.04) * Math.min(1, (1 - u) / 0.015);
        const prev = prevPost.current[p.id];
        if (prev !== undefined && prev > 0.9 && u < 0.1 && !still) arrive(p);
        prevPost.current[p.id] = u;
      } else {
        const ms = (p.at ?? 0) - nowMs;
        angle = liveAngle(ms);
        const prev = prevPost.current[p.id];
        if (prev !== undefined && prev > 0 && ms <= 0) arrive(p);
        prevPost.current[p.id] = ms;
        if (ms <= 0) opacity = Math.max(0, 1 + ms / 1500);
      }
      if (angle === null) {
        el.style.opacity = "0";
        if (label) label.style.opacity = "0";
        return;
      }
      const q = polar(g.c, g.cy, g.post!, angle);
      el.style.transform = `translate3d(${q.x.toFixed(2)}px, ${q.y.toFixed(2)}px, 0)`;
      el.style.opacity = String(opacity);
      if (label) {
        const top = labelSideRef.current === "inner" ? 342 : 318;
        const show = angle > 262 && angle < top ? Math.min(1, (angle - 262) / 14, (top - angle) / 10) : 0;
        // Outside the dial when there is room, else inside it; hidden if both would cover the HUD.
        const half = (18 + 19 * Math.min(3, p.platforms.length)) / 2;
        const lw = label.offsetWidth;
        const lh = label.offsetHeight;
        const outer = { x0: q.x - half - 12 - lw, y0: q.y - lh / 2 };
        const innerBox = { x0: q.x - half, y0: q.y + 22 };
        const blocked = (b: { x0: number; y0: number }) => hudRects().some((r) => b.x0 < r.x1 && b.x0 + lw > r.x0 && b.y0 < r.y1 && b.y0 + lh > r.y0);
        const preferInner = labelSideRef.current === "inner";
        const order = preferInner ? [innerBox, outer] : [outer, innerBox];
        const spot = order.find((b) => !blocked(b));
        const at = spot ?? order[0]!;
        label.style.transform = `translate3d(${at.x0.toFixed(2)}px, ${at.y0.toFixed(2)}px, 0)`;
        label.style.textAlign = at === outer ? "right" : "left";
        label.style.opacity = String(spot ? show * opacity : 0);
      }
    });
  });

  const arrive = (p: PostItem) => {
    const id = ++seq.current;
    setBursts([{ id, platforms: p.platforms, title: p.title }]);
    setCenterFlash(id);
    field.current?.ripple("now", 34, 760);
    if (!reduced) field.current?.launch({ from: "ringtop", to: "now", durationMs: 520, tail: g.tail * 0.8 });
  };

  // Reel mode: moment 4 fires at the "now" marker when the dial is on screen.
  useEffect(() => {
    if (!g.post) return;
    return claimMoments((m) => {
      if (m !== 4) return false;
      const next = postsRef.current[0];
      arrive(next ?? { id: "demo", title: "Scheduled post", platforms: ["instagram", "tiktok", "youtube"], at: null });
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.post]);

  const hover = (key: string | null) => {
    clearTimeout(hoverTimer.current);
    if (key) hoveredRef.current = key;
    if (key) {
      if (hovered && hovered !== key) clock.current.release(hovered, tNow.current);
      clock.current.hold(key, tNow.current);
      setHovered(key);
    } else {
      hoverTimer.current = setTimeout(() => {
        hoveredRef.current = null;
        setHovered((h) => {
          if (h) clock.current.release(h, tNow.current);
          return null;
        });
      }, 160);
    }
  };

  const s = box.scale;
  const ready = s > 0;
  const hoveredAgent = hovered ? byKey[hovered] : undefined;
  const hp = hovered ? pos.current[hovered] : undefined;
  const workspaceName = snap?.workspace.name ?? "Your brand";
  const stageStyle: CSSProperties = { position: "absolute", left: box.left, top: box.top, width: g.S, height: g.H, transform: `scale(${s})`, transformOrigin: "0 0", opacity: ready ? 1 : 0 };

  return (
    <div ref={frame} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div style={stageStyle}>
        {/* Tracks and the dial. */}
        <svg width={g.S} height={g.H} viewBox={`0 0 ${g.S} ${g.H}`} aria-hidden style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <ellipse cx={g.c} cy={g.cy} rx={g.inner} ry={g.inner * g.squash} fill="none" stroke="var(--border)" strokeWidth={1} />
          <ellipse cx={g.c} cy={g.cy} rx={g.outer} ry={g.outer * g.squash} fill="none" stroke={variant === "compact" ? "var(--border-strong)" : "var(--border)"} strokeWidth={1} strokeDasharray="1 5" strokeLinecap="round" opacity={0.9} />
          {g.post && <Dial g={g} />}
          {NETWORK.map(([a, b]) => (
            <path key={edgeKey(a, b)} ref={(el) => void (edgeBase.current[edgeKey(a, b)] = el)} fill="none" stroke="var(--border-strong)" strokeWidth={1} opacity={0.32} />
          ))}
          <g ref={ticks}>
            {Array.from({ length: 120 }, (_, i) => {
              const a = i * 3;
              const major = i % 10 === 0;
              const p0 = polar(g.c, g.cy, g.ring + 16, a);
              const p1 = polar(g.c, g.cy, g.ring + (major ? 25 : 20), a);
              return <line key={i} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={major ? "var(--border-strong)" : "var(--border)"} strokeWidth={1} />;
            })}
          </g>
        </svg>

        {/* Centre: the brand inside the rotating Signal ring. */}
        <div style={{ position: "absolute", left: g.c - g.ring - 4, top: g.cy - g.ring - 4, width: (g.ring + 4) * 2, height: (g.ring + 4) * 2, display: "grid", placeItems: "center" }}>
          <div data-wake-ring style={{ position: "absolute", inset: 0 }}>
            <SignalRing size={(g.ring + 4) * 2} strokeWidth={2} sweep bloom periodMs={variant === "full" ? 7_000 : 9_000} />
          </div>
          {centerFlash > 0 && !reduced && (
            <motion.div
              key={centerFlash}
              aria-hidden
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: [0, 1, 0], scale: [0.97, 1.04, 1.1] }}
              transition={{ duration: 1.2, times: [0, 0.18, 1], ease: EASE_OUT }}
              style={{ position: "absolute", inset: 2, borderRadius: 999, boxShadow: "0 0 0 2px var(--brand), 0 0 32px rgba(149, 74, 251, 0.7), 0 0 90px rgba(149, 74, 251, 0.4), inset 0 0 40px rgba(149, 74, 251, 0.25)", pointerEvents: "none" }}
            />
          )}
          <BrandMark name={workspaceName} size={g.brand} />
        </div>
        {variant === "full" && (
          <div style={{ position: "absolute", left: g.c - 170, width: 340, top: g.cy + g.ring + 38, textAlign: "center", minHeight: 20 }}>
            <AnimatePresence mode="wait">
              {centerNote && (
                <motion.div key={centerNote.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.24, ease: EASE_OUT }} style={{ fontSize: 13 * ts, lineHeight: 1.4, color: "var(--text-secondary)" }}>
                  {centerNote.text}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Comets. Only the Signal blooms. */}
        <svg width={g.S} height={g.H} viewBox={`0 0 ${g.S} ${g.H}`} aria-hidden style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none", filter: SIGNAL_BLOOM_FILTER }}>
          {NETWORK.map(([a, b]) => (
            <path key={edgeKey(a, b)} ref={(el) => void (edgeLit.current[edgeKey(a, b)] = el)} fill="none" stroke="var(--brand)" strokeWidth={1.5} opacity={0} />
          ))}
          <g ref={cometGroup} />
        </svg>

        {/* Scheduled posts on the dial. */}
        {posts.map((p) => (
          <div key={p.id}>
            <div ref={(el) => void (tiles.current[p.id] = el)} style={{ position: "absolute", left: 0, top: 0, opacity: 0, willChange: "transform" }}>
              <div
                title={p.title}
                style={{ transform: "translate(-50%, -50%)", display: "flex", alignItems: "center", gap: 5, height: 28, padding: "0 9px", borderRadius: 8, background: "var(--surface-2)", boxShadow: "inset 0 0 0 1px var(--border-strong)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}
              >
                {p.platforms.slice(0, 3).map((pl) => (
                  <PlatformGlyph key={pl} platform={pl} size={14} />
                ))}
              </div>
            </div>
            <div ref={(el) => void (tileLabels.current[p.id] = el)} style={{ position: "absolute", left: 0, top: 0, opacity: 0, pointerEvents: "none", textAlign: "right", whiteSpace: "nowrap" }}>
              <div style={{ fontSize: 12 * ts, lineHeight: 1.35, color: "var(--text-secondary)", maxWidth: 220 * ts, overflow: "hidden", textOverflow: "ellipsis" }}>{p.title}</div>
              <div style={{ fontSize: 11 * ts, lineHeight: 1.35, color: "var(--text-muted)" }}>{loopPosts || p.at === null ? p.platforms.map((x) => PLATFORM_NAMES[x] ?? x).join(", ") : whenLabel(p.at)}</div>
            </div>
          </div>
        ))}
        {g.post && <NowMarker g={g} ts={ts} />}
        {g.post && (
          <div style={{ position: "absolute", left: g.c + 1, top: g.cy - g.post - 46, pointerEvents: "none" }}>
            <AnimatePresence>
              {bursts.map((b) => (
                <motion.div
                  key={b.id}
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.4 } }}
                  style={{ position: "absolute", left: 0, top: 0 }}
                >
                  <GoLiveBurst platforms={b.platforms} play layout="row" onDone={() => setTimeout(() => setBursts((all) => all.filter((x) => x.id !== b.id)), 1400)} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* Agents. Monograms only ever translate, so they stay upright. */}
        {agents.map((a) => {
          const label = a.state === "working" ? (latest[a.key] ?? plainLabel(a.label)) : null;
          const inner = (
            <AgentMonogram agent={a} size={g.mono} badge={a.state === "waiting" ? a.pendingApprovals : undefined} />
          );
          return (
            <div key={a.key} ref={(el) => void (nodes.current[a.key] = el)} style={{ position: "absolute", left: 0, top: 0, willChange: "transform", zIndex: hovered === a.key ? 3 : 2 }}>
              <div data-agent-anchor={a.key} style={{ position: "absolute", transform: "translate(-50%, -50%)" }} onPointerEnter={() => hover(a.key)} onPointerLeave={() => hover(null)}>
                {ignite[a.key] && !reduced && <Ignite key={ignite[a.key]} size={g.mono} />}
                {variant === "compact" ? (
                  <Link href={`/agents/${a.key}`} aria-label={`${a.name}: ${a.label}`} style={{ display: "block", borderRadius: 999 }}>
                    {inner}
                  </Link>
                ) : (
                  <div style={{ cursor: "default" }}>{inner}</div>
                )}
              </div>
              <div
                ref={variant === "compact" ? (el) => void (nameEls.current[a.key] = el) : undefined}
                style={
                  variant === "compact"
                    ? { position: "absolute", left: 0, top: 0, whiteSpace: "nowrap", pointerEvents: "none", opacity: 0, transition: "opacity 200ms var(--ease-out)" }
                    : { position: "absolute", top: g.mono / 2 + 10, left: 0, transform: "translateX(-50%)", textAlign: "center", whiteSpace: "nowrap", pointerEvents: "none" }
                }
              >
                <div style={{ fontSize: g.name * ts, lineHeight: 1.3, color: a.state === "idle" ? "var(--text-secondary)" : "var(--text-primary)", fontWeight: 500 }}>{a.name}</div>
                {g.status && label && (
                  <div ref={(el) => void (statusEls.current[a.key] = el)} style={{ transition: "opacity 240ms var(--ease-out)", fontSize: g.status * ts, lineHeight: 1.35, color: "var(--text-muted)", maxWidth: 168 * ts, overflow: "hidden", textOverflow: "ellipsis", margin: "2px auto 0" }}>{label}</div>
                )}
                <div ref={(el) => void (noteEls.current[a.key] = el)} style={{ display: "flex", justifyContent: "center" }}>
                <AnimatePresence mode="wait">
                  {notes[a.key] && (
                    <motion.div
                      key={notes[a.key]!.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2, ease: EASE_OUT }}
                      className="signal-left"
                      style={{ marginTop: 6, fontSize: 12.5 * ts, lineHeight: 1.35, padding: "5px 10px", borderRadius: 6, background: "var(--surface-3)", color: "var(--text-primary)", maxWidth: 340 * ts, overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      {notes[a.key]!.text}
                    </motion.div>
                  )}
                </AnimatePresence>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Hover card, in screen pixels so it stays crisp and readable at any stage scale. */}
      <AnimatePresence>
        {variant === "full" && hoveredAgent && hp && ready && (
          <AgentCard
            key={hoveredAgent.key}
            agent={hoveredAgent}
            latest={latest[hoveredAgent.key]}
            x={box.left + hp.x * s}
            y={box.top + hp.y * s}
            side={hp.x > g.c ? "left" : "right"}
            gap={(g.mono / 2 + 14) * s}
            frameW={box.w}
            frameH={box.h}
            onEnter={() => hover(hoveredAgent.key)}
            onLeave={() => hover(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** Label priority on the compact map: whoever needs you, then whoever is working, then the rest. */
function rank(a: AgentLive): number {
  return a.state === "waiting" ? 0 : a.state === "working" ? 1 : a.state === "blocked" ? 0 : 2;
}

function Ignite({ size }: { size: number }) {
  return (
    <motion.span
      aria-hidden
      initial={{ opacity: 1, scale: 1 }}
      animate={{ opacity: 0, scale: 1.32 }}
      transition={{ duration: 0.75, ease: EASE_OUT }}
      style={{ position: "absolute", left: "50%", top: "50%", width: size + 12, height: size + 12, marginLeft: -(size + 12) / 2, marginTop: -(size + 12) / 2, borderRadius: 999, boxShadow: "inset 0 0 0 2px var(--brand), 0 0 24px rgba(149, 74, 251, 0.45)", pointerEvents: "none" }}
    />
  );
}

function Dial({ g }: { g: Geometry }) {
  const r = g.post!;
  return (
    <g>
      <circle cx={g.c} cy={g.cy} r={r} fill="none" stroke="var(--border)" strokeWidth={1} />
      {Array.from({ length: 72 }, (_, i) => {
        const a = i * 5;
        if (a === 0) return null;
        const major = i % 6 === 0;
        const p0 = polar(g.c, g.cy, r + 5, a);
        const p1 = polar(g.c, g.cy, r + (major ? 13 : 9), a);
        return <line key={i} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={major ? "var(--border-strong)" : "var(--border)"} strokeWidth={1} />;
      })}
    </g>
  );
}

function NowMarker({ g, ts }: { g: Geometry; ts: number }) {
  const y = g.cy - g.post!;
  return (
    <>
      <svg width={g.S} height={g.H} viewBox={`0 0 ${g.S} ${g.H}`} aria-hidden style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none", filter: SIGNAL_BLOOM_FILTER }}>
        <line x1={g.c} x2={g.c} y1={y - 18} y2={y + 18} stroke="var(--brand)" strokeWidth={2} className="signal-pulse" />
      </svg>
      <div style={{ position: "absolute", left: g.c - 12, top: y - 26, transform: "translateX(-100%)", fontSize: 12 * ts, lineHeight: "16px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>Now</div>
    </>
  );
}

function whenLabel(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return "Now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `In ${Math.max(1, m)} min`;
  const d = new Date(at);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}
