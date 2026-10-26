import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { workspace } from "@/server/workspace";
import { calendarPosts, postPlatforms, readyVideos, scheduledCount } from "@/server/queries/calendar";
import { buttonClass, cn } from "@/components/ui";
import { PageHeader, SectionTitle } from "@/components/shell/page-header";
import { CalendarView } from "@/components/calendar/calendar-view";
import { ReadyList } from "@/components/calendar/ready-list";
import { trialReelsReady } from "@/server/queries/trial-reels";
import { Toaster } from "@/components/content/toast";
import { TrialReelsProvider } from "@/components/trial-reels/trial-reels";
import { PlatformGlyph } from "@/motion/PlatformGlyph";
import { addDays, dayKey, fmtDate, parseDayKey, platformLabel, startOfWeek, zonedToUtc } from "@/components/content/format";

export const metadata: Metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

type Search = { view?: string; date?: string; platform?: string };

const PLATFORM_ORDER = ["instagram", "tiktok", "youtube", "linkedin", "x", "threads", "facebook"];

/** Calendar: what's going out (filter by platform), and below it the videos that are ready to post. */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const ws = workspace();
  const tz = ws.config.workspace.timezone;
  const view = sp.view === "month" ? "month" : "week";
  const now = new Date();
  const todayKey = dayKey(now, tz);
  const anchor = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayKey;
  const platform = sp.platform && /^[a-z]{1,20}$/.test(sp.platform) ? sp.platform : null;

  let days: string[];
  let monthKey: string | null = null;
  let prev: string;
  let next: string;
  let rangeLabel: string;
  if (view === "week") {
    // With no date picked, the week rolls around today (two days back, four ahead). Picking a date shows Mon to Sun.
    const start = sp.date ? startOfWeek(anchor) : addDays(todayKey, -2);
    days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    prev = addDays(start, -7);
    next = addDays(start, 7);
    const end = days[6]!;
    const sameMonth = start.slice(0, 7) === end.slice(0, 7);
    rangeLabel = `${fmtDate(`${start}T12:00:00Z`, "UTC", { month: "short", day: "numeric" })} to ${fmtDate(`${end}T12:00:00Z`, "UTC", sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" })}`;
  } else {
    const { y, m } = parseDayKey(anchor);
    monthKey = `${y}-${String(m).padStart(2, "0")}-01`;
    const gridStart = startOfWeek(monthKey);
    days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
    if (days[35]!.slice(0, 7) !== monthKey.slice(0, 7)) days = days.slice(0, 35);
    prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
    next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    rangeLabel = fmtDate(`${monthKey}T12:00:00Z`, "UTC", { month: "long", year: "numeric" });
  }
  const utc = (key: string) => {
    const p = parseDayKey(key);
    return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
  };
  const weekStart = startOfWeek(todayKey);

  const [all, platformsWithPosts, ready, thisWeek] = await Promise.all([
    calendarPosts(utc(days[0]!), utc(addDays(days[days.length - 1]!, 1))),
    postPlatforms(),
    readyVideos(),
    scheduledCount(utc(weekStart), utc(addDays(weekStart, 7))),
  ]);
  const posts = platform ? all.filter((p) => p.platform === platform) : all;
  const chips = [...new Set([...platformsWithPosts, ...(platform ? [platform] : [])])].sort((a, b) => rank(a) - rank(b));

  const href = (o: { view?: string; date?: string | null; platform?: string | null }) => {
    const q = new URLSearchParams();
    const v = o.view ?? view;
    if (v !== "week") q.set("view", v);
    const d = o.date === undefined ? (sp.date ? anchor : undefined) : o.date;
    if (d) q.set("date", d);
    const pf = o.platform === undefined ? platform : o.platform;
    if (pf) q.set("platform", pf);
    const s = q.toString();
    return `/calendar${s ? `?${s}` : ""}`;
  };
  const showingToday = days.includes(todayKey) && !(view === "week" && sp.date);
  const where = platform ? ` on ${platformLabel(platform)}` : "";
  const emptyText = `Nothing scheduled${where} ${view === "week" ? "this week" : "this month"}. Schedule a video from Ready to post below.`;

  return (
    <TrialReelsProvider>
    <div>
      <PageHeader
        title="Calendar"
        description={`${thisWeek} scheduled this week · ${ready.length} ready to post`}
        actions={
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Calendar view">
            {(["week", "month"] as const).map((v) => (
              <Link
                key={v}
                href={href({ view: v, date: null })}
                aria-current={view === v ? "page" : undefined}
                className={cn("rounded-[8px] px-3 py-1 text-[13px] transition-colors", view === v ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg")}
              >
                {v === "week" ? "Week" : "Month"}
              </Link>
            ))}
          </div>
        }
      />

      <section aria-labelledby="scheduled" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex items-center gap-2">
            <Link href={href({ date: prev })} className={buttonClass("secondary", "sm", "w-8 px-0")} aria-label={view === "week" ? "Previous week" : "Previous month"}>
              <ChevronLeft className="size-4" />
            </Link>
            <Link href={href({ date: next })} className={buttonClass("secondary", "sm", "w-8 px-0")} aria-label={view === "week" ? "Next week" : "Next month"}>
              <ChevronRight className="size-4" />
            </Link>
            <h2 id="scheduled" className="ml-1 text-h3 font-medium tabular text-fg">
              {rangeLabel}
            </h2>
            {!showingToday ? (
              <Link href={href({ date: null })} className={buttonClass("ghost", "sm")}>
                Today
              </Link>
            ) : null}
          </div>
          {chips.length > 1 || platform ? (
            <nav className="-mx-1 flex max-w-full flex-wrap items-center gap-1 sm:ml-auto" aria-label="Filter by platform">
              <Chip href={href({ platform: null })} active={!platform}>
                All
              </Chip>
              {chips.map((p) => (
                <Chip key={p} href={href({ platform: platform === p ? null : p })} active={platform === p}>
                  <PlatformGlyph platform={p} size={14} />
                  {platformLabel(p)}
                </Chip>
              ))}
            </nav>
          ) : null}
        </div>
        <CalendarView view={view} days={days} monthKey={monthKey} todayKey={todayKey} nowIso={now.toISOString()} tz={tz} posts={posts} emptyText={emptyText} />
      </section>

      <section aria-labelledby="ready" className="mt-14 pb-24">
        <SectionTitle id="ready" count={ready.length}>
          Ready to post
        </SectionTitle>
        <ReadyList videos={ready} platforms={ws.config.platforms} tz={tz} trialOn={await trialReelsReady().catch(() => false)} />
      </section>
      <Toaster />
    </div>
    </TrialReelsProvider>
  );
}

function rank(p: string): number {
  const i = PLATFORM_ORDER.indexOf(p);
  return i === -1 ? 99 : i;
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      replace
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] transition-colors duration-[120ms]",
        active ? "border-border-strong bg-surface-3 text-fg" : "border-transparent text-fg-2 hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}
