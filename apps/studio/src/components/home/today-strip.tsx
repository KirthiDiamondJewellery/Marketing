// Unfinished feature: Home's loop strip (Film, Upload, Editing, Review, Scheduled at a glance). Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
import Link from "next/link";
import { ArrowRight, Camera, CalendarCheck, CircleCheck, Scissors, Upload } from "lucide-react";
import type { TodayStrip as Strip } from "@/server/queries/production";
import { cn } from "@/components/ui";

/**
 * The whole loop at a glance: Film → Upload → Editing → Review → Scheduled. Each step links to where it's done; the
 * step that needs the owner is marked with the Attention Signal.
 */
export function TodayStrip({ strip, tz }: { strip: Strip; tz: string }) {
  const next = strip.nextPost
    ? new Date(strip.nextPost).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz })
    : null;
  const steps = [
    { key: "film", label: "Film", n: strip.film, hint: strip.film ? `${strip.film === 1 ? "script" : "scripts"} ready` : "nothing to film", href: "/film", Icon: Camera, you: strip.film > 0 },
    { key: "upload", label: "Upload", n: strip.upload, hint: strip.upload ? "takes need a script" : "none waiting", href: "/film#takes", Icon: Upload, you: strip.upload > 0 },
    { key: "editing", label: "Editing", n: strip.editing, hint: strip.editing ? "in the edit" : "queue is clear", href: "/edits", Icon: Scissors, you: false },
    { key: "review", label: "Review", n: strip.review, hint: strip.review ? `${strip.review === 1 ? "video" : "videos"} for you` : "nothing waiting", href: "/approvals", Icon: CircleCheck, you: strip.review > 0 },
    { key: "scheduled", label: "Scheduled", n: strip.scheduled, hint: next ? `next ${next}` : "no posts queued", href: "/calendar", Icon: CalendarCheck, you: false },
  ];
  return (
    <nav aria-label="Today's loop" className="mb-10">
      <ol className="grid grid-cols-2 gap-2 @2xl:grid-cols-5 @2xl:gap-0 @2xl:rounded-lg @2xl:border @2xl:border-border @2xl:bg-surface-1">
        {steps.map((s, i) => (
          <li key={s.key} className={cn("relative min-w-0", i === 4 && "col-span-2 @2xl:col-span-1")}>
            <Link
              href={s.href}
              data-step={s.key}
              className={cn(
                "group flex h-full flex-col gap-2 rounded-lg border border-border bg-surface-1 px-4 py-3.5 transition-colors hover:bg-surface-2 @2xl:rounded-none @2xl:border-0 @2xl:bg-transparent",
                i === 0 && "@2xl:rounded-l-lg",
                i === 4 && "@2xl:rounded-r-lg",
              )}
            >
              <span className="flex items-center gap-2 text-small text-fg-2">
                <s.Icon className={cn("size-4", s.you ? "text-brand-fg" : "text-fg-3")} strokeWidth={1.75} />
                {s.label}
                {i < 4 ? <ArrowRight className="ml-auto hidden size-3.5 text-fg-3 transition-transform group-hover:translate-x-0.5 @2xl:block" strokeWidth={1.75} /> : null}
              </span>
              <span className="flex items-baseline gap-2">
                <span className={cn("text-[26px] font-medium leading-8 tracking-[-0.01em] tabular", s.n ? "text-fg" : "text-fg-3")}>{s.n}</span>
                <span className="min-w-0 truncate text-caption text-fg-3">{s.hint}</span>
              </span>
            </Link>
            {s.you ? <span aria-hidden className="absolute bottom-3 left-0 top-3 w-[2px] bg-brand @2xl:bottom-auto @2xl:left-4 @2xl:right-4 @2xl:top-0 @2xl:h-[2px] @2xl:w-auto" /> : null}
            {i > 0 ? <span aria-hidden className="absolute bottom-3 left-0 top-3 hidden w-px bg-border @2xl:block" /> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
