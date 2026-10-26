"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Download, Play, X } from "lucide-react";
import { Button, buttonClass, cn, Input } from "@/components/ui";
import type { ReadyVideo } from "@/server/queries/calendar";
import { scheduleReadyAction } from "@/server/actions/approvals";
import { markReadyPostedAction } from "@/server/actions/calendar";
import { PlatformGlyph } from "@/motion/PlatformGlyph";
import { ThumbPlaceholder } from "@/components/content/shared";
import { toast } from "@/components/content/toast";
import { MakeTrialButton } from "@/components/trial-reels/trial-reels";
import { fmtDuration, fmtRelative, platformLabel, zonedParts, zonedToUtc } from "@/components/content/format";

/** "Ready to post": approved videos that aren't scheduled yet. Schedule, download, or say you posted it yourself. */
export function ReadyList({ videos, platforms, tz, trialOn = true }: { videos: ReadyVideo[]; platforms: string[]; tz: string; trialOn?: boolean }) {
  const [playing, setPlaying] = useState<ReadyVideo | null>(null);
  if (!videos.length) {
    return (
      <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <p className="text-body text-fg">Nothing waiting.</p>
        <p className="mt-1 text-small text-fg-2">Approve a video on Edit and choose Save as ready.</p>
      </div>
    );
  }
  return (
    <>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {videos.map((v) => (
          <ReadyCard key={v.id} video={v} platforms={platforms} tz={tz} trialOn={trialOn} onPlay={() => setPlaying(v)} />
        ))}
      </ul>
      {playing ? <Player video={playing} onClose={() => setPlaying(null)} /> : null}
    </>
  );
}

type Panel = "schedule" | "posted" | null;

function ReadyCard({ video, platforms, tz, trialOn, onPlay }: { video: ReadyVideo; platforms: string[]; tz: string; trialOn: boolean; onPlay: () => void }) {
  const [panel, setPanel] = useState<Panel>(null);
  const ref = useRef<HTMLLIElement>(null);
  const choices = [...new Set([...platforms, ...video.platforms])];

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanel(null);
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setPanel(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [panel]);

  const download = `/api/media/${video.videoId}?download=1&name=${encodeURIComponent(video.title)}`;
  return (
    <li ref={ref} className={cn("relative flex gap-4 rounded-lg border bg-surface-1 p-3", video.status === "failed" ? "border-danger/40" : "border-border")}>
      <button
        type="button"
        onClick={onPlay}
        disabled={!video.videoId}
        className="group relative aspect-[9/16] w-[88px] shrink-0 overflow-hidden rounded-md border border-border bg-surface-3 disabled:cursor-default"
        aria-label={video.videoId ? `Play ${video.title}` : "No preview yet"}
      >
        {video.coverId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/media/${video.coverId}`} alt="" loading="lazy" className="size-full object-cover" />
        ) : video.videoId ? (
          <video src={`/api/media/${video.videoId}#t=0.5`} preload="metadata" muted playsInline className="size-full object-cover" aria-hidden />
        ) : (
          <ThumbPlaceholder className="size-full" />
        )}
        {video.videoId ? (
          <span className="absolute inset-0 grid place-items-center bg-[color-mix(in_srgb,var(--bg)_25%,transparent)] opacity-80 transition-opacity group-hover:opacity-100">
            <span className="grid size-8 place-items-center rounded-full bg-surface-1/90 text-fg">
              <Play className="size-3.5 translate-x-px" fill="currentColor" />
            </span>
          </span>
        ) : null}
        {video.durationS ? <span className="absolute bottom-1 right-1 rounded-[4px] bg-surface-1/90 px-1 text-[11px] tabular text-fg">{fmtDuration(video.durationS)}</span> : null}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-small font-medium text-fg">{video.title}</h3>
          <p className="mt-0.5 text-caption text-fg-3">Approved {fmtRelative(video.since)}</p>
        </div>
        {video.platforms.length ? (
          <div className="flex items-center gap-1.5 text-fg-2" aria-label={`Planned for ${video.platforms.map(platformLabel).join(", ")}`}>
            {video.platforms.map((p) => (
              <span key={p} title={platformLabel(p)}>
                <PlatformGlyph platform={p} size={14} />
              </span>
            ))}
          </div>
        ) : null}
        {video.problems.map((p) => (
          <p key={p} className="flex gap-1.5 text-caption text-danger">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            <span>{p}</span>
          </p>
        ))}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <Button size="sm" variant="primary" aria-expanded={panel === "schedule"} onClick={() => setPanel(panel === "schedule" ? null : "schedule")}>
            {video.status === "failed" ? "Try again" : "Schedule"}
          </Button>
          {video.videoId ? (
            <a href={download} className={buttonClass("secondary", "sm", "px-2.5")}>
              <Download className="size-3.5" /> Download
            </a>
          ) : null}
          <Button size="sm" variant="ghost" className="px-2 text-fg-3" aria-expanded={panel === "posted"} onClick={() => setPanel(panel === "posted" ? null : "posted")}>
            Mark as posted
          </Button>
          {trialOn ? <MakeTrialButton start={{ kind: "edit", editRef: video.editRef, name: video.title }} className="px-2 text-fg-3" /> : null}
        </div>
      </div>

      {panel ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 rounded-lg border border-border-strong bg-surface-2 p-4 shadow-[var(--shadow-3)] sm:left-auto sm:w-[320px]" role="dialog" aria-label={panel === "schedule" ? "Schedule" : "Mark as posted"}>
          {panel === "schedule" ? (
            <SchedulePanel video={video} choices={choices} tz={tz} onDone={() => setPanel(null)} />
          ) : (
            <PostedPanel video={video} choices={choices} onDone={() => setPanel(null)} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function PlatformToggles({ choices, picked, onToggle }: { choices: string[]; picked: string[]; onToggle: (p: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Platforms">
      {choices.map((p) => {
        const on = picked.includes(p);
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(p)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors duration-[120ms]",
              on ? "border-brand/60 bg-brand-tint text-fg" : "border-border text-fg-3 hover:border-border-strong hover:text-fg",
            )}
          >
            <PlatformGlyph platform={p} size={13} />
            {platformLabel(p)}
          </button>
        );
      })}
    </div>
  );
}

function toggle(list: string[], p: string): string[] {
  return list.includes(p) ? list.filter((x) => x !== p) : [...list, p];
}

/** Tomorrow at 9:00 in the workspace timezone, as a datetime-local value. */
function defaultTime(tz: string): string {
  const p = zonedParts(new Date(Date.now() + 86_400_000), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T09:00`;
}

function SchedulePanel({ video, choices, tz, onDone }: { video: ReadyVideo; choices: string[]; tz: string; onDone: () => void }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>(video.platforms.length ? video.platforms : choices);
  const [mode, setMode] = useState<"next" | "pick">("next");
  const [value, setValue] = useState(() => defaultTime(tz));
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        let at: string | null = null;
        if (mode === "pick") {
          const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
          if (!m) return toast("Pick a date and time.", { tone: "error" });
          at = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz).toISOString();
        }
        start(async () => {
          const res = await scheduleReadyAction(video.id, { platforms: picked, at });
          if (res.ok) {
            toast(res.message ?? "Scheduling it now.", { by: "Publisher" });
            onDone();
            router.refresh();
          } else toast(res.error, { tone: "error" });
        });
      }}
    >
      <div className="flex flex-col gap-2">
        <span className="text-caption text-fg-3">Post on</span>
        <PlatformToggles choices={choices} picked={picked} onToggle={(p) => setPicked((l) => toggle(l, p))} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-caption text-fg-3">When</legend>
        <label className="flex items-center gap-2 text-small text-fg">
          <input type="radio" name={`when-${video.id}`} checked={mode === "next"} onChange={() => setMode("next")} className="accent-[var(--brand)]" />
          Next open slot
        </label>
        <label className="flex items-center gap-2 text-small text-fg">
          <input type="radio" name={`when-${video.id}`} checked={mode === "pick"} onChange={() => setMode("pick")} className="accent-[var(--brand)]" />
          Pick a time
        </label>
        {mode === "pick" ? (
          <>
            <input
              type="datetime-local"
              value={value}
              step={900}
              onChange={(e) => setValue(e.target.value)}
              className="h-10 w-full rounded-sm border border-border bg-surface-1 px-3 text-[15px] text-fg outline-none [color-scheme:dark] focus:border-brand focus:shadow-[0_0_0_3px_var(--brand-tint)]"
              aria-label="Post time"
            />
            <span className="text-caption text-fg-3">{tz.replace(/_/g, " ")} time</span>
          </>
        ) : null}
      </fieldset>
      <Button type="submit" variant="primary" disabled={pending || !picked.length}>
        {pending ? "Scheduling…" : "Schedule"}
      </Button>
    </form>
  );
}

function PostedPanel({ video, choices, onDone }: { video: ReadyVideo; choices: string[]; onDone: () => void }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await markReadyPostedAction(video.id, { platforms: picked, url });
          if (res.ok) {
            toast(res.message, { by: "Publisher" });
            onDone();
            router.refresh();
          } else toast(res.error, { tone: "error" });
        });
      }}
    >
      <p className="text-small text-fg-2">Posted it yourself? Say where, so it leaves this list and its results count.</p>
      <PlatformToggles choices={choices} picked={picked} onToggle={(p) => setPicked((l) => toggle(l, p))} />
      {picked.length === 1 ? <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Post link (optional)" aria-label="Post link" /> : null}
      <Button type="submit" variant="secondary" disabled={pending || !picked.length}>
        {pending ? "Saving…" : "Mark as posted"}
      </Button>
    </form>
  );
}

function Player({ video, onClose }: { video: ReadyVideo; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={video.title}>
      <div className="relative flex max-h-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <video
          src={`/api/media/${video.videoId}`}
          controls
          autoPlay
          playsInline
          className="max-h-[80vh] w-auto max-w-[min(420px,calc(100vw-32px))] rounded-lg border border-border bg-black"
          style={{ aspectRatio: "9 / 16" }}
        />
        <div className="flex w-full items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-small text-fg">{video.title}</p>
          <Button size="sm" variant="secondary" onClick={onClose} aria-label="Close">
            <X className="size-4" /> Close
          </Button>
        </div>
      </div>
    </div>
  );
}
