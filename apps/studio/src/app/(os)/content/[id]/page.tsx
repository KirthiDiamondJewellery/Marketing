import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, ChevronLeft } from "lucide-react";
import { workspace } from "@/server/workspace";
import { contentDetail, contentOptions, laneOptions, type ContentDetail } from "@/server/queries/content";
import { Badge, buttonClass, cn } from "@/components/ui";
import { EmptyState, Facts, PlatformIcon, SectionHeader, StatusDot, postStatus } from "@/components/content/shared";
import { BoardActions } from "@/components/content/board-actions";
import { AssemblyHero } from "@/components/content/detail-hero";
import { CaptionTabs, ScriptPanel } from "@/components/content/script-panel";
import { EditPanel } from "@/components/content/edit-panel";
import { LIFECYCLE_LABEL, LIFECYCLE_STEPS } from "@/components/content/lifecycle";
import { FUNNEL_LABEL, fmtCompact, fmtDateTime, fmtPct, fmtRelative, fmtX, humanize, platformLabel } from "@/components/content/format";
import { Toaster } from "@/components/content/toast";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const d = await contentDetail(id);
  return { title: d?.title ?? "Studio" };
}

export default async function ContentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await contentDetail(id);
  if (!d) notFound();
  const ws = workspace();
  const tz = ws.config.workspace.timezone;
  const [lanes, options] = await Promise.all([laneOptions(), contentOptions()]);

  const script = d.scripts.find((s) => s.status === "approved") ?? d.scripts[0] ?? null;
  const caption = script?.captions ? pickCaption(script.captions) : null;
  const fresh = script ? Date.now() - new Date(script.createdAt).getTime() < 10 * 60_000 : false;
  const voiceScore = script?.validator?.checks?.length ? Math.round((script.validator.checks.filter((c) => c.ok).length / script.validator.checks.length) * 100) : undefined;
  const canUpload = ["idea", "scripted", "filming", "editing"].includes(d.status);

  const meta = [d.lane ? humanize(d.lane) : null, d.funnel ? FUNNEL_LABEL[d.funnel] : null, d.kind !== "reel" ? humanize(d.kind) : "Reel", d.postNumber ? `Post #${d.postNumber}` : null].filter(Boolean).join(" · ");

  return (
    <div>
      <Link href="/content" className={buttonClass("ghost", "sm", "-ml-3 mb-4 text-fg-2")}>
        <ChevronLeft className="size-4" />
        Studio
      </Link>

      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="mb-2 text-small text-fg-3">{meta}</p>
          <h1 className="text-h1 font-medium tracking-[-0.01em] text-fg">{d.title}</h1>
        </div>
        {canUpload ? (
          <div className="flex shrink-0 gap-2">
            <BoardActions lanes={lanes} options={options} defaultContentId={d.id} primary="upload" />
          </div>
        ) : (
          <Toaster />
        )}
      </header>

      <Stepper status={d.status} />

      {d.pending.length ? (
        <div className="mb-10 flex flex-col gap-2">
          {d.pending.map((p) => (
            <Link key={p.ref} href="/approvals" className="signal-left group flex items-center gap-3 rounded-md rounded-l-none border border-border bg-surface-1 px-4 py-3 text-small transition-colors hover:bg-surface-2">
              <span className="font-medium text-fg">Waiting for you</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">
                <span className="tabular">{p.ref}</span> · {p.summary}
              </span>
              <span className="hidden items-center gap-1 text-fg-2 group-hover:text-fg sm:inline-flex">
                Review <ArrowUpRight className="size-3.5" />
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      <div className={cn("mb-16 grid gap-10", caption ? "lg:grid-cols-[minmax(280px,340px)_1fr]" : "")}>
        {caption && script ? (
          <div className="flex justify-center rounded-lg border border-border bg-surface-1 px-6 py-8">
            <AssemblyHero image={d.thumbId ? `/api/media/${d.thumbId}` : null} caption={caption.text} platform={caption.platform} score={voiceScore} fresh={fresh} />
          </div>
        ) : null}
        <Brief d={d} tz={tz} />
      </div>

      <nav aria-label="Sections" className="sticky top-14 z-10 -mx-4 mb-10 flex gap-1 overflow-x-auto border-b border-border bg-bg px-4 md:top-0 md:mx-0 md:px-0">
        {[
          ["script", "Script"],
          ["captions", "Captions"],
          ["edit", "Edit"],
          ["posts", "Posts"],
        ].map(([href, label]) => (
          <a key={href} href={`#${href}`} className="whitespace-nowrap px-3 py-3 text-small text-fg-2 transition-colors hover:text-fg">
            {label}
          </a>
        ))}
      </nav>

      <section id="script" className="mb-16 scroll-mt-28">
        <SectionHeader title="Script" description={d.scripts.length ? `${d.scripts.length} version${d.scripts.length === 1 ? "" : "s"}, each checked line by line before it reaches you.` : undefined} />
        {d.scripts.length ? <ScriptPanel scripts={d.scripts} /> : <EmptyState title="No script yet" body="The Copywriter drafts one from the brief, with a claim ledger and a validator check, then sends it for your approval." />}
      </section>

      <section id="captions" className="mb-16 scroll-mt-28">
        <SectionHeader title="Captions" description="One transcript, written for each platform's rules." />
        {script?.captions && Object.keys(script.captions).length ? <CaptionTabs captions={script.captions} /> : <EmptyState title="No captions yet" body="Captions are written with the script, one per platform." />}
      </section>

      <section id="edit" className="mb-16 scroll-mt-28">
        <SectionHeader title="Edit" description={d.edits.length ? "The Art Director’s cut, its quality check and your notes." : undefined} />
        {d.edits.length ? (
          <div className="flex flex-col gap-14">
            {d.edits.map((e) => (
              <EditPanel key={e.id} job={e} poster={d.thumbId ? `/api/media/${d.thumbId}` : null} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No footage yet"
            body={d.status === "filming" || d.status === "scripted" ? "Film the script, then upload the take. The Art Director preps a cut list for you to review." : "The edit starts when footage is uploaded for this piece."}
          />
        )}
      </section>

      <section id="posts" className="mb-8 scroll-mt-28">
        <SectionHeader title="Posts" description={d.posts.length ? "Where it goes out and how it did against your usual." : undefined} />
        <Posts d={d} tz={tz} />
      </section>
    </div>
  );
}

function pickCaption(c: NonNullable<ContentDetail["scripts"][number]["captions"]>): { platform: string; text: string } | null {
  for (const p of ["instagram", "tiktok", "linkedin", "youtube", "facebook", "x", "threads"]) {
    const v = c[p] as Record<string, unknown> | undefined;
    if (!v) continue;
    const text = String(v.caption ?? v.text ?? v.description ?? "");
    if (!text) continue;
    const tags = Array.isArray(v.hashtags) ? (v.hashtags as string[]).map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ") : "";
    return { platform: p, text: tags ? `${text}\n\n${tags}` : text };
  }
  return null;
}

function Stepper({ status }: { status: string }) {
  const idx = LIFECYCLE_STEPS.indexOf(status as (typeof LIFECYCLE_STEPS)[number]);
  const needs = status === "filming" || status === "review";
  return (
    <ol className="mb-10 grid grid-cols-8 gap-1.5" aria-label="Lifecycle">
      {LIFECYCLE_STEPS.map((s, i) => {
        const done = idx > i;
        const now = idx === i;
        return (
          <li key={s} className="flex min-w-0 flex-col gap-2" aria-current={now ? "step" : undefined}>
            <span className={cn("h-[2px] rounded-full", now ? (needs ? "bg-brand" : "bg-fg") : done ? "bg-fg-3" : "bg-border")} />
            <span className={cn("truncate text-caption", now ? "font-medium text-fg" : done ? "text-fg-2" : "text-fg-3", !now && "max-sm:hidden")}>{LIFECYCLE_LABEL[s]}</span>
          </li>
        );
      })}
      {status === "archived" ? <li className="col-span-8 text-caption text-fg-3">Archived</li> : null}
    </ol>
  );
}

function Brief({ d, tz }: { d: ContentDetail; tz: string }) {
  const filmSoon = d.filmBy && new Date(d.filmBy).getTime() - Date.now() < 36 * 3600_000 && ["scripted", "filming", "idea"].includes(d.status);
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div>
        <h2 className="mb-3 text-h2 font-medium text-fg">Brief</h2>
        <p className="max-w-[62ch] text-body text-fg-2">
          {d.brief?.why ?? (d.angle ? `${d.angle}: ${d.hook?.text ?? d.title}` : "The Strategist hasn’t written a brief for this piece yet.")}
        </p>
        {d.brief?.shoot_directions?.length ? (
          <ul className="mt-4 flex flex-col gap-1.5 text-small text-fg-2">
            {d.brief.shoot_directions.map((s) => (
              <li key={s} className="flex gap-2">
                <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-fg-3" />
                {s}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Facts
        items={[
          ...(d.filmBy
            ? [{ label: "Film by", value: <span className={filmSoon ? "text-warning" : undefined}>{fmtDateTime(d.filmBy, tz)}{d.brief?.deadline_label ? <span className="text-fg-3"> · {d.brief.deadline_label}</span> : null}</span> }]
            : []),
          { label: "Lane", value: d.lane ? humanize(d.lane) : <span className="text-fg-3">Not set</span> },
          { label: "Funnel stage", value: d.funnel ? FUNNEL_LABEL[d.funnel] : <span className="text-fg-3">Not set</span> },
          { label: "Angle", value: d.angle ?? <span className="text-fg-3">Not set</span> },
          {
            label: "Hook",
            value: d.hookPattern ? (
              <span>
                {humanize(d.hookPattern)}
                {d.hook ? (
                  <span className="block text-caption text-fg-3">
                    {d.hook.origin === "own" ? "Your own bank" : d.hook.origin === "competitor" ? "Competitor bank, structure only" : "Written by hand"}
                    {d.hook.uses ? ` · used ${d.hook.uses}×, ${d.hook.wins} win${d.hook.wins === 1 ? "" : "s"}` : ""}
                    {d.hook.sourceLabel ? ` · ${d.hook.sourceLabel}` : ""}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-fg-3">Picked with the script</span>
            ),
          },
          ...(d.storyStructure ? [{ label: "Structure", value: humanize(d.storyStructure) }] : []),
          ...(d.template ? [{ label: "Format", value: humanize(d.template) }] : []),
          {
            label: "Keyword",
            value: d.keyword ? (
              <span className="inline-flex items-center gap-2">
                <span className="font-medium tracking-wide">{d.keyword.word}</span>
                <Badge tone={d.keyword.status === "active" ? "success" : "neutral"}>{d.keyword.status === "active" ? "Live" : humanize(d.keyword.status)}</Badge>
              </span>
            ) : (
              <span className="text-fg-3">None</span>
            ),
          },
          ...(d.ctaType ? [{ label: "Call to action", value: humanize(d.ctaType) }] : []),
          ...(d.leadMagnet ? [{ label: "Lead magnet", value: d.leadMagnet.url ? <a href={d.leadMagnet.url} target="_blank" rel="noreferrer" className="hover:text-brand-fg">{d.leadMagnet.title}</a> : d.leadMagnet.title }] : []),
        ]}
      />
      {d.sources.length ? (
        <div>
          <h3 className="mb-2 text-small font-medium text-fg">Why this exists</h3>
          <ul className="flex flex-col gap-2">
            {d.sources.map((s, i) => (
              <li key={i} className="text-small">
                <span className="text-fg-3">{s.type}: </span>
                {s.href ? (
                  <Link href={s.href} className="text-fg hover:text-brand-fg">
                    {s.label}
                  </Link>
                ) : (
                  <span className="text-fg">{s.label}</span>
                )}
                {s.detail ? <span className="text-fg-3"> · {s.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Posts({ d, tz }: { d: ContentDetail; tz: string }) {
  if (!d.posts.length) {
    return <EmptyState title="Not scheduled yet" body="When the edit is approved, the Publisher slots it into the week and it shows up on the calendar." action={<Link href="/calendar" className={buttonClass("secondary")}>Open the calendar</Link>} />;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
      <table className="w-full text-left text-small max-md:block">
        <thead className="border-b border-border text-caption text-fg-3 max-md:hidden">
          <tr>
            <th className="px-4 py-3 font-normal">Platform</th>
            <th className="px-4 py-3 font-normal">Status</th>
            <th className="px-4 py-3 font-normal">When</th>
            <th className="px-4 py-3 text-right font-normal">Views</th>
            <th className="px-4 py-3 text-right font-normal">Comments</th>
            <th className="px-4 py-3 text-right font-normal">Leads</th>
            <th className="px-4 py-3 text-right font-normal">Completion</th>
            <th className="px-4 py-3 text-right font-normal">vs your usual</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border max-md:block">
          {d.posts.map((p) => {
            const st = postStatus(p.status);
            const m = p.metrics;
            return (
              <tr key={p.id} className="max-md:grid max-md:grid-cols-2 max-md:gap-x-4 max-md:gap-y-1 max-md:p-4">
                <td className="px-4 py-3 max-md:p-0">
                  <span className="inline-flex items-center gap-2 text-fg">
                    <PlatformIcon platform={p.platform} />
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-brand-fg">
                        {platformLabel(p.platform)}
                      </a>
                    ) : (
                      platformLabel(p.platform)
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 max-md:p-0 max-md:text-right">
                  <StatusDot tone={st.tone} label={st.label} />
                  {p.error ? <span className="mt-0.5 block text-caption text-danger">{p.error}</span> : null}
                </td>
                <td className="px-4 py-3 text-fg-2 max-md:col-span-2 max-md:p-0">{p.status === "published" ? `Published ${fmtRelative(p.at)}` : p.at ? fmtDateTime(p.at, tz) : "Not slotted"}</td>
                <td className="px-4 py-3 text-right tabular text-fg max-md:p-0 max-md:text-left">
                  <span className="text-fg-3 md:hidden">Views </span>
                  {m ? fmtCompact(m.views) : "–"}
                </td>
                <td className="px-4 py-3 text-right tabular text-fg max-md:hidden">{m ? fmtCompact(m.comments) : "–"}</td>
                <td className="px-4 py-3 text-right tabular text-fg max-md:p-0">
                  <span className="text-fg-3 md:hidden">Leads </span>
                  {m ? fmtCompact(m.leads) : "–"}
                </td>
                <td className="px-4 py-3 text-right tabular text-fg-2 max-md:hidden">{m?.completion !== null && m?.completion !== undefined ? fmtPct(m.completion) : "–"}</td>
                <td className={cn("px-4 py-3 text-right tabular font-medium max-md:col-span-2 max-md:p-0 max-md:text-left", m?.x == null ? "text-fg-3" : m.x >= 2 ? "text-brand-fg" : m.x < 0.6 ? "text-danger" : "text-fg")}>
                  <span className="font-normal text-fg-3 md:hidden">vs your usual </span>
                  {m?.x != null ? fmtX(m.x) : "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
