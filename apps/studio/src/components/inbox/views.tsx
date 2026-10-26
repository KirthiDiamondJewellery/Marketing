import Link from "next/link";
import { ArrowUpRight, Link2, UserCheck } from "lucide-react";
import { Badge, Card, cn, type BadgeTone } from "@/components/ui";
import { PlatformIcon, StatusDot, type StatusTone } from "@/components/content/shared";
import { fmtDate, fmtRelative, handle, humanize, platformLabel } from "@/components/content/format";
import type { Automation, Lead } from "@/server/queries/inbox";

const AUTO_STATUS: Record<string, { tone: StatusTone; label: string }> = {
  active: { tone: "success", label: "Live" },
  draft: { tone: "neutral", label: "Draft, goes live with the post" },
  paused: { tone: "warning", label: "Paused" },
  failed: { tone: "danger", label: "Failed" },
};

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function AutomationCard({ a }: { a: Automation }) {
  const st = AUTO_STATUS[a.status] ?? { tone: "neutral" as const, label: humanize(a.status) };
  return (
    <Card className="flex flex-col gap-5 md:flex-row md:gap-8">
      <div className="md:w-56 md:shrink-0">
        <p className="text-caption text-fg-3">When someone comments</p>
        <p className="mt-1 font-mono text-[20px] font-medium tracking-[0.04em] text-fg">{a.keyword}</p>
        <StatusDot tone={st.tone} label={st.label} className="mt-2" />
        {a.error ? <p className="mt-2 text-caption text-danger">{a.error}</p> : null}
      </div>
      <div className="min-w-0 flex-1 space-y-4">
        <div>
          <p className="text-caption text-fg-3">They get a DM</p>
          <p className="mt-1 max-w-[60ch] text-small text-fg">{a.dmText ?? "No message yet"}</p>
          {a.button ? (
            <p className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-sm bg-surface-2 px-2.5 py-1 text-caption text-fg-2">
              <Link2 className="size-3 shrink-0" />
              <span className="font-medium text-fg">{a.button.label}</span>
              <span className="truncate text-fg-3">{prettyUrl(a.button.url)}</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-caption text-fg-3">
          {a.post ? (
            <span className="inline-flex items-center gap-1.5">
              <PlatformIcon platform={a.post.platform} size={14} />
              On {a.post.title ? <span className="text-fg-2">{a.post.title}</span> : platformLabel(a.post.platform)}
            </span>
          ) : null}
          {a.guide ? <span>Sends: <span className="text-fg-2">{a.guide}</span></span> : null}
          {a.requireFollow ? <span>Followers only</span> : null}
        </div>
      </div>
      <div className="flex items-baseline gap-2 md:w-28 md:shrink-0 md:flex-col md:items-end md:gap-0">
        <span className="text-h2 font-medium tabular text-fg">{a.leads}</span>
        <span className="text-caption text-fg-3">lead{a.leads === 1 ? "" : "s"}</span>
      </div>
    </Card>
  );
}

const TEMP: Record<string, { tone: BadgeTone; label: string }> = {
  hot: { tone: "brand", label: "Hot" },
  warm: { tone: "warning", label: "Warm" },
  cold: { tone: "neutral", label: "Cold" },
};

const SOURCE: Record<string, string> = {
  dm_keyword: "Keyword DM",
  lead_magnet: "Guide download",
  dm: "DM",
  comment: "Comment",
};

export function LeadsTable({ leads, tz, now }: { leads: Lead[]; tz: string; now: Date }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="hidden grid-cols-[minmax(0,1.6fr)_80px_minmax(0,1.1fr)_minmax(0,1.8fr)_96px] gap-4 border-b border-border px-5 py-3 text-caption text-fg-3 lg:grid">
        <span>Lead</span>
        <span>Temperature</span>
        <span>How they came in</span>
        <span>From post</span>
        <span className="text-right">Added</span>
      </div>
      <ul>
        {leads.map((l) => {
          const temp = l.temperature ? TEMP[l.temperature] : null;
          return (
            <li key={l.id} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 border-b border-border px-5 py-4 last:border-b-0 lg:grid-cols-[minmax(0,1.6fr)_80px_minmax(0,1.1fr)_minmax(0,1.8fr)_96px] lg:items-start">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-fg">{l.name ?? (handle(l.handle) || "Unnamed lead")}</p>
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-caption text-fg-3">
                  {l.platform ? <PlatformIcon platform={l.platform} size={12} /> : null}
                  <span className="truncate">{handle(l.handle)}</span>
                </p>
                {l.email ? <p className="truncate text-caption text-fg-3">{l.email}</p> : null}
                {l.notes ? <p className="mt-1.5 text-caption text-fg-2">{l.notes}</p> : null}
              </div>
              <div>{temp ? <Badge tone={temp.tone}>{temp.label}</Badge> : <span className="text-caption text-fg-3">–</span>}</div>
              <div className="col-span-2 text-small text-fg-2 lg:col-span-1">
                {l.source ? (SOURCE[l.source] ?? humanize(l.source)) : "–"}
                {l.keyword ? <p className="mt-0.5 font-mono text-[12px] text-fg">{l.keyword}</p> : null}
              </div>
              <div className="col-span-2 min-w-0 text-small lg:col-span-1">
                {l.fromPost?.title ? (
                  l.fromPost.contentId ? (
                    <Link href={`/content/${l.fromPost.contentId}`} className="group inline-flex max-w-full items-center gap-1 text-fg hover:underline hover:decoration-border-strong hover:underline-offset-4">
                      <span className="truncate">{l.fromPost.title}</span>
                      <ArrowUpRight className="size-3 shrink-0 text-fg-3" />
                    </Link>
                  ) : (
                    <span className="text-fg">{l.fromPost.title}</span>
                  )
                ) : (
                  <span className="text-fg-3">{l.utmContent ? "Post not found" : "Not from a post"}</span>
                )}
                {l.utmContent ? <p className="mt-0.5 font-mono text-[11.5px] text-fg-3">utm_content={l.utmContent}</p> : null}
              </div>
              <div className={cn("col-span-2 text-caption text-fg-3 lg:col-span-1 lg:text-right")} title={fmtDate(l.createdAt, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}>
                {fmtRelative(l.createdAt, now)}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function LeadStats({ leads, now }: { leads: Lead[]; now: Date }) {
  const week = leads.filter((l) => now.getTime() - new Date(l.createdAt).getTime() < 7 * 86_400_000);
  const hot = leads.filter((l) => l.temperature === "hot").length;
  const byPost = new Map<string, number>();
  for (const l of leads) if (l.fromPost?.title) byPost.set(l.fromPost.title, (byPost.get(l.fromPost.title) ?? 0) + 1);
  const best = [...byPost.entries()].sort((a, b) => b[1] - a[1])[0];
  return (
    <div className="mb-6 grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-3">
      <Stat label="Leads this week" value={week.length} />
      <Stat label="Hot leads" value={hot} />
      <div className="col-span-2 sm:col-span-1">
        <p className="text-small text-fg-2">Best post for leads</p>
        <p className="mt-1 flex items-start gap-1.5 text-[15px] font-medium text-fg">
          <UserCheck className="mt-1 size-4 shrink-0 text-fg-3" />
          <span className="line-clamp-2">{best ? `${best[0]} (${best[1]})` : "No tracked leads yet"}</span>
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-small text-fg-2">{label}</p>
      <p className="mt-1 text-h1 font-medium tabular text-fg">{value}</p>
    </div>
  );
}
