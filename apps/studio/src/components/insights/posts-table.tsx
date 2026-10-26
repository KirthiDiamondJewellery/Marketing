"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Badge, cn } from "@/components/ui";
import { fmtCompact, fmtDate, fmtX, humanize, platformLabel } from "@/components/content/format";
import { PlatformIcon } from "@/components/content/shared";
import type { PostRow } from "@/server/queries/insights";
import { fmtUnit } from "./units";

type Key = "publishedAt" | "views" | "x" | "velocity" | "hold3s" | "sendRate" | "followsPer1k" | "leads";

const COLS: { key: Key; label: string; title: string; render: (p: PostRow) => string }[] = [
  { key: "views", label: "Views", title: "Views at the settled capture (7 days, else 3 days, else the latest)", render: (p) => fmtCompact(p.views) },
  { key: "x", label: "vs usual", title: "Result against your own normal on that platform. 1× is a typical post", render: (p) => fmtX(p.x) },
  { key: "velocity", label: "First day", title: "First-day views against your usual first day", render: (p) => (p.velocity === null ? "–" : fmtX(p.velocity)) },
  { key: "hold3s", label: "3s hold", title: "Viewers still watching at 3 seconds (from retention or skip rate)", render: (p) => fmtUnit(p.hold3s, "rate") },
  { key: "sendRate", label: "Send rate", title: "Shares and saves per view", render: (p) => fmtUnit(p.sendRate, "rate") },
  { key: "followsPer1k", label: "Follows/1k", title: "New follows per 1,000 views", render: (p) => fmtUnit(p.followsPer1k, "per1k") },
  { key: "leads", label: "Leads", title: "Leads credited to the post through its tracked link", render: (p) => (p.leads ? String(p.leads) : "–") },
];

const PLATFORMS_ALL = "all";

/** Every post, sortable on any column; click a row for its full breakdown. */
export function PostsTable({ posts, tz }: { posts: PostRow[]; tz: string }) {
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "publishedAt", dir: -1 });
  const [platform, setPlatform] = useState<string>(PLATFORMS_ALL);
  const platforms = useMemo(() => [...new Set(posts.map((p) => p.platform))], [posts]);
  const rows = useMemo(() => {
    const list = posts.filter((p) => platform === PLATFORMS_ALL || p.platform === platform);
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

  const flag = (p: PostRow) => (p.flag === "breakout" ? <Badge tone="success">Breakout</Badge> : p.flag === "flop" ? <Badge tone="warning">Flop</Badge> : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by platform">
        {[PLATFORMS_ALL, ...platforms].map((p) => (
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
            {p === PLATFORMS_ALL ? "All platforms" : <PlatformIcon platform={p} label />}
          </button>
        ))}
        <span className="ml-auto text-caption text-fg-3">{rows.length} post{rows.length === 1 ? "" : "s"}</span>
      </div>

      {/* Phone: stacked rows with the three numbers that matter most. */}
      <div className="flex items-center gap-2 md:hidden">
        <label htmlFor="sort-mobile" className="text-caption text-fg-3">
          Sort by
        </label>
        <select
          id="sort-mobile"
          value={sort.key}
          onChange={(e) => setSort({ key: e.target.value as Key, dir: -1 })}
          className="h-9 rounded-md border border-border bg-surface-1 px-2 text-small text-fg"
        >
          <option value="publishedAt">Newest</option>
          {COLS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1 md:hidden">
        {rows.map((p) => (
          <li key={p.id}>
            <Link href={`/insights/posts/${p.id}`} className="flex items-start justify-between gap-4 px-4 py-3.5 active:bg-surface-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <PlatformIcon platform={p.platform} />
                  <span className="truncate text-small text-fg">{p.title}</span>
                </div>
                <p className="mt-1 text-caption tabular text-fg-3">
                  {fmtDate(p.publishedAt, tz, { month: "short", day: "numeric" })} · {fmtCompact(p.views)} views · send {fmtUnit(p.sendRate, "rate")}
                  {p.leads ? ` · ${p.leads} lead${p.leads === 1 ? "" : "s"}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {p.x === null ? <span className="text-caption text-fg-3">{p.settled ? "Building baseline" : "Measuring"}</span> : <span className="text-small font-medium tabular text-fg">{fmtX(p.x)}</span>}
                {flag(p)}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface-1 md:block">
        <table className="w-full min-w-[780px] table-fixed text-small">
          <thead>
            <tr className="border-b border-border text-left text-caption text-fg-3">
              <th scope="col" className="w-[36%] px-4 py-3 font-medium" aria-sort={ariaSort("publishedAt")}>
                <button type="button" onClick={() => toggle("publishedAt")} className="inline-flex items-center gap-1 hover:text-fg">
                  Post <SortIcon k="publishedAt" />
                </button>
              </th>
              {COLS.map((c) => (
                <th key={c.key} scope="col" className={cn("px-2 py-3 text-right font-medium", c.key === "x" && "w-[15%]")} aria-sort={ariaSort(c.key)} title={c.title}>
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
                <td className="px-4 py-3">
                  <Link href={`/insights/posts/${p.id}`} className="flex min-w-0 items-center gap-2.5 outline-none focus-visible:underline">
                    <PlatformIcon platform={p.platform} />
                    <span className="min-w-0">
                      <span className="block truncate text-fg group-hover:underline group-hover:decoration-border-strong group-hover:underline-offset-4">{p.title}</span>
                      <span className="block truncate text-caption text-fg-3">
                        {fmtDate(p.publishedAt, tz, { month: "short", day: "numeric" })}
                        {p.lane ? ` · ${humanize(p.lane)}` : ""}
                        {p.variants > 1 ? ` · ${p.variants} trial variants` : ""}
                        {!p.settled ? " · still settling" : ""}
                      </span>
                    </span>
                  </Link>
                </td>
                {COLS.map((c) => (
                  <td key={c.key} className={cn("whitespace-nowrap px-2 py-3 text-right tabular", c.key === "x" ? "font-medium text-fg" : "text-fg-2")}>
                    {c.key === "x" ? (
                      <span className="inline-flex items-center justify-end gap-2">
                        {flag(p)}
                        {p.x === null ? <span className="text-caption font-normal text-fg-3" title={p.settled ? "Fewer than 5 settled posts on this platform to know its normal" : "Numbers still coming in"}>{p.settled ? "Building baseline" : "Measuring"}</span> : c.render(p)}
                      </span>
                    ) : (
                      c.render(p)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-fg-3">
        A dash means the platform hasn't reported that number for the post. It is never counted as zero. {platform !== PLATFORMS_ALL ? `Showing ${platformLabel(platform)} only.` : ""}
      </p>
    </div>
  );
}
