import type { Metadata } from "next";
import Link from "next/link";
import { getHomeData } from "@/server/queries/home";
import { getPipeline } from "@/server/queries/pipeline";
import { getApprovalQueue, getSocialHandles } from "@/server/queries/approvals";
import { workspace } from "@/server/workspace";
import { buttonClass } from "@/components/ui";
import { PageHeader, SectionTitle } from "@/components/shell/page-header";
import { HeadsUp, Results } from "@/components/home/results";
import { NextUp, PipelineTiles } from "@/components/home/pipeline";
import { ApprovalQueue } from "@/components/approvals/approval-queue";
import { AutoRefresh } from "@/components/production/auto-refresh";

export const metadata: Metadata = { title: "Home" };
export const dynamic = "force-dynamic";

function greeting(tz: string): { hello: string; date: string } {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
  const hello = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const date = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
  return { hello, date };
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Home: where everything stands, the one thing to do next, and anything else that needs a decision. */
export default async function HomePage() {
  const ws = workspace();
  const tz = ws.config.workspace.timezone;
  const [data, p, queue, handles] = await Promise.all([
    getHomeData(),
    getPipeline(),
    getApprovalQueue({ status: "pending", limit: 50 }).catch(() => ({ items: [], total: 0 })),
    getSocialHandles().catch(() => ({})),
  ]);
  const { hello, date } = greeting(tz);
  // Scripts and videos are decided on their own pages; everything else (the daily brief, posting plans, replies) here.
  const other = queue.items.filter((a) => a.kind !== "script" && a.kind !== "edit");

  const next =
    p.videos.needsReview > 0
      ? { href: "/edit", label: `Review ${n(p.videos.needsReview, "video")}` }
      : p.scripts.needsOk > 0
        ? { href: "/scripts", label: `Review ${n(p.scripts.needsOk, "script")}` }
        : p.scripts.readyToFilm > 0
          ? { href: "/scripts", label: `Film ${n(p.scripts.readyToFilm, "script")}` }
          : p.videos.readyToPost > 0
            ? { href: "/calendar#ready", label: `Schedule ${n(p.videos.readyToPost, "video")}` }
            : { href: "/scripts?new=1", label: "Get a script" };

  const summary = [
    p.videos.needsReview ? `${n(p.videos.needsReview, "video")} to review` : null,
    p.scripts.needsOk ? `${n(p.scripts.needsOk, "script")} to approve` : null,
    p.scripts.readyToFilm ? `${n(p.scripts.readyToFilm, "script")} ready to film` : null,
    p.posts.scheduledWeek ? `${n(p.posts.scheduledWeek, "post")} going out this week` : null,
  ].filter(Boolean);

  return (
    <div className="@container">
      <AutoRefresh active={p.scripts.writing + p.videos.editing > 0} everyMs={8000} agents={["copywriter", "art_director", "publisher"]} />
      <PageHeader
        meta={date}
        title={hello}
        description={summary.length ? `${summary.join(", ")}.` : "Nothing needs you right now. Ask for a script, or upload footage to edit."}
        actions={
          <Link href={next.href} className={buttonClass("primary", "md")}>
            {next.label}
          </Link>
        }
      />

      <PipelineTiles p={p} />

      {other.length ? (
        <section aria-labelledby="needs-you" className="mt-12">
          <SectionTitle id="needs-you" count={other.length}>
            Needs your OK
          </SectionTitle>
          <ApprovalQueue items={other} handles={handles} tz={tz} />
        </section>
      ) : null}

      <div className="mt-12 grid grid-cols-1 gap-12 @5xl:grid-cols-12 @5xl:gap-6">
        <section aria-labelledby="next-up" className="@5xl:col-span-5">
          <SectionTitle id="next-up" action={<Link href="/calendar" className="text-small text-fg-2 hover:text-fg">Calendar</Link>}>
            Going out next
          </SectionTitle>
          <NextUp items={p.next} tz={tz} />
        </section>
        <section aria-labelledby="results" className="flex flex-col @5xl:col-span-7">
          <SectionTitle id="results" action={<Link href="/analytics" className="text-small text-fg-2 hover:text-fg">Analytics</Link>}>
            How it's doing
          </SectionTitle>
          <div className="flex-1">
            <Results results={data.results} />
          </div>
        </section>
      </div>

      {data.alerts.length ? (
        <section aria-labelledby="heads-up" className="mt-12">
          <SectionTitle id="heads-up" count={data.alerts.length}>
            Heads up
          </SectionTitle>
          <HeadsUp alerts={data.alerts} />
        </section>
      ) : null}
    </div>
  );
}
