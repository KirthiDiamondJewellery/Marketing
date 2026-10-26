import Link from "next/link";
import { ArrowUpRight, Heart, MessageCircle, Play } from "lucide-react";
import { Badge, Card, cn } from "@/components/ui";
import { Sparkline } from "@/components/charts";
import { PlatformIcon, ThumbPlaceholder, StatusDot, type StatusTone } from "@/components/content/shared";
import { fmtCompact, fmtDate, fmtDuration, fmtRelative, fmtX, handle, humanize, platformLabel } from "@/components/content/format";
import type { Creator, Outlier, Teardown, Trend } from "@/server/queries/research";
import { RemixButton, RemoveCreator, TierSelect, TrendActions } from "./controls";
import { Markdown, mdTitle } from "./markdown";

// ---------------------------------------------------------------------------------------------------------------
// Outliers
// ---------------------------------------------------------------------------------------------------------------

export function XBadge({ x, className, strong = false }: { x: number; className?: string; strong?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center rounded-sm px-2 text-[14px] font-medium tabular",
        strong ? "bg-brand-tint text-on-tint" : "bg-surface-3 text-fg",
        className,
      )}
      title={`${fmtX(x)} their usual`}
    >
      {fmtX(x)}
    </span>
  );
}

export function OutlierCard({ o, now, top = false }: { o: Outlier; now: Date; top?: boolean }) {
  const basis =
    o.xMethod === "views" || o.platform === "tiktok"
      ? o.baselineViews
        ? `${fmtCompact(o.views)} views vs their usual ${fmtCompact(o.baselineViews)}`
        : null
      : o.baselineComments
        ? `${fmtCompact(o.comments)} comments vs their usual ${fmtCompact(o.baselineComments)}`
        : null;
  return (
    <article className="flex flex-col rounded-lg border border-border bg-surface-1 p-5 transition-colors duration-[120ms] hover:border-border-strong">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-small">
          <PlatformIcon platform={o.platform} />
          <span className="truncate font-medium text-fg">{handle(o.author)}</span>
          {o.tier ? <span className="shrink-0 text-fg-3">{humanize(o.tier)}</span> : null}
        </div>
        <XBadge x={o.xScore} strong={top} />
      </header>

      <div className="mt-4 flex gap-4">
        <a href={o.url} target="_blank" rel="noreferrer" className="group relative w-[72px] shrink-0 self-start" aria-label={`Open the post by ${handle(o.author)}`}>
          {o.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.thumbnailUrl} alt="" className="aspect-[9/16] w-full rounded-md object-cover" />
          ) : (
            <ThumbPlaceholder className="aspect-[9/16] w-full rounded-md" />
          )}
          <span className="absolute inset-x-0 bottom-1.5 flex items-center justify-center gap-1 text-[11px] font-medium text-fg tabular">
            <Play className="size-3 fill-current" />
            {fmtDuration(o.durationS)}
          </span>
        </a>
        <div className="min-w-0 flex-1">
          <p className="text-caption text-fg-3">Spoken hook</p>
          <blockquote className="mt-1 line-clamp-4 text-[15px] leading-6 text-fg">{o.spokenHook ? `“${o.spokenHook}”` : (o.caption ?? "No transcript yet")}</blockquote>
          {o.format ? <p className="mt-2 text-caption text-fg-3">{humanize(o.format)}</p> : null}
        </div>
      </div>

      {o.topComment ? (
        <div className="mt-4 rounded-md bg-surface-2 px-3.5 py-3">
          <div className="flex items-center justify-between text-caption text-fg-3">
            <span>Top comment</span>
            <span className="inline-flex items-center gap-1 tabular">
              <Heart className="size-3" />
              {fmtCompact(o.topComment.likes)}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-small text-fg-2">{o.topComment.text}</p>
        </div>
      ) : null}

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

// ---------------------------------------------------------------------------------------------------------------
// Trend radar
// ---------------------------------------------------------------------------------------------------------------

const TREND_STATUS: Record<string, { tone: StatusTone; label: string }> = {
  new: { tone: "info", label: "New" },
  shortlisted: { tone: "warning", label: "Shortlisted" },
  kit: { tone: "brand", label: "Kit ready" },
  used: { tone: "success", label: "Made into a post" },
  dismissed: { tone: "neutral", label: "Dismissed" },
  expired: { tone: "neutral", label: "Expired" },
};

function sourceLabel(id: string): string {
  if (id.startsWith("reddit")) return "Forum";
  if (id.startsWith("news")) return "News";
  if (id.startsWith("hn")) return "Hacker News";
  if (id.startsWith("x")) return "X";
  return humanize(id);
}

function HeatMeter({ heat }: { heat: number | null }) {
  const v = Math.round((heat ?? 0) * 100);
  return (
    <div className="flex w-14 shrink-0 flex-col items-start gap-1.5" title={`Heat ${v} of 100`}>
      <span className="text-h3 font-medium tabular text-fg">{v}</span>
      <span className="relative h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${v}%`, background: v >= 80 ? "var(--brand)" : "var(--text-secondary)" }} />
      </span>
    </div>
  );
}

export function TrendRow({ t, tz, now }: { t: Trend; tz: string; now: Date }) {
  const st = TREND_STATUS[t.status] ?? { tone: "neutral" as const, label: humanize(t.status) };
  const quiet = t.status === "dismissed" || t.status === "expired";
  return (
    <li className={cn("border-b border-border py-5 last:border-b-0", quiet && "opacity-70")}>
      <div className="flex gap-4 sm:gap-6">
        <HeatMeter heat={t.heat} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <a href={t.url} target="_blank" rel="noreferrer" className="group inline text-[15px] font-medium leading-6 text-fg hover:underline hover:decoration-border-strong hover:underline-offset-4">
                {t.title}
                <ArrowUpRight className="ml-1 inline size-3.5 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </a>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-3">
                <StatusDot tone={st.tone} label={st.label} />
                <span>{sourceLabel(t.source)}</span>
                <span>Seen {fmtRelative(t.firstSeenAt, now)}</span>
                {t.comments ? (
                  <span className="inline-flex items-center gap-1 tabular">
                    <MessageCircle className="size-3" />
                    {fmtCompact(t.comments)}
                  </span>
                ) : null}
                {t.coverage > 1 ? <span>{t.coverage} sources</span> : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <div className="flex items-center gap-2" title={t.velocity != null ? `Velocity ${t.velocity.toFixed(1)} per hour` : undefined}>
                <Sparkline values={t.history} tone={t.status === "kit" || (t.heat ?? 0) >= 0.8 ? "brand" : "secondary"} label={`Engagement over time for ${t.title}`} />
                <span className="w-16 text-right text-caption tabular text-fg-2">{t.velocity != null ? `${t.velocity.toFixed(1)}/hr` : "–"}</span>
              </div>
              <TrendActions id={t.id} status={t.status} />
            </div>
          </div>

          {t.content ? (
            <p className="mt-3 text-small text-fg-2">
              Made into{" "}
              <Link href={`/content/${t.content.id}`} className="text-fg underline decoration-border-strong underline-offset-4 hover:decoration-fg">
                {t.content.title}
              </Link>{" "}
              <span className="text-fg-3">· {humanize(t.content.status)}</span>
            </p>
          ) : null}

          {t.kit ? <TrendKitPanel t={t} tz={tz} /> : null}
        </div>
      </div>
    </li>
  );
}

function TrendKitPanel({ t, tz }: { t: Trend; tz: string }) {
  const kit = t.kit!;
  return (
    <div className="mt-4 rounded-lg bg-surface-2 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-caption text-fg-3">Filmable kit</p>
          <h4 className="mt-0.5 text-h3 font-medium text-fg">{kit.header ?? t.title}</h4>
        </div>
        <div className="flex items-center gap-2">
          {t.filmBy ? <span className="text-caption text-fg-2">Film by {fmtDate(t.filmBy, tz, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span> : null}
          {kit.keyword ? <Badge tone="brand" className="font-mono tracking-wide">{kit.keyword}</Badge> : null}
        </div>
      </div>
      {kit.beats?.length ? (
        <ol className="mt-4 grid gap-3 md:grid-cols-2">
          {kit.beats.map((b, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-medium tabular text-fg-2">{i + 1}</span>
              <div className="min-w-0">
                <p className="text-small text-fg">{b.text}</p>
                {b.visual ? <p className="mt-0.5 text-caption text-fg-3">On screen: {b.visual}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {kit.caption ? (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-caption text-fg-3">Caption</p>
          <p className="mt-1 max-w-[72ch] font-mono text-[12.5px] leading-5 text-fg-2">{kit.caption}</p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Tracked creators
// ---------------------------------------------------------------------------------------------------------------

export function CreatorsTable({ creators, now }: { creators: Creator[]; now: Date }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="hidden grid-cols-[minmax(0,2.4fr)_1fr_1.3fr_1.3fr_1fr_88px] gap-4 border-b border-border px-5 py-3 text-caption text-fg-3 lg:grid">
        <span>Creator</span>
        <span>Tier</span>
        <span>Their usual</span>
        <span>Last 30 days</span>
        <span>Last scanned</span>
        <span className="sr-only">Actions</span>
      </div>
      <ul>
        {creators.map((c) => (
          <li
            key={c.id}
            className={cn(
              "grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 border-b border-border px-5 py-4 last:border-b-0 lg:grid-cols-[minmax(0,2.4fr)_1fr_1.3fr_1.3fr_1fr_88px] lg:items-center",
              !c.active && "opacity-60",
            )}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <PlatformIcon platform={c.platform} />
                <span className="truncate text-[14px] font-medium text-fg">{handle(c.handle)}</span>
                {!c.active ? <Badge>Not tracked</Badge> : null}
              </div>
              {c.notes ? <p className="mt-0.5 truncate text-caption text-fg-3">{c.notes}</p> : null}
            </div>
            <div className="flex items-center justify-end gap-1 lg:justify-start">
              <TierSelect handle={c.handle} platform={c.platform} tier={c.tier} disabled={!c.active} />
            </div>
            <div className="col-span-2 text-small tabular lg:col-span-1">
              <span className="text-caption text-fg-3 lg:hidden">Their usual · </span>
              {c.baselineViews != null ? (
                <span className="lg:block">
                  <span className="text-fg">{fmtCompact(c.baselineViews)} views</span>
                  <span className="text-fg-3 lg:block"><span className="lg:hidden"> · </span>{fmtCompact(c.baselineComments)} comments</span>
                </span>
              ) : (
                <span className="text-fg-3">After the first scan</span>
              )}
            </div>
            <div className="col-span-2 text-small tabular lg:col-span-1">
              <span className="text-caption text-fg-3 lg:hidden">Last 30 days · </span>
              <span className="lg:block">
                <span className="text-fg">{c.posts30d} posts</span>
                <span className="text-fg-3 lg:block">
                  <span className="lg:hidden"> · </span>
                  {c.outliers30d ? `${c.outliers30d} outlier${c.outliers30d === 1 ? "" : "s"}${c.bestX ? `, best ${fmtX(c.bestX)}` : ""}` : "No outliers"}
                </span>
              </span>
            </div>
            <div className="self-center text-small text-fg-3">
              <span className="text-caption lg:hidden">Scanned </span>
              {c.lastScannedAt ? fmtRelative(c.lastScannedAt, now) : "Not yet"}
            </div>
            <div className="flex justify-end">
              {c.active ? <RemoveCreator handle={c.handle} platform={c.platform} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Teardowns
// ---------------------------------------------------------------------------------------------------------------

const FINGERPRINT_LABEL: Record<string, string> = {
  hook_pattern: "Hook",
  format: "Format",
  wps: "Words per second",
  cuts_per_10s: "Cuts per 10s",
};

export function TeardownCard({ t, tz }: { t: Teardown; tz: string }) {
  const title = mdTitle(t.analysisMd) ?? t.caption ?? "Teardown";
  const fp = Object.entries(t.fingerprint ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  return (
    <Card className="flex flex-col gap-5 lg:flex-row lg:gap-10">
      <div className="lg:w-64 lg:shrink-0">
        <div className="flex items-center gap-2 text-small text-fg-2">
          {t.platform ? <PlatformIcon platform={t.platform} /> : null}
          <span className="font-medium text-fg">{handle(t.author)}</span>
          {t.xScore ? <XBadge x={t.xScore} className="ml-auto lg:ml-0" /> : null}
        </div>
        <h3 className="mt-3 text-h3 font-medium text-fg">{title}</h3>
        <p className="mt-1 text-caption text-fg-3">
          {t.platform ? `${platformLabel(t.platform)} · ` : ""}Broken down {fmtDate(t.createdAt, tz, { month: "short", day: "numeric" })}
        </p>
        {fp.length ? (
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-1">
            {fp.map(([k, v]) => (
              <div key={k}>
                <dt className="text-caption text-fg-3">{FINGERPRINT_LABEL[k] ?? humanize(k)}</dt>
                <dd className="text-small text-fg tabular">{typeof v === "string" ? humanize(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <a href={t.url} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-1 text-small text-fg-2 hover:text-fg">
          Open the original
          <ArrowUpRight className="size-3.5" />
        </a>
      </div>
      <div className="min-w-0 flex-1 border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
        <Markdown source={t.analysisMd} skipFirstHeading />
      </div>
    </Card>
  );
}
