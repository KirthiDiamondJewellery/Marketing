import { Play } from "lucide-react";
import { fmtCompact, fmtDuration, fmtRelative, fmtX, handle } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import type { Outlier } from "@/server/queries/research";
import { Cover } from "./cover";
import { RemixButton } from "./remix-button";

/** A competitor's post that ran far above their own normal, with the one action that matters: remix it. */
export function OutlierCard({ o, now }: { o: Outlier; now: Date }) {
  const basis = o.baselineViews && o.views !== null
    ? `${fmtCompact(o.views)} views vs their usual ${fmtCompact(o.baselineViews)}`
    : o.baselineComments && o.comments !== null
      ? `${fmtCompact(o.comments)} comments vs their usual ${fmtCompact(o.baselineComments)}`
      : o.views !== null
        ? `${fmtCompact(o.views)} views`
        : null;
  return (
    <article className="flex flex-col rounded-lg border border-border bg-surface-1 p-4 transition-colors duration-[120ms] hover:border-border-strong">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-small">
          <PlatformIcon platform={o.platform} />
          <span className="truncate font-medium text-fg">{handle(o.author)}</span>
        </div>
        <span className="inline-flex h-7 shrink-0 items-center rounded-sm bg-brand-tint px-2 text-[14px] font-medium tabular text-on-tint" title={`${fmtX(o.xScore)} their normal`}>
          {fmtX(o.xScore)}
        </span>
      </header>
      <div className="mt-3 flex gap-3">
        <a href={o.url} target="_blank" rel="noreferrer" className="relative w-16 shrink-0 self-start" aria-label={`Open the post by ${handle(o.author)}`}>
          <Cover src={o.thumbnailUrl} platform={o.platform} aspect="tall" />
          {o.durationS ? (
            <span className="absolute inset-x-0 bottom-1 flex items-center justify-center gap-1 text-[11px] font-medium tabular text-fg">
              <Play className="size-3 fill-current" aria-hidden />
              {fmtDuration(o.durationS)}
            </span>
          ) : null}
        </a>
        <blockquote className="line-clamp-5 min-w-0 flex-1 text-small text-fg">{o.spokenHook ? `“${o.spokenHook}”` : (o.caption ?? "No words captured for this one yet")}</blockquote>
      </div>
      <footer className="mt-auto flex items-end justify-between gap-3 pt-4">
        <div className="min-w-0 text-caption text-fg-3">
          {basis ? <p className="text-fg-2">{basis}</p> : null}
          <p className="mt-0.5">Posted {fmtRelative(o.publishedAt, now)}</p>
        </div>
        <RemixButton id={o.id} remixedAs={o.remixedAs} />
      </footer>
    </article>
  );
}
