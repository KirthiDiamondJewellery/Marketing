// Unfinished feature: Home's "film today" brief (what to shoot today, with format and shoot directions). Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
import Link from "next/link";
import { Camera, Clock } from "lucide-react";
import type { FilmItem } from "@/server/queries/home";
import { Badge } from "@/components/ui";

/** Today's brief: what to shoot, with the header, format and shoot directions (DESIGN voice: show the work). */
export function FilmToday({ items, tz }: { items: FilmItem[]; tz: string }) {
  if (!items.length) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
        <p className="text-h3 font-medium text-fg">Nothing to film today</p>
        <p className="mx-auto mt-1 max-w-sm text-small text-fg-2">The Strategist plans tomorrow's slate each morning. Ask for one now from the Strategist's page.</p>
        <Link href="/agents/strategist" className="mt-4 inline-flex h-9 items-center rounded-md border border-border-strong px-4 text-[14px] font-medium text-fg hover:bg-surface-2">
          Plan today's filming
        </Link>
      </div>
    );
  }
  return (
    <ol className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
      {items.map((f, i) => {
        const urgent = !!f.deadline && /today|tonight/i.test(f.deadline);
        return (
          <li key={f.id} className="flex flex-col rounded-lg border border-border bg-surface-1 p-6">
            <div className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-full bg-surface-3 text-caption font-medium text-fg-2 tabular" aria-label={`Shot ${i + 1}`}>
                {i + 1}
              </span>
              <span className="text-small text-fg-3">{f.format}</span>
              {f.keyword ? <Badge tone="neutral" className="ml-auto font-mono text-[11px] tracking-normal">{f.keyword}</Badge> : null}
            </div>
            <h3 className="mt-4 text-[19px] font-medium leading-[26px] tracking-[-0.005em] text-fg">{f.header}</h3>
            {f.why ? <p className="mt-1.5 text-small text-fg-2">{f.why}</p> : null}
            {f.hook && f.hook !== f.header ? (
              <p className="mt-4 border-l border-border-strong pl-3 text-small italic text-fg-2">“{f.hook}”</p>
            ) : null}
            {f.directions.length ? (
              <ul className="mt-5 flex flex-col gap-2">
                {f.directions.map((d) => (
                  <li key={d} className="flex items-start gap-2.5 text-small text-fg">
                    <Camera className="mt-0.5 size-3.5 shrink-0 text-fg-3" strokeWidth={1.5} />
                    {d}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-auto flex items-center justify-between gap-3 pt-6">
              {f.deadline ? (
                <span className={urgent ? "inline-flex items-center gap-1.5 text-small font-medium text-warning" : "inline-flex items-center gap-1.5 text-small text-fg-2"}>
                  <Clock className="size-3.5" strokeWidth={1.75} />
                  {f.deadline}
                </span>
              ) : f.filmBy ? (
                <span className="text-small text-fg-2">
                  Film by {new Date(f.filmBy).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz })}
                </span>
              ) : (
                <span />
              )}
              <Link href={`/content/${f.id}`} className="text-small text-fg-2 underline decoration-border-strong underline-offset-4 transition-colors hover:text-fg">
                Open script
              </Link>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
