import { Badge } from "@/components/ui";
import { fmtDate, fmtX } from "@/components/content/format";
import { EmptyState, PlatformIcon } from "@/components/content/shared";
import type { PostMortem } from "@/server/queries/insights";
import { Markdown } from "./markdown";

const KIND: Record<PostMortem["kind"], { label: string; tone: "success" | "warning" | "gold" | "neutral" }> = {
  breakout: { label: "Breakout", tone: "success" },
  new_best: { label: "New best", tone: "gold" },
  flop: { label: "Flop", tone: "warning" },
  manual: { label: "Review", tone: "neutral" },
};

const isWin = (m: PostMortem) => m.kind === "breakout" || m.kind === "new_best" || (m.kind === "manual" && (m.x ?? 1) >= 1);

export function MortemCard({ m, tz }: { m: PostMortem; tz: string }) {
  const k = KIND[m.kind];
  const heading = /^#{1,6}\s+(.*)$/m.exec(m.bodyMd)?.[1]?.replace(/^(Breakout|Flop|New best):\s*/i, "").replace(/\s*\([\d.]+×\)\s*$/, "");
  return (
    <article className="flex flex-col gap-4 rounded-lg border border-border bg-surface-1 p-5 sm:p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={k.tone}>{k.label}</Badge>
            {m.platform ? <PlatformIcon platform={m.platform} label /> : null}
          </div>
          <h3 className="mt-2 text-h3 font-medium text-fg">{m.title ?? heading ?? "Post review"}</h3>
          <p className="text-caption text-fg-3">
            {m.publishedAt ? `Published ${fmtDate(m.publishedAt, tz, { month: "short", day: "numeric" })} · ` : ""}Reviewed {fmtDate(m.createdAt, tz, { month: "short", day: "numeric" })}
          </p>
        </div>
        {m.x !== null ? (
          <div className="shrink-0 text-right">
            <div className="font-display text-[40px] leading-[44px] tabular text-fg">{fmtX(m.x)}</div>
            <div className="text-caption text-fg-3">vs your usual</div>
          </div>
        ) : null}
      </header>
      <Markdown source={m.bodyMd} skipFirstHeading={!/^\s*##\s+What happened/i.test(m.bodyMd)} />
      {m.lessons.length ? (
        <div className="rounded-md border border-border px-4 py-3">
          <h4 className="text-caption font-medium text-fg-2">Lessons the team took from it</h4>
          <ul className="mt-1.5 flex flex-col gap-1">
            {m.lessons.map((l) => (
              <li key={l} className="text-small text-fg">
                {l}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

export function PostMortems({ items, tz }: { items: PostMortem[]; tz: string }) {
  const wins = items.filter(isWin);
  const losses = items.filter((m) => !isWin(m));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <h3 className="text-small font-medium text-fg-2">What worked</h3>
        {wins.length ? wins.map((m) => <MortemCard key={m.id} m={m} tz={tz} />) : <EmptyState title="No breakouts yet" body="When a post reaches 2× your usual, the Analyst writes up why here." />}
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-small font-medium text-fg-2">What didn't</h3>
        {losses.length ? losses.map((m) => <MortemCard key={m.id} m={m} tz={tz} />) : <EmptyState title="No flops to learn from" body="When a post falls under 0.6× your usual, it gets the same depth of review here." />}
      </div>
    </div>
  );
}
