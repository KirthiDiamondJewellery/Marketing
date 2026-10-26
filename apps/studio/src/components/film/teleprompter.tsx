"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FlipHorizontal2, Minus, Pause, Play, Plus, RotateCcw, X } from "lucide-react";
import { cn } from "@/components/ui";

const SIZE_KEY = "aos.prompter.size";
const SPEED_KEY = "aos.prompter.speed";
const MIRROR_KEY = "aos.prompter.mirror";

function readNum(key: string, fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: string) {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    // private mode: the setting just isn't remembered
  }
}

/**
 * Full-screen teleprompter: large text that scrolls at an adjustable speed, a reading line a third of the way down,
 * and a mirror toggle for beam-splitter rigs. Space plays and pauses, arrows change the speed, +/- the size,
 * M mirrors, Esc closes. Size, speed and mirror are remembered on this device.
 */
export function Teleprompter({ title, hook, body, onClose, onFilmed }: { title: string; hook: string | null; body: string; onClose: () => void; onFilmed?: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(48);
  const [speed, setSpeed] = useState(40);
  const [mirror, setMirror] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [chrome, setChrome] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pos = useRef(0);

  useEffect(() => {
    setSize(readNum(SIZE_KEY, window.innerWidth < 640 ? 34 : 52));
    setSpeed(readNum(SPEED_KEY, 40));
    try {
      setMirror(window.localStorage.getItem(MIRROR_KEY) === "1");
    } catch {
      // default
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Smooth scroll at `speed` px/s while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const el = scroller.current;
    if (el) pos.current = el.scrollTop;
    const tick = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      if (el) {
        pos.current += speed * dt;
        el.scrollTop = pos.current;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  // 3-2-1 before it starts rolling.
  useEffect(() => {
    if (count === null) return;
    if (count === 0) {
      setCount(null);
      setPlaying(true);
      return;
    }
    const t = setTimeout(() => setCount((c) => (c === null ? null : c - 1)), 700);
    return () => clearTimeout(t);
  }, [count]);

  const poke = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChrome(false), 2500);
  }, []);
  useEffect(() => {
    if (!playing) {
      setChrome(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    } else poke();
  }, [playing, poke]);

  const toggle = useCallback(() => {
    if (playing) setPlaying(false);
    else if (count === null) setCount(3);
  }, [playing, count]);
  const changeSpeed = useCallback((d: number) => setSpeed((s) => {
    const n = Math.max(10, Math.min(240, s + d));
    save(SPEED_KEY, String(n));
    return n;
  }), []);
  const changeSize = useCallback((d: number) => setSize((s) => {
    const n = Math.max(22, Math.min(110, s + d));
    save(SIZE_KEY, String(n));
    return n;
  }), []);
  const flip = useCallback(() => setMirror((m) => {
    save(MIRROR_KEY, m ? "0" : "1");
    return !m;
  }), []);
  const restart = useCallback(() => {
    setPlaying(false);
    setCount(null);
    pos.current = 0;
    scroller.current?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        changeSpeed(10);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        changeSpeed(-10);
      } else if (e.key === "+" || e.key === "=") changeSize(4);
      else if (e.key === "-") changeSize(-4);
      else if (e.key.toLowerCase() === "m") flip();
      else if (e.key.toLowerCase() === "r") restart();
      poke();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, toggle, changeSpeed, changeSize, flip, restart, poke]);

  const paras = body.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const lines = hook && paras[0]?.toLowerCase() !== hook.toLowerCase() ? [hook, ...paras] : paras;

  const ctrl = "grid size-10 place-items-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white";
  const node = (
    <div role="dialog" aria-modal="true" aria-label={`Teleprompter: ${title}`} className="fixed inset-0 z-[90] bg-black text-white" onMouseMove={poke} onTouchStart={poke}>
      <div
        ref={scroller}
        className="absolute inset-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onClick={toggle}
        onWheel={() => {
          if (scroller.current) pos.current = scroller.current.scrollTop;
        }}
      >
        <div
          className="mx-auto max-w-[min(1100px,92vw)] px-4 pb-[70vh] pt-[34vh]"
          style={{ transform: mirror ? "scaleX(-1)" : undefined, fontSize: size, lineHeight: 1.32 }}
        >
          {lines.map((l, i) => (
            <p key={i} className={cn("mb-[0.9em] font-medium tracking-[-0.01em] [text-wrap:pretty]", i === 0 ? "text-white" : "text-white/90")}>
              {l}
            </p>
          ))}
          <p className="mt-[1.5em] text-[0.5em] text-white/40">End of script. Hold still for a second.</p>
        </div>
      </div>
      {/* Reading line */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[33vh] flex items-center">
        <span className="h-0 w-0 border-y-[10px] border-l-[14px] border-y-transparent border-l-brand" />
        <span className="h-px flex-1 bg-gradient-to-r from-brand/70 via-white/10 to-transparent" />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[22vh] bg-gradient-to-b from-black to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[30vh] bg-gradient-to-t from-black to-transparent" />

      {count !== null ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="text-[160px] font-medium tabular text-white/90">{count}</span>
        </div>
      ) : null}

      <div className={cn("absolute inset-x-0 top-0 flex items-center gap-2 px-4 py-3 transition-opacity duration-300", chrome ? "opacity-100" : "pointer-events-none opacity-0")}>
        <p className="min-w-0 flex-1 truncate text-[14px] text-white/70">{title}</p>
        <button type="button" onClick={onClose} className={ctrl} aria-label="Close teleprompter (Esc)">
          <X className="size-5" strokeWidth={1.75} />
        </button>
      </div>

      <div className={cn("absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 px-4 pb-6 pt-3 transition-opacity duration-300", chrome ? "opacity-100" : "pointer-events-none opacity-0")}>
        <div className="flex items-center gap-1">
          <button type="button" onClick={restart} className={ctrl} aria-label="Back to the top (R)">
            <RotateCcw className="size-5" strokeWidth={1.75} />
          </button>
          <button type="button" onClick={toggle} className="grid size-14 place-items-center rounded-full bg-white text-black transition-transform active:scale-95" aria-label={playing ? "Pause (Space)" : "Start (Space)"}>
            {playing ? <Pause className="size-6" fill="currentColor" strokeWidth={0} /> : <Play className="ml-0.5 size-6" fill="currentColor" strokeWidth={0} />}
          </button>
          <button type="button" onClick={flip} className={cn(ctrl, mirror && "bg-white/15 text-white")} aria-pressed={mirror} aria-label="Mirror (M)">
            <FlipHorizontal2 className="size-5" strokeWidth={1.75} />
          </button>
        </div>
        <label className="flex items-center gap-3 text-[13px] text-white/70">
          Speed
          <input type="range" min={10} max={240} step={5} value={speed} onChange={(e) => { const n = Number(e.target.value); setSpeed(n); save(SPEED_KEY, String(n)); }} className="w-36 accent-[var(--brand)]" aria-label="Scroll speed" />
          <span className="w-8 tabular text-white/50">{speed}</span>
        </label>
        <div className="flex items-center gap-1 text-[13px] text-white/70">
          Size
          <button type="button" onClick={() => changeSize(-4)} className={ctrl} aria-label="Smaller text (-)">
            <Minus className="size-4" strokeWidth={2} />
          </button>
          <button type="button" onClick={() => changeSize(4)} className={ctrl} aria-label="Larger text (+)">
            <Plus className="size-4" strokeWidth={2} />
          </button>
        </div>
        {onFilmed ? (
          <button type="button" onClick={onFilmed} className="h-10 rounded-md border border-white/25 px-4 text-[14px] font-medium text-white hover:bg-white/10">
            Mark as filmed
          </button>
        ) : null}
      </div>
    </div>
  );
  return typeof document === "undefined" ? null : createPortal(node, document.body);
}
