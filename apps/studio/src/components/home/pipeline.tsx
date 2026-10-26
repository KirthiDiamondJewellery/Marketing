import Link from "next/link";
import { ArrowRight, CalendarCheck2, Clapperboard, FileCheck2, FilePen, Scissors, Send } from "lucide-react";
import type { Pipeline } from "@/server/queries/pipeline";
import { cn } from "@/components/ui";
import { PlatformGlyph } from "@/motion";
import { dayTime, platformLabel } from "@/components/shell/format";

type Tile = { href: string; label: string; value: number; sub: string; Icon: typeof Send; hot?: boolean };

/** Six tiles, in the order work moves: scripts, filming, editing, review, ready, scheduled. Each one opens its page. */
export function PipelineTiles({ p }: { p: Pipeline }) {
  const tiles: Tile[] = [
    {
      href: "/scripts",
      label: "Scripts need your OK",
      value: p.scripts.needsOk,
      sub: p.scripts.writing ? `${p.scripts.writing} being written` : "Approve or ask for changes",
      Icon: FilePen,
      hot: p.scripts.needsOk > 0,
    },
    { href: "/scripts", label: "Ready to film", value: p.scripts.readyToFilm, sub: p.scripts.filmed ? `${p.scripts.filmed} filmed, waiting for footage` : "Scripts with a teleprompter", Icon: Clapperboard },
    { href: "/edit", label: "Being edited", value: p.videos.editing, sub: "Cuts, captions and checks", Icon: Scissors },
    { href: "/edit", label: "Videos to review", value: p.videos.needsReview, sub: "Say if it's good or what to change", Icon: FileCheck2, hot: p.videos.needsReview > 0 },
    { href: "/calendar#ready", label: "Ready to post", value: p.videos.readyToPost, sub: "Approved, not scheduled yet", Icon: Send },
    {
      href: "/calendar",
      label: "Scheduled this week",
      value: p.posts.scheduledWeek,
      sub: p.posts.postedWeek ? `${p.posts.postedWeek} posted in the last 7 days` : "Going out in the next 7 days",
      Icon: CalendarCheck2,
    },
  ];
  return (
    <ul className="grid grid-cols-2 gap-3 @3xl:grid-cols-3">
      {tiles.map((t) => (
        <li key={t.label}>
          <Link
            href={t.href}
            className={cn(
              "group flex h-full flex-col justify-between gap-4 rounded-lg border bg-surface-1 p-4 transition-colors duration-150 hover:bg-surface-2 @3xl:p-5",
              t.hot ? "border-brand/50" : "border-border hover:border-border-strong",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={cn("text-small", t.hot ? "text-fg" : "text-fg-2")}>{t.label}</span>
              <t.Icon className={cn("size-4 shrink-0", t.hot ? "text-brand-fg" : "text-fg-3")} strokeWidth={1.5} aria-hidden />
            </div>
            <div>
              <div className="text-[32px] font-medium leading-none tracking-[-0.02em] text-fg tabular">{t.value}</div>
              <div className="mt-2 flex items-center gap-1 text-caption text-fg-3">
                <span className="truncate">{t.sub}</span>
                <ArrowRight className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={1.5} aria-hidden />
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const STATUS: Record<string, string> = { assist: "You post it", publishing: "Posting now", queued: "Scheduled", scheduled: "Scheduled" };

/** The next few posts going out. */
export function NextUp({ items, tz }: { items: Pipeline["next"]; tz: string }) {
  if (!items.length) {
    return (
      <div className="rounded-lg border border-border bg-surface-1 px-5 py-6 text-small text-fg-2">
        Nothing scheduled yet. Approve a video on <Link href="/edit" className="text-fg underline-offset-4 hover:underline">Edit</Link> and choose Schedule.
      </div>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
      {items.map((p) => (
        <li key={p.id}>
          <Link href="/calendar" className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
            <PlatformGlyph platform={p.platform} size={16} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] text-fg">{p.title ?? "Untitled post"}</div>
              <div className="text-caption text-fg-3">
                {platformLabel(p.platform)} · {STATUS[p.status] ?? "Scheduled"}
              </div>
            </div>
            <div className="shrink-0 text-small text-fg-2 tabular">{dayTime(p.at, tz)}</div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
