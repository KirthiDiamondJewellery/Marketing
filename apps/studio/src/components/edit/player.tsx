"use client";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { MessageSquarePlus, Pause, Play, Volume2, VolumeX } from "lucide-react";

export type PinnedNote = { id: number; at: number; text: string };

export const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Vertical player with a timeline: click (or press Enter on) the timeline to pin a note to that moment. */
export function Player({ src, durationHint, notes, onPin, label }: { src: string; durationHint: number | null; notes: PinnedNote[]; onPin: (at: number) => void; label: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(durationHint ?? 0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setT(0);
    setPlaying(false);
    setFailed(false);
  }, [src]);

  const seekFrom = (e: ReactMouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const at = x * (dur || 0);
    if (video.current) {
      video.current.currentTime = at;
      video.current.pause();
    }
    setT(at);
    return at;
  };
  const toggle = () => (video.current?.paused ? void video.current.play() : video.current?.pause());

  return (
    <div className="flex w-full max-w-[320px] flex-col gap-2.5">
      <div className="relative w-full overflow-hidden rounded-[14px] border border-border-strong bg-[#08060a]" style={{ aspectRatio: "9 / 16" }}>
        {!failed ? (
          <video
            ref={video}
            key={src}
            src={src}
            className="h-full w-full cursor-pointer object-contain"
            playsInline
            muted={muted}
            preload="metadata"
            aria-label={label}
            onLoadedMetadata={(e) => setDur(e.currentTarget.duration || durationHint || 0)}
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setFailed(true)}
            onClick={toggle}
          />
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-small text-white/70">This video file isn&apos;t on this computer.</div>
        )}
        {!playing && !failed ? (
          <button
            type="button"
            onClick={() => void video.current?.play()}
            className="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-transform hover:scale-105 motion-reduce:transition-none"
            aria-label="Play"
          >
            <Play className="ml-0.5 size-6" fill="currentColor" strokeWidth={0} />
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={toggle} className="grid size-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg" aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="size-4" fill="currentColor" strokeWidth={0} /> : <Play className="size-4" fill="currentColor" strokeWidth={0} />}
        </button>
        <span className="w-[74px] shrink-0 font-mono text-[11px] text-fg-3 tabular">
          {stamp(t)} / {stamp(dur)}
        </span>
        <button type="button" onClick={() => setMuted((m) => !m)} className="ml-auto grid size-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg" aria-label={muted ? "Sound on" : "Mute"}>
          {muted ? <VolumeX className="size-4" strokeWidth={1.75} /> : <Volume2 className="size-4" strokeWidth={1.75} />}
        </button>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Timeline. Click, or press Enter, to pin a note to this moment"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(t)}
        aria-valuetext={stamp(t)}
        data-testid="timeline"
        className="group relative h-9 cursor-pointer select-none rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        onClick={(e) => onPin(seekFrom(e))}
        onKeyDown={(e) => {
          if (!video.current) return;
          if (e.key === "ArrowRight") video.current.currentTime = Math.min(dur, video.current.currentTime + 1);
          else if (e.key === "ArrowLeft") video.current.currentTime = Math.max(0, video.current.currentTime - 1);
          else if (e.key === "Enter" || e.key === "n") {
            e.preventDefault();
            onPin(video.current.currentTime);
          }
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-3 group-hover:h-2" />
        <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-fg-3 group-hover:h-2" style={{ width: `${dur ? (t / dur) * 100 : 0}%` }} />
        {notes.map((n) => (
          <span
            key={n.id}
            title={`${stamp(n.at)}: ${n.text || "new note"}`}
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface-1 bg-brand"
            style={{ left: `${dur ? Math.min(100, (n.at / dur) * 100) : 0}%` }}
          />
        ))}
        <span className="pointer-events-none absolute top-1/2 h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg" style={{ left: `${dur ? (t / dur) * 100 : 0}%` }} />
      </div>
      <button
        type="button"
        onClick={() => onPin(video.current?.currentTime ?? t)}
        className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong py-2 text-small text-fg-2 hover:border-fg-3 hover:text-fg"
      >
        <MessageSquarePlus className="size-4" strokeWidth={1.75} /> Add a note at {stamp(t)}
      </button>
    </div>
  );
}
