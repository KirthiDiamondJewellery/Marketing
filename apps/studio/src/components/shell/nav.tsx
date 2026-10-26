"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Bot, CalendarDays, ChartLine, FileText, House, Scissors, Settings, type LucideIcon } from "lucide-react";
import { NAV } from "@/lib/nav";
import type { ApprovalItem } from "@/lib/live";
import { useLive } from "@/lib/use-live";
import { cn } from "@/components/ui";
import { usd } from "./format";
import { Wordmark } from "./wordmark";
import { usePendingApprovals } from "./decided";

export const NAV_ICONS: Record<string, LucideIcon> = { House, FileText, Scissors, CalendarDays, Bot, ChartLine, BookOpen, Settings };

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** What needs you, per page: scripts to OK on Scripts, finished videos on Edit, everything else on Home. */
export function needsYou(pending: ApprovalItem[]): Record<string, number> {
  const scripts = pending.filter((a) => a.kind === "script").length;
  const videos = pending.filter((a) => a.kind === "edit").length;
  return { "/scripts": scripts, "/edit": videos, "/": pending.length - scripts - videos };
}

/** Agents working right now, as a small live light: the team at a glance, and a way into the Agents view. */
function TeamLight() {
  const { snapshot } = useLive();
  const working = snapshot?.agents.filter((a) => a.state === "working") ?? [];
  const label = working.length ? `${working.length} ${working.length === 1 ? "agent" : "agents"} working` : "Team is idle";
  return (
    <Link href="/agents" title={working.map((a) => `${a.name}: ${a.label}`).join("\n") || label} className="flex items-center gap-2 rounded-md px-3 py-2 text-small text-fg-2 transition-colors hover:bg-surface-1 hover:text-fg max-[1199px]:justify-center max-[1199px]:px-0">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", working.length ? "signal-pulse bg-brand" : "bg-fg-3")} />
      <span className="hidden truncate min-[1200px]:inline">{label}</span>
    </Link>
  );
}

/** Left navigation: 240px on desktop, a 64px icon rail on tablet. */
export function SideNav() {
  const pathname = usePathname();
  const { snapshot } = useLive();
  const counts = needsYou(usePendingApprovals(snapshot?.approvals));
  const ws = snapshot?.workspace;

  return (
    <nav aria-label="Studio" className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col border-r border-border bg-bg md:flex min-[1200px]:w-60">
      <div className="flex h-[72px] shrink-0 flex-col justify-center px-5 max-[1199px]:items-center max-[1199px]:px-0">
        <Link href="/" className="rounded-sm outline-offset-4" aria-label="AttentionOS home">
          <span className="hidden min-[1200px]:inline">
            <Wordmark />
          </span>
          <span className="min-[1200px]:hidden">
            <Wordmark ringOnly />
          </span>
        </Link>
        {ws ? <div className="mt-1.5 hidden truncate text-small text-fg-3 min-[1200px]:block">{ws.name}</div> : null}
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-2 max-[1199px]:px-2">
        {NAV.map((item, i) => {
          const Icon = NAV_ICONS[item.icon] ?? House;
          const active = isActive(pathname, item.href);
          const count = counts[item.href] ?? 0;
          return (
            <li key={item.href} className={cn(i === 6 && "mt-4 border-t border-border pt-4")}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                title={item.label}
                className={cn(
                  "group relative flex h-9 items-center gap-3 rounded-md px-3 text-[14px] transition-colors duration-[120ms] max-[1199px]:justify-center max-[1199px]:px-0",
                  active ? "bg-surface-2 text-fg" : "text-fg-2 hover:bg-surface-1 hover:text-fg",
                )}
              >
                {count ? <span aria-hidden className="signal-pulse absolute inset-y-2 left-0 w-[2px] rounded-full bg-brand" /> : null}
                <Icon className="size-5 shrink-0" strokeWidth={1.5} />
                <span className="hidden flex-1 truncate min-[1200px]:inline">{item.label}</span>
                {count ? (
                  <span
                    aria-label={`${count} need you`}
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-tint px-1.5 text-caption font-medium text-on-tint tabular max-[1199px]:absolute max-[1199px]:right-1 max-[1199px]:top-0 max-[1199px]:h-4 max-[1199px]:min-w-4 max-[1199px]:px-1 max-[1199px]:text-[10px]"
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1 border-t border-border p-3 max-[1199px]:items-center max-[1199px]:px-2">
        <TeamLight />
        <SystemStatus />
      </div>
    </nav>
  );
}

/** Worker, mode and today's spend: the three things that tell you whether the team can work right now. */
export function SystemStatus({ compactOnly = false }: { compactOnly?: boolean }) {
  const { snapshot, connected } = useLive();
  if (!snapshot) return null;
  const online = snapshot.workerOnline;
  const mode = snapshot.workspace.mode;
  const { todayUsd, dailyBudgetUsd } = snapshot.spend;
  const pct = dailyBudgetUsd > 0 ? Math.min(1, todayUsd / dailyBudgetUsd) : 0;
  const statusText = !connected ? "Reconnecting" : online ? "Online" : "Offline";
  // On your Claude plan nothing is billed per use, so the spend meter only shows when there is API spend to watch.
  const showSpend = todayUsd > 0;

  return (
    <>
      <div
        className={cn("flex w-full flex-col gap-2.5 rounded-md px-3 py-2.5", compactOnly ? "" : "max-[1199px]:hidden")}
        title={online ? "Your team is running and can pick up work." : "Your team isn't running. In Terminal: cd ~/AttentionOS && ./aos start"}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-small text-fg-2">
            <span aria-hidden className={cn("size-1.5 rounded-full", !connected ? "bg-warning" : online ? "bg-success" : "bg-fg-3")} />
            {statusText}
          </span>
          <span className="inline-flex h-5 items-center rounded-sm bg-surface-3 px-1.5 text-[11px] font-medium text-fg-2">{mode === "autopilot" ? "Autopilot" : "On request"}</span>
        </div>
        {showSpend ? <div>
          <div className="flex items-baseline justify-between text-caption">
            <span className="text-fg-3">Spend today</span>
            <span className="text-fg-2 tabular">
              {usd(todayUsd, { precise: true })} <span className="text-fg-3">of {usd(dailyBudgetUsd)}</span>
            </span>
          </div>
          <div className="mt-1.5 h-[2px] w-full overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Daily budget used">
            <div className={cn("h-full rounded-full", pct >= 0.9 ? "bg-danger" : pct >= 0.8 ? "bg-warning" : "bg-fg-2")} style={{ width: `${Math.max(pct * 100, 2)}%` }} />
          </div>
        </div> : null}
      </div>
      {compactOnly ? null : (
        <span
          className="hidden size-2 rounded-full max-[1199px]:block"
          style={{ background: !connected ? "var(--warning)" : online ? "var(--success)" : "var(--text-muted)" }}
          title={`${statusText} · ${mode === "autopilot" ? "Autopilot" : "On request"} · ${usd(todayUsd, { precise: true })} of ${usd(dailyBudgetUsd)} today`}
        />
      )}
    </>
  );
}
