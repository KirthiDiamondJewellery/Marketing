"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Bookmark, Heart, MessageCircle, Play, Send, Music2 } from "lucide-react";
import type { CaptionPreview, PreviewModel } from "@/server/queries/approvals";
import { cn } from "@/components/ui";
import { PlatformGlyph } from "@/motion";
import { platformLabel } from "@/components/shell/format";

type Of<T extends PreviewModel["type"]> = Extract<PreviewModel, { type: T }>;

/** True once the media file is known to be servable; renders stay on the hook cover until then (and if it's missing). */
function useMediaOk(src: string | null | undefined): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    fetch(src, { method: "HEAD" })
      .then((r) => alive && setOk(r.ok))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [src]);
  return ok;
}

export function duration(s: number | null | undefined): string {
  if (!s && s !== 0) return "";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function firstLine(text: string | null | undefined, max = 90): string {
  if (!text) return "";
  const line = text.split(/\n|(?<=[.?!])\s/)[0] ?? text;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * A vertical platform frame at true 9:16 with the platform's own chrome kept to a whisper: handle, caption line,
 * action rail. Brand colors stay out; only the 16px glyph identifies the platform (DESIGN §2.4).
 */
export function ReelFrame({
  platform,
  handle,
  caption,
  children,
  badge,
  bare = false,
  width = 220,
  ratio = 9 / 16,
}: {
  platform: string;
  handle: string | null;
  caption?: string | null;
  children: ReactNode;
  badge?: ReactNode;
  width?: number;
  ratio?: number;
  /** Real media carries its own burned-in labels; keep the top chrome off it. */
  bare?: boolean;
}) {
  return (
    <div className="relative shrink-0 overflow-hidden rounded-[14px] border border-border-strong bg-[#08060a]" style={{ width, aspectRatio: String(ratio) }}>
      <div className="absolute inset-0">{children}</div>
      {/* Chrome */}
      <div className={cn("pointer-events-none absolute inset-x-0 top-0 flex", bare && "hidden")} >
        <span className="flex w-full items-center justify-between px-3 pt-2.5 text-[11px] font-medium text-white/85">
        <span className="flex items-center gap-1.5">
          <PlatformGlyph platform={platform} size={13} />
          {platform === "tiktok" ? "For you" : platform === "youtube" ? "Shorts" : "Reels"}
        </span>
        {badge}
        </span>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-9 px-3 pb-3 text-white">
        <div className="flex items-center gap-1.5 text-[11px] font-medium">
          <span className="size-4 rounded-full border border-white/40 bg-white/15" />
          {handle ?? "yourbrand"}
        </div>
        {caption ? <p className="mt-1 line-clamp-2 text-[10.5px] leading-[14px] text-white/80">{caption}</p> : null}
        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-white/60">
          <Music2 className="size-2.5" strokeWidth={2} /> Original audio
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 right-2 flex flex-col items-center gap-3 text-white/85">
        <Heart className="size-4" strokeWidth={1.75} />
        <MessageCircle className="size-4" strokeWidth={1.75} />
        <Send className="size-4" strokeWidth={1.75} />
        <Bookmark className="size-4" strokeWidth={1.75} />
      </div>
    </div>
  );
}

/** Cover shown when there is no image yet: the hook as on-screen text, the way it opens the video. */
function HookCover({ hook, keyword }: { hook: string; keyword?: string | null }) {
  return (
    <div className="flex h-full flex-col justify-center bg-[#16111a] px-4">
      <p className="text-center text-[17px] font-medium leading-[22px] tracking-[-0.01em] text-white [text-wrap:balance]">{hook}</p>
      {keyword ? (
        <span className="mx-auto mt-4 rounded-full bg-white/10 px-2.5 py-1 font-mono text-[10px] tracking-wide text-white/80">Comment {keyword}</span>
      ) : null}
    </div>
  );
}

export function VideoPreview({ p, handle }: { p: Of<"video">; handle: string | null }) {
  const ok = useMediaOk(p.src);
  const [errored, setFailed] = useState(false);
  const failed = !ok || errored;
  const [playing, setPlaying] = useState(false);
  const caption = p.caption?.text ?? null;
  return (
    <ReelFrame
      platform={p.caption?.platform ?? "instagram"}
      handle={handle}
      caption={caption}
      ratio={p.width && p.height ? p.width / p.height : 9 / 16}
      bare={!failed}
      badge={
        <span className="rounded-[4px] bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-white/90 tabular">
          {p.ref ? `${p.ref} v${p.version ?? 1}` : ""} {duration(p.durationS)}
        </span>
      }
    >
      {!failed ? (
        <video
          src={p.src ?? undefined}
          className="h-full w-full object-cover"
          playsInline
          muted
          loop
          preload="metadata"
          onError={() => setFailed(true)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
        />
      ) : (
        <HookCover hook={firstLine(caption) || p.title || "Your edit"} />
      )}
      {!playing ? (
        <span className="pointer-events-none absolute left-1/2 top-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white" style={{ marginTop: failed ? 62 : 0 }}>
          <Play className="ml-0.5 size-4" fill="currentColor" strokeWidth={0} />
        </span>
      ) : null}
    </ReelFrame>
  );
}

export function ScriptFrame({ p, handle }: { p: Of<"script">; handle: string | null }) {
  const lead = p.captions[0];
  return (
    <ReelFrame platform={lead?.platform ?? "instagram"} handle={handle} caption={lead?.text ?? null}>
      <HookCover hook={p.hook ?? p.title ?? ""} keyword={p.keyword} />
    </ReelFrame>
  );
}

export function PostFrame({ p, handle }: { p: Of<"post">; handle: string | null }) {
  const ok = useMediaOk(p.media?.src);
  const [errored, setFailed] = useState(false);
  const failed = !ok || errored;
  return (
    <ReelFrame platform={p.platform} handle={handle} caption={p.caption} bare={!failed}>
      {!failed && p.media ? (
        <video src={p.media.src} className="h-full w-full object-cover" muted playsInline preload="metadata" onError={() => setFailed(true)} />
      ) : (
        <HookCover hook={firstLine(p.caption) || p.title || ""} />
      )}
    </ReelFrame>
  );
}

/** A DM or comment thread at phone width: their message, then the drafted reply. */
export function ReplyFrame({ p }: { p: Of<"reply"> }) {
  return (
    <div className="w-full max-w-[300px] shrink-0 overflow-hidden rounded-[14px] border border-border-strong bg-[#0b080e]">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5 text-[12px] font-medium text-white/90">
        <span className="size-6 rounded-full bg-white/15" />
        <span className="min-w-0 flex-1 truncate">{p.from ?? "Follower"}</span>
        <PlatformGlyph platform={p.platform} size={13} />
      </div>
      <div className="flex flex-col gap-2 px-3 py-4">
        {p.incoming ? <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md bg-white/10 px-3 py-2 text-[12.5px] leading-[18px] text-white/90">{p.incoming}</div> : null}
        <div className="max-w-[88%] self-end rounded-2xl rounded-br-md border border-dashed border-white/25 px-3 py-2 text-[12.5px] leading-[18px] text-white">{p.draft}</div>
        <span className="self-end text-[10px] text-white/45">Draft · not sent</span>
      </div>
    </div>
  );
}

/** Caption with hashtags under review: raw output, so Geist Mono (DESIGN §3). Tabs per platform. */
export function CaptionTabs({ captions, keyword }: { captions: CaptionPreview[]; keyword?: string | null }) {
  const [i, setI] = useState(0);
  const c = captions[i];
  if (!c) return null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Caption per platform">
        {captions.map((x, j) => (
          <button
            key={x.platform}
            type="button"
            role="tab"
            aria-selected={i === j}
            onClick={() => setI(j)}
            className={cn("flex h-7 items-center gap-1.5 rounded-sm px-2 text-caption transition-colors", i === j ? "bg-surface-3 text-fg" : "text-fg-3 hover:text-fg-2")}
          >
            <PlatformGlyph platform={x.platform} size={13} />
            {platformLabel(x.platform)}
          </button>
        ))}
      </div>
      <div className="mt-2 rounded-md bg-surface-2 px-3.5 py-3 font-mono text-[12.5px] leading-5 text-fg-2">
        <p className="whitespace-pre-wrap text-fg">
          {keyword
            ? c.text.split(new RegExp(`(${keyword})`, "i")).map((part, k) => (part.toUpperCase() === keyword.toUpperCase() ? <span key={k} className="text-on-tint">{part}</span> : part))
            : c.text}
        </p>
        {c.hashtags.length ? <p className="mt-2 text-fg-3">{c.hashtags.join(" ")}</p> : null}
      </div>
    </div>
  );
}
