"use client";
import { ArrowUpRight, TriangleAlert, CircleAlert } from "lucide-react";
import Link from "next/link";
import type { HomeAlert, HomeData } from "@/server/queries/home";
import { BriefingFigure, PlatformGlyph } from "@/motion";
import { compact, platformLabel, usd } from "@/components/shell/format";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-small text-fg-2">{label}</div>
      <div className="mt-0.5 text-h2 font-medium text-fg tabular">{value}</div>
      {sub ? <div className="text-caption text-fg-3">{sub}</div> : null}
    </div>
  );
}

/** Yesterday and this week, led by the best post against the user's own normal. */
export function Results({ results }: { results: HomeData["results"] }) {
  const { best, yesterday, week, spend } = results;
  return (
    <div className="@container h-full rounded-lg border border-border bg-surface-1 p-6">
      <div className="flex h-full flex-col gap-6 @xl:grid @xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] @xl:items-center @xl:gap-10">
      {best && best.xScore !== null ? (
        <div>
          <BriefingFigure value={best.xScore} format={(n: number) => `${n.toFixed(1)}×`} label="Best post this week, against your usual" />
          <div className="mt-4 flex items-center gap-2 text-small text-fg-2">
            <PlatformGlyph platform={best.platform} size={14} />
            <span className="truncate text-fg">{best.title}</span>
          </div>
          <div className="mt-1 text-caption text-fg-3 tabular">
            {compact(best.views)} views on {platformLabel(best.platform)}
            {best.follows ? ` · +${compact(best.follows)} follows` : ""}
            {best.leads ? ` · ${best.leads} leads` : ""}
          </div>
        </div>
      ) : (
        <div>
          <p className="text-h3 font-medium text-fg">No results yet this week</p>
          <p className="mt-1 text-small text-fg-2">Once a post has a day of data, the Analyst scores it against your usual here.</p>
        </div>
      )}

      <div className="mt-auto grid grid-cols-2 gap-x-6 gap-y-5 border-t border-border pt-5 @xl:mt-0 @xl:border-l @xl:border-t-0 @xl:pl-10 @xl:pt-0">
        <Stat label="Follows this week" value={`+${compact(week.follows)}`} sub={yesterday.follows ? `+${compact(yesterday.follows)} yesterday` : `${week.posts} posts`} />
        <Stat label="Leads this week" value={compact(week.leads)} sub={yesterday.leads ? `${yesterday.leads} yesterday` : undefined} />
        <Stat label="Views this week" value={compact(week.views)} sub={`${week.posts} ${week.posts === 1 ? "post" : "posts"}`} />
        {spend.todayUsd > 0 || week.spendUsd > 0 ? (
          <Stat label="AI spend today" value={usd(spend.todayUsd, { precise: true })} sub={`of ${usd(spend.dailyBudgetUsd)} · ${usd(week.spendUsd)} this week`} />
        ) : (
          <Stat label="Posts this week" value={compact(week.posts)} sub={yesterday.posts ? `${yesterday.posts} yesterday` : undefined} />
        )}
      </div>
      </div>
    </div>
  );
}

export function HeadsUp({ alerts }: { alerts: HomeAlert[] }) {
  if (!alerts.length) {
    return <p className="rounded-lg border border-border bg-surface-1 px-6 py-6 text-small text-fg-2">All clear. Accounts connected, posts on time, budget on track.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
      {alerts.map((a, i) => (
        <li key={i} className="flex items-start gap-3 px-5 py-4">
          {a.level === "danger" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} aria-label="Problem" />
          ) : (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.75} aria-label="Warning" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-fg">{a.title}</p>
            <p className="mt-0.5 text-small text-fg-2">{a.detail}</p>
          </div>
          {a.href ? (
            <Link href={a.href} className="flex shrink-0 items-center gap-1 text-small text-fg-2 hover:text-fg">
              {a.action ?? "Open"}
              <ArrowUpRight className="size-3.5" strokeWidth={1.5} />
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
