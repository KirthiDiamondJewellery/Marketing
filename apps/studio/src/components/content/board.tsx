import Link from "next/link";
import { PlatformGlyph } from "@/motion/PlatformGlyph";
import { cn } from "@/components/ui";
import type { PipelineItem } from "@/server/queries/content";
import { LIFECYCLE_LABEL } from "./lifecycle";
import { ThumbPlaceholder } from "./shared";
import { fmtCompact, fmtDateTime, fmtRelative, fmtX, humanize } from "./format";

const STAGES = ["idea", "scripted", "filming", "editing", "review", "scheduled", "published", "measured"] as const;

const STAGE_HINT: Record<string, string> = {
  idea: "Waiting for a script",
  scripted: "Ready to film",
  filming: "On your shot list",
  editing: "With the Art Director",
  review: "Needs your sign-off",
  scheduled: "Queued to go out",
  published: "Collecting numbers",
  measured: "Lessons learned",
};

/** The lifecycle rail: every stage with its count, the stages that need you marked with the Signal. */
export function LifecycleRail({ items }: { items: PipelineItem[] }) {
  return (
    <nav aria-label="Pipeline stages" className="-mx-4 mb-8 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ol className="grid min-w-[720px] grid-cols-8 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {STAGES.map((s) => {
          const list = items.filter((i) => i.status === s);
          const needs = list.some((i) => i.needsYou > 0) || (s === "filming" && list.length > 0);
          return (
            <li key={s} className="relative bg-surface-1">
              {needs ? <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-brand" /> : null}
              <a href={`#stage-${s}`} className="flex flex-col gap-0.5 px-3 py-3 transition-colors hover:bg-surface-2">
                <span className="text-caption text-fg-2">{LIFECYCLE_LABEL[s]}</span>
                <span className={cn("text-h2 font-medium tabular", list.length ? "text-fg" : "text-fg-3")}>{list.length}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function Board({ items, tz }: { items: PipelineItem[]; tz: string }) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
        {STAGES.map((s) => {
          const list = items.filter((i) => i.status === s);
          return (
            <section key={s} id={`stage-${s}`} aria-label={LIFECYCLE_LABEL[s]} className="flex min-w-0 scroll-mt-24 flex-col gap-3">
              <header className="flex items-baseline gap-2 px-1">
                <h2 className="text-h3 font-medium text-fg">{LIFECYCLE_LABEL[s]}</h2>
                <span className="text-small tabular text-fg-3">{list.length}</span>
              </header>
              <p className="-mt-2 px-1 text-caption text-fg-3">{STAGE_HINT[s]}</p>
              {list.length ? (
                list.map((item) => <BoardCard key={item.id} item={item} tz={tz} />)
              ) : (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-caption text-fg-3">Nothing here</div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function BoardCard({ item, tz }: { item: PipelineItem; tz: string }) {
  const now = new Date();
  const soon = item.filmBy && new Date(item.filmBy).getTime() - now.getTime() < 36 * 3600_000;
  let line: React.ReactNode = null;
  switch (item.status) {
    case "idea":
      line = <span>{item.createdBy.startsWith("user:") ? "Your idea" : `Suggested ${fmtRelative(item.updatedAt, now)}`}</span>;
      break;
    case "scripted":
      line = <span>{item.scriptVersion ? `Script v${item.scriptVersion} ready to film` : "Script ready"}</span>;
      break;
    case "filming":
      line = item.filmBy ? <span className={soon ? "text-warning" : undefined}>Film by {fmtDateTime(item.filmBy, tz)}</span> : <span>On your shot list</span>;
      break;
    case "editing":
    case "review":
      line = item.editRef ? (
        <span>
          <span className="tabular">{item.editRef}</span> · {item.status === "review" ? "ready for your review" : humanize(item.editStatus ?? "editing").toLowerCase()}
        </span>
      ) : (
        <span>Waiting for footage</span>
      );
      break;
    case "scheduled":
      line = item.nextPostAt ? <span>Goes out {fmtDateTime(item.nextPostAt, tz)}</span> : <span>Waiting for a slot</span>;
      break;
    case "published":
    case "measured":
      line = (
        <span className="tabular">
          {item.views !== null ? `${fmtCompact(item.views)} views` : "No numbers yet"}
          {item.bestX !== null ? (
            <>
              {" · "}
              <span className={item.bestX >= 2 ? "text-brand-fg" : item.bestX < 0.6 ? "text-danger" : undefined}>{fmtX(item.bestX)}</span>
            </>
          ) : null}
        </span>
      );
      break;
  }
  return (
    <Link
      href={`/content/${item.id}`}
      className={cn(
        "group relative flex gap-3 rounded-lg border border-border bg-surface-1 p-3 transition-colors duration-[120ms] hover:border-border-strong hover:bg-surface-2",
        item.needsYou > 0 && "signal-left rounded-l-none",
      )}
    >
      <span className="h-[64px] w-[36px] shrink-0 overflow-hidden rounded-sm">
        {item.thumbId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/media/${item.thumbId}`} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <ThumbPlaceholder className="size-full" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-small font-medium text-fg">{item.title}</span>
        <span className="truncate text-caption text-fg-3">
          {[item.lane ? humanize(item.lane) : null, item.kind !== "reel" ? humanize(item.kind) : null].filter(Boolean).join(" · ") || "No lane yet"}
        </span>
        <span className="mt-auto flex items-center gap-2 text-caption text-fg-2">
          <span className="min-w-0 truncate">{line}</span>
          {item.platforms.length && ["scheduled", "published", "measured"].includes(item.status) ? (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-fg-3">
              {item.platforms.slice(0, 4).map((p) => (
                <PlatformGlyph key={p} platform={p} size={12} />
              ))}
            </span>
          ) : null}
        </span>
        {item.needsYou > 0 ? <span className="text-caption text-on-tint">Needs you</span> : null}
      </span>
    </Link>
  );
}
