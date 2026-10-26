"use client";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AgentKey } from "@attentionos/core";
import { Button, cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { AGENT_INFO, AGENT_ORDER } from "@/components/agents/meta";
import { AgentMonogram, SignalLine, WakeTheTeam } from "@/motion";
import type { AgentLive } from "@/lib/live";
import type { BoardRun, StartBoard } from "@/server/onboarding";
import { completeStepAction, startAction } from "@/server/actions/onboarding";
import { StatusLine, StepFooter, StepHeader, useRefreshWhile } from "./parts";
import type { StepProps } from "./wizard";

const NAMES: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn", x: "X", facebook: "Facebook", threads: "Threads" };
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const active = (r: BoardRun | undefined) => r?.status === "queued" || r?.status === "running";

type Tone = "ok" | "work" | "wait" | "warn" | "off";
type Row = { id: string; agent: AgentKey; title: string; headline: string; detail?: ReactNode; tone: Tone };

/** Plain words for why a competitor scan didn't run. */
const SCAN_SKIPPED: Record<string, string> = {
  no_scraper: "No scraper is set up, so nothing was scanned. Add your Apify token in Keys.",
  needs_acknowledgement: "Waiting for the scraping notice (Competitors step).",
  budget: "Skipped: this month's scraping budget is used up.",
  no_creators: "No creators to scan yet.",
};

function speechProblem(err: string | null): string | null {
  if (!err) return null;
  if (/speech|asr|whisper|model|doctor/i.test(err)) return "Speech-to-text isn't set up on this computer yet (run `attentionos doctor --fix`). Your voice is learned from captions for now.";
  if (/download|media|unavailable/i.test(err)) return "Some videos couldn't be downloaded, so those posts use their captions.";
  return null;
}

export function boardRows(view: StepProps["view"], b: StartBoard): Row[] {
  const d = view.state.data;
  const r = b.runs;
  const notes = d.start.notes;
  const importOut = (r.import?.output ?? {}) as { notes?: string[]; transcriptionsQueued?: number };
  const platforms = Object.entries(b.own.byPlatform).map(([p, n]) => `${NAMES[p] ?? p} ${n}`);

  const ownRow: Row = active(r.import)
    ? { id: "own", agent: "analyst", title: "Your posts", headline: r.import?.progress ?? "Pulling your posts", tone: "work" }
    : b.own.posts
      ? { id: "own", agent: "analyst", title: "Your posts", headline: `Pulled ${b.own.posts.toLocaleString()} of your posts`, detail: platforms.join(" · "), tone: "ok" }
      : r.import?.status === "failed"
        ? { id: "own", agent: "analyst", title: "Your posts", headline: "Couldn't bring in your posts", detail: r.import.error ?? undefined, tone: "warn" }
        : { id: "own", agent: "analyst", title: "Your posts", headline: r.import ? "No posts came back yet" : "Waiting to start", detail: importOut.notes?.[0] ?? notes[0], tone: r.import ? "warn" : "wait" };

  const queuedOwn = b.own.transcribed + b.own.transcribing + b.own.noTranscript;
  const problem = speechProblem(b.transcription.firstError);
  const txRow: Row =
    b.own.transcribing > 0
      ? { id: "tx", agent: "art_director", title: "Transcripts", headline: `Transcribed ${b.own.transcribed} of ${queuedOwn} of your videos`, detail: problem ?? (b.competitors.transcribed ? `${plural(b.competitors.transcribed, "competitor outlier")} transcribed too` : undefined), tone: "work" }
      : b.own.transcribed
        ? { id: "tx", agent: "art_director", title: "Transcripts", headline: `Transcribed ${b.own.transcribed} of your videos`, detail: [b.competitors.transcribed ? `${plural(b.competitors.transcribed, "competitor outlier")} too` : "", b.own.noTranscript ? `${b.own.noTranscript} had no usable audio` : ""].filter(Boolean).join(" · ") || undefined, tone: "ok" }
        : queuedOwn
          ? { id: "tx", agent: "art_director", title: "Transcripts", headline: "No transcripts yet", detail: problem ?? "The videos couldn't be transcribed; your voice is learned from captions.", tone: "warn" }
          : { id: "tx", agent: "art_director", title: "Transcripts", headline: active(r.import) ? "Waiting for your posts" : "Nothing to transcribe", detail: active(r.import) ? undefined : "Transcripts need video links, which come with the Apify import.", tone: active(r.import) ? "wait" : "off" };

  const scanSkipped = (r.scan?.output as { skipped?: string } | null)?.skipped;
  const compRow: Row = active(r.scan)
    ? { id: "comp", agent: "analyst", title: "Competitors", headline: r.scan?.progress ?? "Scanning the creators you picked", detail: b.competitors.posts ? `${plural(b.competitors.posts, "post")} read so far` : undefined, tone: "work" }
    : r.scan?.status === "failed"
      ? { id: "comp", agent: "analyst", title: "Competitors", headline: "The scan stopped", detail: r.scan.error ?? undefined, tone: "warn" }
      : scanSkipped
        ? { id: "comp", agent: "analyst", title: "Competitors", headline: "Not scanned", detail: SCAN_SKIPPED[scanSkipped] ?? scanSkipped, tone: "warn" }
        : r.scan
          ? {
              id: "comp",
              agent: "analyst",
              title: "Competitors",
              headline: b.competitors.outliers ? `Found ${plural(b.competitors.outliers, "outlier")} across ${plural(b.competitors.outlierCreators, "creator")}` : `Read ${plural(b.competitors.posts, "post")}; no outliers yet`,
              detail: `${plural(b.competitors.creatorsScanned, "creator")} scanned`,
              tone: "ok",
            }
          : { id: "comp", agent: "analyst", title: "Competitors", headline: d.strategy.competitors.length ? "Waiting for a scraper" : "No competitors picked", detail: notes.find((n) => /competitor|scan/i.test(n)), tone: "off" };

  const site = d.business.runId ? view.runs[d.business.runId] : r.site;
  const siteRow: Row = !d.business.url
    ? { id: "site", agent: "analyst", title: "Your website", headline: "No website given", detail: "You can fill in your offers by hand in Review.", tone: "off" }
    : site?.status === "queued" || site?.status === "running"
      ? { id: "site", agent: "analyst", title: "Your website", headline: site.progress ?? "Reading your website", tone: "work" }
      : site?.status === "failed"
        ? { id: "site", agent: "analyst", title: "Your website", headline: "Couldn't read the site", detail: site.error ?? undefined, tone: "warn" }
        : d.business.draft
          ? {
              id: "site",
              agent: "analyst",
              title: "Your website",
              headline: d.business.draft.offers.length ? `Drafted ${plural(d.business.draft.offers.length, "offer")} and your ideal customer` : "Read your website, but found no offers to draft",
              detail: d.business.draft.oneLiner || d.business.draft.summary[0] || undefined,
              tone: d.business.draft.offers.length ? "ok" : "warn",
            }
          : { id: "site", agent: "analyst", title: "Your website", headline: "Queued", tone: "wait" };

  const voice = r.voice;
  const voiceRow: Row = d.voice.draft && (!voice || voice.status === "succeeded")
    ? { id: "voice", agent: "copywriter", title: "Your voice", headline: "Voice profile drafted", detail: d.voice.draft.oneLine || undefined, tone: "ok" }
    : active(voice)
      ? { id: "voice", agent: "copywriter", title: "Your voice", headline: voice?.progress ?? "Learning how you talk", tone: "work" }
      : voice?.status === "failed"
        ? { id: "voice", agent: "copywriter", title: "Your voice", headline: "Couldn't draft your voice yet", detail: voice.error ?? undefined, tone: "warn" }
        : { id: "voice", agent: "copywriter", title: "Your voice", headline: b.own.transcribing ? "Waiting for your transcripts" : "Waiting for your posts", tone: "wait" };

  const idx = r.index;
  const indexRow: Row = active(idx)
    ? { id: "index", agent: "analyst", title: "Search index", headline: idx?.progress ?? "Indexing your workspace", tone: "work" }
    : idx?.status === "succeeded"
      ? { id: "index", agent: "analyst", title: "Search index", headline: idx.progress ?? "Indexed your workspace for search", tone: "ok" }
      : idx?.status === "failed"
        ? { id: "index", agent: "analyst", title: "Search index", headline: "Indexing didn't finish", detail: idx.error ?? undefined, tone: "warn" }
        : { id: "index", agent: "analyst", title: "Search index", headline: "Runs once the posts are in", tone: "wait" };

  return [ownRow, txRow, compRow, siteRow, voiceRow, indexRow];
}

function BoardCard({ row }: { row: Row }) {
  const info = AGENT_INFO[row.agent];
  return (
    <li className={cn("flex items-start gap-3 rounded-lg border border-border bg-surface-1 p-4", row.tone === "work" && "signal-left")}>
      <AgentMonogram agent={{ monogram: info.monogram, name: info.name, state: row.tone === "work" ? "working" : row.tone === "warn" ? "blocked" : "idle" }} size={32} />
      <div className="min-w-0 flex-1">
        <p className="text-caption text-fg-3">
          {row.title} · {info.name}
        </p>
        <p className="mt-0.5 text-body text-fg">{row.headline}</p>
        {row.detail ? (
          <div className="mt-1">
            <StatusLine tone={row.tone === "warn" ? "warn" : "off"}>{row.detail}</StatusLine>
          </div>
        ) : null}
        {row.tone === "work" ? <SignalLine pulse className="mt-3 !w-24" /> : null}
      </div>
    </li>
  );
}

const since = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** Step 5: queue the first work, then watch it happen. The owner can move on while it runs. */
export function StartStep({ view, nav }: StepProps) {
  const toast = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [woke, setWoke] = useState(false);
  const d = view.state.data;
  const b = view.board;
  const started = Boolean(d.start.at);
  const rows = useMemo(() => (b ? boardRows(view, b) : []), [b, view]);
  const working = rows.some((r) => r.tone === "work") || Boolean(b && Object.values(b.runs).some((r) => active(r)));
  useRefreshWhile(started && working, 3000);

  const agents = useMemo<AgentLive[]>(
    () => AGENT_ORDER.map((key) => ({ key, name: AGENT_INFO[key].name, monogram: AGENT_INFO[key].monogram, role: AGENT_INFO[key].role, state: "idle", label: "", autonomy: "review_all", enabled: true, pendingApprovals: 0, run: null, runs24h: 0, costTodayUsd: 0 })),
    [],
  );

  const handles = Object.keys(NAMES).filter((p) => (d.content.handles as Record<string, string | undefined>)[p]).map((p) => NAMES[p]!);
  const comps = d.strategy.competitors.length;
  const keys = view.keys;
  const plan: { agent: AgentKey; text: string; note?: string }[] = [
    {
      agent: "analyst",
      text: `Bring in your recent posts from ${list(handles) || "your accounts"}`,
      ...(!keys.APIFY_TOKEN && !keys.ZERNIO_API_KEY ? { note: "Needs an Apify token or a Zernio key (Keys step)" } : !keys.APIFY_TOKEN ? { note: "Through Zernio: captions and numbers, no video files" } : {}),
    },
    { agent: "art_director", text: "Transcribe your best 15 videos and the top competitor outliers", ...(!keys.APIFY_TOKEN ? { note: "Video files come with the Apify import" } : {}) },
    { agent: "copywriter", text: "Learn your voice from those transcripts and your captions" },
    { agent: "analyst", text: comps ? `Scan ${plural(comps, "creator")} for posts that beat their usual` : "Scan competitors (none picked yet)", ...(comps && !keys.APIFY_TOKEN ? { note: "Waits for your Apify token" } : {}) },
    { agent: "analyst", text: d.business.url ? "Finish reading your website (started already)" : "No website to read; you can fill in offers in Review" },
    { agent: "analyst", text: "Index everything so every agent can search it" },
  ];

  const go = () =>
    start(async () => {
      const r = await startAction().catch(() => ({ ok: false as const, error: "Studio couldn't reach the server. Try again." }));
      if (!r.ok) return void toast(r.error, "error");
      setWoke(true);
      router.refresh();
    });

  if (!started) {
    return (
      <div className="flex flex-1 flex-col">
        <StepHeader title="Ready when you are" lede="Here's what your team does when you press Start. It takes a few minutes, and you can keep going while it runs." />
        <ol className="mx-auto mt-10 flex w-full max-w-[680px] flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
          {plan.map((p) => (
            <li key={p.text} className="flex items-start gap-3 p-4">
              <AgentMonogram agent={{ monogram: AGENT_INFO[p.agent].monogram, name: AGENT_INFO[p.agent].name, state: "idle" }} size={24} />
              <div className="min-w-0 flex-1">
                <p className="text-body text-fg">{p.text}</p>
                {p.note ? <p className="text-small text-warning">{p.note}</p> : null}
              </div>
            </li>
          ))}
        </ol>
        <p className="mx-auto mt-4 max-w-[680px] text-small text-fg-2">
          Scraping stays inside your monthly budget. Everything the agents draft waits for your OK in the next step.
        </p>
        <div className="mx-auto w-full max-w-[680px]">
          <StepFooter busy={nav.busy || pending} onBack={nav.back} primary={{ label: pending ? "Starting" : "Start", onClick: go }} />
        </div>
      </div>
    );
  }

  const ready = Boolean(d.business.draft || d.voice.draft);
  // Notes a card already shows aren't repeated underneath.
  const shown = new Set(rows.map((r) => (typeof r.detail === "string" ? r.detail : "")));
  const otherNotes = d.start.notes.filter((n) => !shown.has(n));
  return (
    <div className="flex flex-1 flex-col">
      {woke ? <WakeTheTeam agents={agents} force tasks={rows.filter((r) => r.tone === "work" || r.tone === "wait").length} /> : null}
      <StepHeader
        title={working ? "Your team is on it" : "First pass done"}
        lede={working ? "This page updates as they work. Carry on whenever you like; drafts appear in Review as soon as they're ready." : "Here's what they found. Your drafts are waiting in Review."}
      />

      {b ? (
        <>
          <ul className="mt-10 grid gap-3 md:grid-cols-2" aria-live="polite">
            {rows.map((row) => (
              <BoardCard key={row.id} row={row} />
            ))}
          </ul>
          {otherNotes.length ? (
            <ul className="mt-4 flex flex-col gap-1">
              {otherNotes.map((n) => (
                <li key={n}>
                  <StatusLine tone="warn">{n}</StatusLine>
                </li>
              ))}
            </ul>
          ) : null}
          {b.events.length ? (
            <section className="mt-8" aria-labelledby="feed-title">
              <h2 id="feed-title" className="text-small font-medium text-fg-2">
                Latest from the team
              </h2>
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {b.events.map((e) => {
                  const info = AGENT_INFO[e.agent as AgentKey];
                  return (
                    <li key={e.id} className="flex items-center gap-3 py-2">
                      {info ? <AgentMonogram agent={{ monogram: info.monogram, name: info.name, state: "idle" }} size={24} /> : <span className="size-6" />}
                      <span className="min-w-0 flex-1 truncate text-small text-fg">{e.message}</span>
                      <span className="shrink-0 text-caption text-fg-3 tabular">{since(e.at)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      <StepFooter
        busy={nav.busy || pending}
        onBack={nav.back}
        secondary={
          working ? null : (
            <Button variant="ghost" className="h-11 md:h-9" disabled={pending} onClick={go}>
              Run it again
            </Button>
          )
        }
        primary={{ label: ready ? "Review the drafts" : "Continue while they work", onClick: () => void nav.finish(() => completeStepAction("start")) }}
      />
    </div>
  );
}
