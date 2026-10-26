"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, LayoutGrid, Rows3 } from "lucide-react";
import { fmtCompact, fmtDate, fmtX, platformLabel } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import { cn } from "@/components/ui";
import type { AnalyticsPost } from "@/server/queries/analytics";
import { Cover } from "./cover";
import { VersusBadge } from "./versus";

type Key = "publishedAt" | "views" | "likes" | "comments" | "shares" | "saves" | "x";

const COLS: { key: Exclude<Key, "publishedAt">; label: string; title: string }[] = [
  { key: "views", label: "Views", title: "Plays or views" },
  { key: "likes", label: "Likes", title: "Likes" },
  { key: "comments", label: "Comments", title: "Comments" },
  { key: "shares", label: "Shares", title: "Shares (not every platform reports them)" },
  { key: "saves", label: "Saves", title: "Saves (only your analytics account reports them)" },
  { key: "x", label: "vs normal", title: "Against your own typical post on that platform. 1× is a typical post" },
];

const ALL = "all";

/** Your posts, newest first, sortable on any number. Grid or table; click a post for its breakdown. */
export function PostsTable({ posts, tz }: { posts: AnalyticsPost[]; tz: string }) {
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "publishedAt", dir: -1 });
  const [platform, setPlatform] = useState<string>(ALL);
  const [view, setView] = useState<"grid" | "table">("grid");
  const platforms = useMemo(() => [...new Set(posts.map((p) => p.platform))], [posts]);
  const rows = useMemo(() => {
    const list = posts.filter((p) => platform === ALL || p.platform === platform);
    return [...list].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
  }, [posts, platform, sort]);
  const toggle = (key: Key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }));
  const SortIcon = ({ k }: { k: Key }) => (sort.key === k ? sort.dir === -1 ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden /> : null);
  const ariaSort = (k: Key) => (sort.key === k ? (sort.dir === -1 ? "descending" : "ascending") : "none");
  const hasSaves = posts.some((p) => p.saves !== null);
  const cols = COLS.filter((c) => c.key !== "saves" || hasSaves);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {platforms.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by platform">
            {[ALL, ...platforms].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatform(p)}
                aria-pressed={platform === p}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors duration-[120ms]",
                  platform === p ? "border-border-strong bg-surface-3 text-fg" : "border-border text-fg-2 hover:text-fg",
                )}
              >
                {p === ALL ? "All platforms" : <PlatformIcon platform={p} label />}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <label htmlFor="posts-sort" className="text-caption text-fg-3">
            Sort by
          </label>
          <select
            id="posts-sort"
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [k, d] = e.target.value.split(":");
              setSort({ key: k as Key, dir: Number(d) as 1 | -1 });
            }}
            className="h-8 rounded-md border border-border bg-surface-1 px-2 text-small text-fg"
          >
            <option value="publishedAt:-1">Newest</option>
            <option value="publishedAt:1">Oldest</option>
            {cols.map((c) => (
              <option key={c.key} value={`${c.key}:-1`}>
                Most {c.key === "x" ? "above normal" : c.label.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-caption text-fg-3">
            {rows.length} post{rows.length === 1 ? "" : "s"}
          </span>
          <div className="hidden rounded-md border border-border bg-surface-1 p-0.5 md:inline-flex" role="group" aria-label="Layout">
            {(["grid", "table"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                aria-label={v === "grid" ? "Show as grid" : "Show as table"}
                className={cn("inline-flex size-7 items-center justify-center rounded-[8px] transition-colors duration-[120ms]", view === v ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg")}
              >
                {v === "grid" ? <LayoutGrid className="size-3.5" aria-hidden /> : <Rows3 className="size-3.5" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ul className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5", view === "table" && "md:hidden")}>
        {rows.map((p) => (
          <li key={p.id}>
            <Link href={`/analytics/posts/${p.id}`} className="group flex h-full flex-col gap-2 rounded-lg border border-border bg-surface-1 p-2.5 transition-colors duration-[120ms] hover:border-border-strong focus-visible:outline-2 focus-visible:outline-brand">
              <div className="relative">
                <Cover src={p.thumbnailUrl} platform={p.platform} />
                {p.versus === "above" || p.versus === "below" ? (
                  <span
                    className={cn(
                      "absolute left-1.5 top-1.5 inline-flex h-[22px] items-center rounded-sm bg-surface-1/90 px-1.5 text-caption font-medium tabular",
                      p.versus === "above" ? "text-success" : "text-warning",
                    )}
                    title={p.versus === "above" ? "Above your normal" : "Below your normal"}
                  >
                    {p.versus === "above" ? <ArrowUp className="mr-0.5 size-3" aria-hidden /> : <ArrowDown className="mr-0.5 size-3" aria-hidden />}
                    {fmtX(p.x)}
                    <span className="sr-only">{p.versus === "above" ? " above your normal" : " below your normal"}</span>
                  </span>
                ) : null}
              </div>
              <p className="line-clamp-2 text-small text-fg group-hover:underline group-hover:decoration-border-strong group-hover:underline-offset-4">{p.title}</p>
              <p className="mt-auto flex items-center gap-1.5 text-caption tabular text-fg-3">
                <PlatformIcon platform={p.platform} size={12} />
                {fmtDate(p.publishedAt, tz, { month: "short", day: "numeric" })}
              </p>
              <p className="text-caption tabular text-fg-2">
                <span className="font-medium text-fg">{fmtCompact(p.views)}</span> views · {fmtCompact(p.likes)} likes · {fmtCompact(p.comments)} comments
              </p>
            </Link>
          </li>
        ))}
      </ul>

      {view === "table" ? (
        <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface-1 md:block">
          <table className="w-full min-w-[820px] table-fixed text-small">
            <thead>
              <tr className="border-b border-border text-left text-caption text-fg-3">
                <th scope="col" className="w-[38%] px-4 py-3 font-medium" aria-sort={ariaSort("publishedAt")}>
                  <button type="button" onClick={() => toggle("publishedAt")} className="inline-flex items-center gap-1 hover:text-fg">
                    Post <SortIcon k="publishedAt" />
                  </button>
                </th>
                {cols.map((c) => (
                  <th key={c.key} scope="col" className={cn("px-2 py-3 text-right font-medium", c.key === "x" && "w-[18%]")} aria-sort={ariaSort(c.key)} title={c.title}>
                    <button type="button" onClick={() => toggle(c.key)} className={cn("inline-flex items-center gap-1 hover:text-fg", sort.key === c.key && "text-fg")}>
                      <SortIcon k={c.key} />
                      {c.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="group border-b border-border last:border-b-0 hover:bg-surface-2/60">
                  <td className="px-4 py-2.5">
                    <Link href={`/analytics/posts/${p.id}`} className="flex min-w-0 items-center gap-3 outline-none focus-visible:underline">
                      <span className="block w-9 shrink-0"><Cover src={p.thumbnailUrl} platform={p.platform} /></span>
                      <span className="min-w-0">
                        <span className="block truncate text-fg group-hover:underline group-hover:decoration-border-strong group-hover:underline-offset-4">{p.title}</span>
                        <span className="flex items-center gap-1.5 text-caption text-fg-3">
                          <PlatformIcon platform={p.platform} size={12} />
                          {fmtDate(p.publishedAt, tz, { month: "short", day: "numeric" })}
                          {!p.settled ? " · still settling" : ""}
                        </span>
                      </span>
                    </Link>
                  </td>
                  {cols.map((c) => (
                    <td key={c.key} className={cn("whitespace-nowrap px-2 py-2.5 text-right tabular", c.key === "x" ? "font-medium text-fg" : "text-fg-2")}>
                      {c.key === "x" ? (
                        <span className="inline-flex items-center justify-end gap-2">
                          <VersusBadge versus={p.versus} x={p.x} />
                          {p.x === null ? <span className="text-caption font-normal text-fg-3">{p.settled ? "Learning your normal" : "Settling"}</span> : fmtX(p.x)}
                        </span>
                      ) : (
                        fmtCompact(p[c.key])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="text-caption text-fg-3">
        A dash means the platform didn&apos;t report that number. It is never counted as zero. {platform !== ALL ? `Showing ${platformLabel(platform)} only.` : ""}
      </p>
    </div>
  );
}
