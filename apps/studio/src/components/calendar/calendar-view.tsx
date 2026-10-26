"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLive } from "@/lib/use-live";
import { cn } from "@/components/ui";
import type { CalendarPost } from "@/server/queries/calendar";
import { reschedulePosts } from "@/server/actions/content";
import { PlatformGlyph } from "@/motion/PlatformGlyph";
import { StatusDot, ThumbPlaceholder } from "@/components/content/shared";
import { toast } from "@/components/content/toast";
import { fmtDate, fmtTime, parseDayKey, platformLabel, zonedParts, zonedToUtc } from "@/components/content/format";
import { assignLanes, groupPosts, statusWords, type PostGroup } from "./group";
import { PostDrawer } from "./post-drawer";

const HOUR = 60;
const TILE_H = 112;
const TILE_MIN = Math.ceil((TILE_H / HOUR) * 60);
const SNAP_MIN = 15;

type Props = {
  view: "week" | "month";
  days: string[];
  monthKey: string | null;
  todayKey: string;
  nowIso: string;
  tz: string;
  posts: CalendarPost[];
  /** Shown when the range has no posts (mentions the platform filter when one is on). */
  emptyText: string;
};

/** Reads the live stream when the OS shell provides it; the calendar still works without it. */
function useOptionalLive() {
  try {
    return useLive();
  } catch {
    return null;
  }
}

/** The scheduled posts: a week or month grid on larger screens, a day-by-day list on phones. */
export function CalendarView({ view, days, monthKey, todayKey, nowIso, tz, posts: initial, emptyText }: Props) {
  const router = useRouter();
  const live = useOptionalLive();
  const [posts, setPosts] = useState(initial);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [burst, setBurst] = useState<string[] | null>(null);
  const [now, setNow] = useState(() => new Date(nowIso));

  useEffect(() => setPosts(initial), [initial]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const groups = useMemo(() => groupPosts(posts, tz), [posts, tz]);
  const openGroup = useMemo(() => {
    if (!openKey) return null;
    const contentKey = openKey.split("|")[0];
    return groups.find((g) => g.key === openKey) ?? groups.find((g) => g.key.split("|")[0] === contentKey) ?? null;
  }, [openKey, groups]);

  // A post that goes live while you're looking plays the publish burst in its drawer, or a toast.
  const seen = useRef(new Map(initial.map((p) => [p.id, p.status])));
  useEffect(() => {
    const snap = live?.snapshot;
    if (!snap) return;
    const flipped = snap.posts.filter((p) => p.status === "published" && seen.current.has(p.id) && seen.current.get(p.id) !== "published");
    for (const p of snap.posts) if (seen.current.has(p.id)) seen.current.set(p.id, p.status);
    if (!flipped.length) return;
    setPosts((prev) => prev.map((p) => (flipped.some((f) => f.id === p.id) ? { ...p, status: "published" } : p)));
    const open = openGroup?.posts.map((p) => p.id) ?? [];
    const mine = flipped.filter((f) => open.includes(f.id));
    if (mine.length) setBurst(mine.map((f) => f.platform));
    else toast(`Live on ${flipped.map((f) => platformLabel(f.platform)).join(", ")}`, { by: "Publisher" });
    router.refresh();
  }, [live?.snapshot, openGroup, router]);

  const move = useCallback(
    async (group: PostGroup, at: Date) => {
      const ids = group.posts.filter((p) => ["draft", "queued", "scheduled", "assist"].includes(p.status)).map((p) => p.id);
      if (!ids.length) return;
      const before = posts;
      const iso = at.toISOString();
      setPosts((prev) => prev.map((p) => (ids.includes(p.id) ? { ...p, at: iso } : p)));
      setOpenKey((k) => (k === group.key ? `${group.key.split("|")[0]}|${iso}` : k));
      const res = await reschedulePosts(ids, iso);
      if (res.ok) {
        toast(res.message, { by: "Publisher" });
        router.refresh();
      } else {
        setPosts(before);
        toast(res.message, { tone: "error" });
      }
    },
    [posts, router],
  );

  const inRange = groups.some((g) => days.includes(g.day));

  return (
    <div className="flex flex-col gap-4">
      {view === "week" ? (
        <WeekGrid days={days} todayKey={todayKey} now={now} tz={tz} groups={groups} onOpen={setOpenKey} onMove={move} />
      ) : (
        <MonthGrid days={days} monthKey={monthKey} todayKey={todayKey} tz={tz} groups={groups} onOpen={setOpenKey} onMove={move} />
      )}
      {!inRange ? <p className="hidden text-small text-fg-2 md:block">{emptyText}</p> : null}

      <Agenda days={view === "week" ? days : days.filter((d) => d.slice(0, 7) === monthKey?.slice(0, 7))} todayKey={todayKey} now={now} tz={tz} groups={groups} onOpen={setOpenKey} emptyText={emptyText} />

      <PostDrawer group={openGroup} tz={tz} burst={burst} onBurstDone={() => setTimeout(() => setBurst(null), 2400)} onClose={() => setOpenKey(null)} onReschedule={move} />
    </div>
  );
}

/** First words of what's going out: the content title, else the caption's first line. */
function headline(g: PostGroup): string {
  const text = g.title || g.posts.find((p) => p.caption)?.caption?.split("\n")[0] || "Untitled post";
  return g.trial ? `Trial reel · ${text}` : text;
}

function groupStatus(g: PostGroup): { tone: ReturnType<typeof statusWords>["tone"]; label: string } {
  const failed = g.posts.filter((p) => p.status === "failed").length;
  if (failed && g.status !== "failed") return { tone: "danger", label: `${failed} failed` };
  return statusWords(g.status);
}

function Thumb({ id, className }: { id: string | null; className?: string }) {
  return (
    <span className={cn("block shrink-0 overflow-hidden bg-surface-3", className)}>
      {id ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/media/${id}`} alt="" draggable={false} loading="lazy" className="size-full object-cover" />
      ) : (
        <ThumbPlaceholder className="size-full" />
      )}
    </span>
  );
}

function Glyphs({ posts, size }: { posts: CalendarPost[]; size: number }) {
  return (
    <span className="flex items-center gap-[3px] overflow-hidden text-fg-2">
      {[...new Set(posts.map((p) => p.platform))].slice(0, 5).map((p) => (
        <span key={p} className="shrink-0">
          <PlatformGlyph platform={p} size={size} />
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------------------------------------------

function WeekGrid({
  days,
  todayKey,
  now,
  tz,
  groups,
  onOpen,
  onMove,
}: {
  days: string[];
  todayKey: string;
  now: Date;
  tz: string;
  groups: PostGroup[];
  onOpen: (key: string) => void;
  onMove: (g: PostGroup, at: Date) => Promise<void>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ key: string; day: string; minutes: number } | null>(null);
  const dragging = useRef<PostGroup | null>(null);
  const [moreList, setMoreList] = useState<PostGroup[] | null>(null);

  const nowParts = zonedParts(now, tz);
  const nowMin = nowParts.h * 60 + nowParts.mi;
  const inWeek = days.includes(todayKey);
  const mins = groups.filter((g) => days.includes(g.day)).map((g) => g.minutes);
  const startH = Math.max(0, Math.min(6, ...mins.map((m) => Math.floor(m / 60)), inWeek ? nowParts.h : 24));
  const endH = Math.min(24, Math.max(23, ...mins.map((m) => Math.ceil((m + TILE_MIN) / 60)), inWeek ? nowParts.h + 1 : 0));
  const hours = Array.from({ length: endH - startH }, (_, i) => startH + i);
  const top = (m: number) => ((m - startH * 60) / 60) * HOUR;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = inWeek ? top(nowMin) - el.clientHeight / 2 : top(Math.min(...mins, 9 * 60)) - 24;
    el.scrollTop = Math.max(0, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.join()]);

  const minutesAt = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = startH * 60 + ((e.clientY - rect.top) / HOUR) * 60 - 12;
    return Math.max(startH * 60, Math.min(endH * 60 - SNAP_MIN, Math.round(raw / SNAP_MIN) * SNAP_MIN));
  };

  return (
    <div className="hidden overflow-hidden rounded-lg border border-border bg-surface-1 md:block">
      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-border">
        <div />
        {days.map((d) => {
          const isToday = d === todayKey;
          return (
            <div key={d} className={cn("flex items-baseline gap-2 border-l border-border px-3 py-3", d < todayKey && "opacity-60")}>
              <span className="text-caption text-fg-3">{fmtDate(`${d}T12:00:00Z`, "UTC", { weekday: "short" })}</span>
              <span className={cn("tabular text-h3 font-medium", isToday ? "text-fg" : "text-fg-2")}>{parseDayKey(d).d}</span>
              {isToday ? <span className="ml-auto text-caption text-brand-fg">Today</span> : null}
            </div>
          );
        })}
      </div>
      <div ref={scroller} className="relative max-h-[min(64vh,680px)] overflow-y-auto overscroll-contain">
        <div className="relative grid grid-cols-[56px_repeat(7,minmax(0,1fr))]" style={{ height: hours.length * HOUR }}>
          <div className="relative">
            {hours.map((h, i) =>
              i === 0 || (inWeek && Math.abs(h * 60 - nowMin) < 22) ? null : (
                <span key={h} className="absolute right-2 -translate-y-1/2 text-caption tabular text-fg-3" style={{ top: i * HOUR }}>
                  {h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`}
                </span>
              ),
            )}
            {inWeek && nowMin >= startH * 60 ? (
              <span className="absolute right-1.5 z-20 -translate-y-1/2 rounded-sm bg-surface-1 px-1 text-caption font-medium tabular text-brand-fg" style={{ top: top(nowMin) }}>
                {fmtTime(now, tz)}
              </span>
            ) : null}
          </div>
          {days.map((d) => {
            const isToday = d === todayKey;
            const dayGroups = groups.filter((g) => g.day === d);
            const lanes = assignLanes(dayGroups, TILE_MIN);
            return (
              <div
                key={d}
                className={cn("relative border-l border-border", d < todayKey && "bg-[color-mix(in_srgb,var(--bg)_35%,transparent)]")}
                onDragOver={(e) => {
                  const g = dragging.current;
                  if (!g) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const m = minutesAt(e);
                  if (!drag || drag.day !== d || drag.minutes !== m) setDrag({ key: g.key, day: d, minutes: m });
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag((s) => (s?.day === d ? null : s));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const g = dragging.current;
                  dragging.current = null;
                  setDrag(null);
                  if (!g) return;
                  const m = minutesAt(e);
                  const { y, m: mo, d: dd } = parseDayKey(d);
                  const at = zonedToUtc(y, mo, dd, Math.floor(m / 60), m % 60, tz);
                  if (at.toISOString() === g.at) return;
                  void onMove(g, at);
                }}
              >
                {hours.map((h, i) => (
                  <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/50" style={{ top: i * HOUR }} />
                ))}
                {drag && drag.day === d ? (
                  <div className="pointer-events-none absolute inset-x-1 z-10 rounded-md border border-dashed border-brand/70 bg-brand-tint/40" style={{ top: top(drag.minutes), height: TILE_H }}>
                    <span className="absolute -top-5 left-0 text-caption font-medium tabular text-on-tint">{labelFor(drag.minutes)}</span>
                  </div>
                ) : null}
                {(() => {
                  // Columns are narrow, so posts that overlap in time fold into a "+N" pill on the first tile.
                  const overflow = new Map<number, PostGroup[]>();
                  const tiles = dayGroups.map((g) => {
                    const l = lanes.get(g.key) ?? { lane: 0, lanes: 1, cluster: -1 };
                    if (l.lane >= 1) {
                      overflow.set(l.cluster, [...(overflow.get(l.cluster) ?? []), g]);
                      return null;
                    }
                    return (
                      <WeekTile
                        key={g.key}
                        group={g}
                        tz={tz}
                        style={{ top: top(g.minutes) + 2, height: TILE_H - 4, left: 4, right: 4 }}
                        dimmed={drag?.key === g.key}
                        onOpen={() => onOpen(g.key)}
                        onDragStart={(e) => {
                          dragging.current = g;
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", g.key);
                        }}
                        onDragEnd={() => {
                          dragging.current = null;
                          setDrag(null);
                        }}
                      />
                    );
                  });
                  const more = [...overflow.entries()].map(([cluster, list]) => {
                    const anchor = dayGroups.find((g) => lanes.get(g.key)?.cluster === cluster && lanes.get(g.key)?.lane === 0);
                    const first = list[0]!;
                    return (
                      <button
                        key={`more-${first.key}`}
                        type="button"
                        onClick={() => setMoreList(moreList?.[0]?.key === first.key ? null : list)}
                        style={{ top: top(anchor?.minutes ?? first.minutes) + 8 }}
                        className="absolute right-2.5 z-[7] h-5 rounded-full border border-border-strong bg-surface-3 px-1.5 text-[11px] font-medium leading-[18px] tabular text-fg hover:bg-surface-1"
                        aria-label={`${list.length} more post${list.length === 1 ? "" : "s"} around this time`}
                      >
                        +{list.length}
                      </button>
                    );
                  });
                  return [...tiles, ...more];
                })()}
                {moreList && moreList[0]?.day === d ? (
                  <div className="absolute right-1 z-30 max-h-[260px] w-[220px] overflow-y-auto rounded-md border border-border-strong bg-surface-3 p-1.5 shadow-[var(--shadow-3)]" style={{ top: top(Math.min(...moreList.map((g) => g.minutes))) + 32 }}>
                    {moreList.map((g) => (
                      <button
                        key={g.key}
                        type="button"
                        onClick={() => {
                          setMoreList(null);
                          onOpen(g.key);
                        }}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] text-fg hover:bg-surface-2"
                      >
                        <span className="shrink-0 tabular text-fg-3">{fmtTime(g.at, tz)}</span>
                        <span className="truncate">{headline(g)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {isToday && nowMin >= startH * 60 ? (
                  <div className="pointer-events-none absolute -left-px right-0 z-20" style={{ top: top(nowMin) - 1 }} aria-label={`Now, ${fmtTime(now, tz)}`}>
                    <div className="h-[2px] bg-brand" />
                    <span className="signal-pulse absolute -left-[4px] -top-[3px] size-2 rounded-full bg-brand" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function labelFor(m: number): string {
  const h = Math.floor(m / 60);
  const mi = m % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function WeekTile({
  group,
  tz,
  style,
  dimmed,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  group: PostGroup;
  tz: string;
  style: React.CSSProperties;
  dimmed: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const st = groupStatus(group);
  return (
    <button
      type="button"
      draggable={group.movable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      style={style}
      title={`${headline(group)} · ${fmtTime(group.at, tz)} · ${st.label}${group.movable ? " · drag to move" : ""}`}
      className={cn(
        "group absolute z-[5] flex flex-col gap-1 overflow-hidden rounded-md border border-border bg-surface-2 p-1.5 text-left transition-[border-color,opacity] duration-[120ms] hover:z-[6] hover:border-border-strong focus-visible:z-[6]",
        group.movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        group.status === "published" && "bg-surface-1",
        dimmed && "opacity-40",
      )}
    >
      <span className="flex items-start gap-2">
        <Thumb id={group.thumbId} className="h-[36px] w-[20px] rounded-[4px]" />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-medium leading-4 tabular text-fg">{fmtTime(group.at, tz)}</span>
          <Glyphs posts={group.posts} size={12} />
        </span>
      </span>
      <span className="line-clamp-2 text-[12px] leading-[15px] text-fg">{headline(group)}</span>
      <StatusDot tone={st.tone} label={st.label} className="mt-auto truncate text-[11px] leading-4" />
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------------------------------------------

function MonthGrid({
  days,
  monthKey,
  todayKey,
  tz,
  groups,
  onOpen,
  onMove,
}: {
  days: string[];
  monthKey: string | null;
  todayKey: string;
  tz: string;
  groups: PostGroup[];
  onOpen: (key: string) => void;
  onMove: (g: PostGroup, at: Date) => Promise<void>;
}) {
  const dragging = useRef<PostGroup | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const month = monthKey?.slice(0, 7);
  return (
    <div className="hidden overflow-hidden rounded-lg border border-border bg-surface-1 md:block">
      <div className="grid grid-cols-7 border-b border-border">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-3 py-2 text-caption text-fg-3">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const dayGroups = groups.filter((g) => g.day === d);
          const outside = d.slice(0, 7) !== month;
          const isToday = d === todayKey;
          return (
            <div
              key={d}
              className={cn(
                "relative min-h-[112px] border-border p-2",
                i % 7 !== 0 && "border-l",
                i >= 7 && "border-t",
                outside && "bg-[color-mix(in_srgb,var(--bg)_45%,transparent)]",
                over === d && "bg-brand-tint/30",
              )}
              onDragOver={(e) => {
                if (!dragging.current) return;
                e.preventDefault();
                setOver(d);
              }}
              onDragLeave={() => setOver((o) => (o === d ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const g = dragging.current;
                dragging.current = null;
                if (!g || g.day === d) return;
                const { y, m, d: dd } = parseDayKey(d);
                void onMove(g, zonedToUtc(y, m, dd, Math.floor(g.minutes / 60), g.minutes % 60, tz));
              }}
            >
              {isToday ? <div className="absolute inset-x-0 top-0 h-[2px] bg-brand" aria-hidden /> : null}
              <div className={cn("mb-1.5 flex items-center gap-2 text-small tabular", isToday ? "font-medium text-fg" : outside ? "text-fg-3" : "text-fg-2")}>
                {parseDayKey(d).d}
                {isToday ? <span className="text-caption font-normal text-brand-fg">Today</span> : null}
              </div>
              <div className="flex flex-col gap-1">
                {dayGroups.slice(0, 2).map((g) => {
                  const st = groupStatus(g);
                  return (
                    <button
                      key={g.key}
                      type="button"
                      draggable={g.movable}
                      onDragStart={(e) => {
                        dragging.current = g;
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", g.key);
                      }}
                      onClick={() => onOpen(g.key)}
                      title={`${headline(g)} · ${fmtTime(g.at, tz)} · ${st.label}`}
                      className={cn("flex flex-col gap-0.5 rounded-sm bg-surface-2 px-1.5 py-1 text-left hover:bg-surface-3", g.movable && "cursor-grab")}
                    >
                      <span className="line-clamp-2 text-[12px] leading-[15px] text-fg">{headline(g)}</span>
                      <span className="flex items-center gap-1.5 text-fg-3">
                        <StatusDot tone={st.tone} label={st.label} hideLabel />
                        <span className="text-[11px] leading-4 tabular">{fmtTime(g.at, tz).replace(":00", "")}</span>
                        <span className="ml-auto">
                          <Glyphs posts={g.posts} size={11} />
                        </span>
                      </span>
                    </button>
                  );
                })}
                {dayGroups.length > 2 ? (
                  <button type="button" onClick={() => onOpen(dayGroups[2]!.key)} className="px-1.5 text-left text-caption text-fg-3 hover:text-fg">
                    {dayGroups.length - 2} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Phones: a simple list grouped by day
// ---------------------------------------------------------------------------------------------------------------

function Agenda({ days, todayKey, now, tz, groups, onOpen, emptyText }: { days: string[]; todayKey: string; now: Date; tz: string; groups: PostGroup[]; onOpen: (key: string) => void; emptyText: string }) {
  return (
    <div className="flex flex-col gap-6 md:hidden">
      {days.map((d) => {
        const dayGroups = groups.filter((g) => g.day === d);
        const isToday = d === todayKey;
        if (!dayGroups.length) return null;
        return (
          <section key={d} className="flex flex-col gap-2">
            <h3 className="flex items-baseline gap-2 text-small font-medium text-fg">
              {fmtDate(`${d}T12:00:00Z`, "UTC", { weekday: "long", month: "short", day: "numeric" })}
              {isToday ? <span className="text-caption font-normal text-brand-fg">Today</span> : null}
            </h3>
            {dayGroups.map((g) => (
              <AgendaRow key={g.key} group={g} tz={tz} past={new Date(g.at) < now} onOpen={() => onOpen(g.key)} />
            ))}
          </section>
        );
      })}
      {!groups.some((g) => days.includes(g.day)) ? <p className="text-small text-fg-2">{emptyText}</p> : null}
    </div>
  );
}

function AgendaRow({ group, tz, past, onOpen }: { group: PostGroup; tz: string; past: boolean; onOpen: () => void }) {
  const st = groupStatus(group);
  const why = group.posts.find((p) => p.status === "failed" && p.error)?.error;
  return (
    <button type="button" onClick={onOpen} className={cn("flex min-h-[72px] items-center gap-3 rounded-lg border border-border bg-surface-1 p-2 pr-3 text-left", past && group.status === "published" && "opacity-80")}>
      <Thumb id={group.thumbId} className="h-[64px] w-[36px] rounded-sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-small font-medium text-fg">{headline(group)}</span>
        <span className="flex items-center gap-2">
          <span className="text-caption tabular text-fg-3">{fmtTime(group.at, tz)}</span>
          <Glyphs posts={group.posts} size={14} />
          <StatusDot tone={st.tone} label={st.label} className="ml-auto" />
        </span>
        {why ? <span className="truncate text-caption text-danger">{why}</span> : null}
      </span>
    </button>
  );
}
