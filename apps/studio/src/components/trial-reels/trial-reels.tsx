"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, Film, LoaderCircle, Play, Sparkles } from "lucide-react";
import { Badge, Button, cn, Field, Input, Select, Textarea } from "@/components/ui";
import { Dialog } from "@/components/content/dialog";
import { Switch } from "@/components/settings/switch";
import { NOTICES } from "@/components/settings/notices";
import { saveSettingsAction } from "@/server/actions/settings";
import {
  cancelTrialReelsAction, confirmTrialProofAction, makeTrialReelsAction, retryTrialBatchAction, scheduleTrialReelsAction, trialBatchAction, trialFormAction,
} from "@/server/actions/trial-reels";
import type { TrialBatchView, TrialSettingsView, TrialSummary } from "@/server/queries/trial-reels";

/**
 * Trial reels in Studio: "Make trial reels" on a finished video (Edit) or a ready one (Calendar) opens this panel.
 * Form (the owner's title and caption line, hashtags from the topic, the day, how many) → progress while the worker
 * renders and checks them → the preview grid with the plan → "Schedule N trial reels" (the owner's OK). Trial reels
 * post on Instagram as trial reels only and never appear on the grid.
 */

export type TrialStart = { kind: "edit"; editRef: string; name: string } | { kind: "upload"; assetId: string; name: string } | { kind: "batch"; batchId: string };

type Ctx = { openTrial(start: TrialStart): void };
const TrialContext = createContext<Ctx | null>(null);

export function useTrialReels(): Ctx {
  return useContext(TrialContext) ?? { openTrial: () => {} };
}

export function TrialReelsProvider({ children }: { children: ReactNode }) {
  const [start, setStart] = useState<TrialStart | null>(null);
  const router = useRouter();
  const value = useMemo<Ctx>(() => ({ openTrial: setStart }), []);
  return (
    <TrialContext.Provider value={value}>
      {children}
      <TrialPanel
        start={start}
        onClose={() => {
          setStart(null);
          router.refresh();
        }}
      />
    </TrialContext.Provider>
  );
}

/** "Make trial reels" button for a video. */
export function MakeTrialButton({ start, size = "sm", variant = "ghost", className }: { start: TrialStart; size?: "sm" | "md"; variant?: "ghost" | "secondary"; className?: string }) {
  const { openTrial } = useTrialReels();
  return (
    <Button size={size} variant={variant} className={className} onClick={() => openTrial(start)}>
      <Sparkles className="size-3.5" strokeWidth={1.75} /> Make trial reels
    </Button>
  );
}

const STATUS: Record<TrialBatchView["status"], { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" | "brand" }> = {
  queued: { label: "Up next", tone: "neutral" },
  rendering: { label: "Making them", tone: "brand" },
  ready: { label: "Ready to check", tone: "info" },
  failed: { label: "Didn't pass", tone: "danger" },
  scheduling: { label: "Scheduling", tone: "brand" },
  proving: { label: "First one posted", tone: "warning" },
  scheduled: { label: "Scheduled", tone: "success" },
  partial: { label: "Partly scheduled", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

function clock(iso: string | null, tz: string): string {
  if (!iso) return "Right away";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
}
function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}
function every(window: { start: string; end: string }, n: number): string {
  if (n < 2) return "";
  const [sh, sm] = window.start.split(":").map(Number) as [number, number];
  const [eh, em] = window.end.split(":").map(Number) as [number, number];
  const mins = Math.round(((eh * 60 + em) - (sh * 60 + sm)) / (n - 1));
  const h = Math.floor(mins / 60);
  return `about every ${h ? `${h}h ` : ""}${mins % 60 ? `${mins % 60}m` : ""}`.trim();
}

// ───────────────────────────── the panel ─────────────────────────────

function TrialPanel({ start, onClose }: { start: TrialStart | null; onClose: () => void }) {
  const [batchId, setBatchId] = useState<string | null>(null);
  useEffect(() => setBatchId(start?.kind === "batch" ? start.batchId : null), [start]);
  const title = batchId ? "Trial reels" : start && start.kind !== "batch" ? `Trial reels of “${start.name}”` : "Trial reels";
  return (
    <Dialog open={Boolean(start)} onClose={onClose} title={title} size="lg" description="Trial reels go to people who don't follow you yet. They never appear on your grid.">
      {start && !batchId && start.kind !== "batch" ? <TrialForm start={start} onMade={setBatchId} /> : null}
      {batchId ? <BatchView batchId={batchId} onClose={onClose} /> : null}
    </Dialog>
  );
}

// ───────────────────────────── 1. the form ─────────────────────────────

function TrialForm({ start, onMade }: { start: Exclude<TrialStart, { kind: "batch" }>; onMade: (batchId: string) => void }) {
  const [settings, setSettings] = useState<TrialSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", other: "", captionLine: "", hashtags: "", layout: "talking-head" as "talking-head" | "split-screen", endAsk: "", date: "", total: 9 });
  const [pending, run] = useTransition();
  const source = start.kind === "edit" ? { kind: "edit" as const, editRef: start.editRef } : { kind: "upload" as const, assetId: start.assetId };

  useEffect(() => {
    let live = true;
    void trialFormAction(source).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.error);
      setSettings(r.settings);
      setKeyword(r.source?.keyword ?? null);
      if (r.source && !r.source.renderable) setBlocked("This video has no edit plan, so it can't be rendered again without its captions. Upload a clean version on Edit with “These are clean reels for trial reels” ticked.");
      setForm((f) => ({
        ...f,
        title: r.source?.title ?? "",
        captionLine: r.source?.suggestedCaptionLine ?? "",
        hashtags: (r.source?.suggestedHashtags ?? []).map((t) => `#${t}`).join(" "),
        date: r.settings.tomorrow,
        total: r.settings.dailyTotal,
      }));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.kind === "edit" ? start.editRef : start.assetId]);

  if (!settings) {
    return error ? <Problem text={error} /> : <Loading text="Getting the video's title and hashtags" />;
  }
  if (blocked) return <Problem text={blocked} />;
  const tags = form.hashtags.split(/[\s,]+/).filter(Boolean);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const sets = Object.entries(settings.hashtagSets);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        run(async () => {
          const r = await makeTrialReelsAction({
            source, title: form.title, otherWordings: form.other.split("\n").map((s) => s.trim()).filter(Boolean), captionLine: form.captionLine,
            hashtags: form.hashtags, layout: form.layout, endAsk: form.endAsk, date: form.date, total: Number(form.total),
          });
          if (r.ok) onMade(r.batchId);
          else setError(r.error);
        });
      }}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Title" htmlFor="tr-title" hint="Your title, in your words. Leave empty for no title on screen.">
          <Input id="tr-title" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={90} />
        </Field>
        <Field label="Other wordings (optional)" htmlFor="tr-other" hint="One per line, using the same words reordered.">
          <Textarea id="tr-other" value={form.other} onChange={(e) => set("other", e.target.value)} className="min-h-10" rows={2} />
        </Field>
      </div>
      <Field
        label="Caption line"
        htmlFor="tr-caption"
        hint={keyword ? `This video asks for a comment, so keep the keyword ${keyword.toUpperCase()} in it. Word for word, as you'd write it.` : "Optional, word for word. Leave empty to post hashtags only."}
      >
        <Input id="tr-caption" value={form.captionLine} onChange={(e) => set("captionLine", e.target.value)} maxLength={2000} />
      </Field>
      <Field label="Hashtags" htmlFor="tr-tags" hint={`${tags.length} about the topic (at least 5). Each post gets 5 of them, reshuffled.`} error={tags.length && tags.length < 5 ? "Add at least 5." : null}>
        <Input id="tr-tags" value={form.hashtags} onChange={(e) => set("hashtags", e.target.value)} placeholder="#topic #topic2 …" />
      </Field>
      {sets.length ? (
        <div className="-mt-3 flex flex-wrap gap-1.5">
          {sets.map(([name, list]) => (
            <Button key={name} size="sm" variant="ghost" onClick={() => set("hashtags", list.map((t) => `#${t}`).join(" "))}>
              Use “{name}”
            </Button>
          ))}
        </div>
      ) : null}
      <div className="grid gap-5 md:grid-cols-4">
        <Field label="Layout" htmlFor="tr-layout">
          <Select id="tr-layout" value={form.layout} onChange={(e) => set("layout", e.target.value as typeof form.layout)}>
            <option value="talking-head">Talking head</option>
            <option value="split-screen">Split screen</option>
          </Select>
        </Field>
        <Field label="End ask (optional)" htmlFor="tr-ask">
          <Input id="tr-ask" value={form.endAsk} onChange={(e) => set("endAsk", e.target.value)} maxLength={120} placeholder="On screen near the end" />
        </Field>
        <Field label="Day" htmlFor="tr-day">
          <Input id="tr-day" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} className="[color-scheme:dark]" />
        </Field>
        <Field label="How many" htmlFor="tr-n" hint="Up to 50 a day in total.">
          <Input id="tr-n" type="number" min={1} max={50} value={form.total} onChange={(e) => set("total", Number(e.target.value))} />
        </Field>
      </div>
      <p className="text-small text-fg-2">
        Each one is the same video with its own speed (up to 1.1×), colour, caption style, title style and position. They post {settings.window.start}–{settings.window.end} {settings.tz.replace(/_/g, " ")}, spread evenly. Nothing is scheduled until you look at them and say so.
      </p>
      {error ? <Problem text={error} /> : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending || tags.length < 5}>
          {pending ? "Starting…" : `Make ${form.total} trial reels`}
        </Button>
      </div>
    </form>
  );
}

// ───────────────────────────── 2. progress, preview, schedule ─────────────────────────────

const BUSY = new Set(["queued", "rendering", "scheduling"]);

function BatchView({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const [data, setData] = useState<{ batch: TrialBatchView; settings: TrialSettingsView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const r = await trialBatchAction(batchId);
    if (r.ok) {
      setData({ batch: r.batch, settings: r.settings });
      setError(null);
    } else setError(r.error);
    return r.ok ? r.batch : null;
  }, [batchId]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const b = await load();
      if (!live) return;
      const busy = b && (BUSY.has(b.status) || Boolean(b.progress));
      timer.current = setTimeout(tick, busy ? 2500 : 15_000);
    };
    void tick();
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  if (!data) return error ? <Problem text={error} /> : <Loading text="Loading" />;
  const { batch, settings } = data;
  const st = STATUS[batch.status];
  const act = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    run(async () => {
      setNote(null);
      const r = await fn();
      if (r.ok) setNote(r.message ?? null);
      else setError(r.error ?? "That didn't work.");
      await load();
    });
  const busy = BUSY.has(batch.status) || Boolean(batch.progress);
  const scheduledCount = batch.ledger.filter((l) => l.status === "scheduled" || l.status === "published").length;
  const left = batch.variants.length - scheduledCount;
  const firstOnly = batch.proofNeeded && batch.ledger.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-small text-fg-2">
          {batch.total} for {dayLabel(batch.date)} · {batch.sources.map((s) => `“${s.name}”`).join(", ")}
        </span>
      </div>

      {busy ? <Loading text={batch.progress ?? (batch.status === "queued" ? "Waiting for your editor to be free" : "Working")} sub="You can close this; it keeps going." /> : null}
      {batch.error && !busy ? <Problem text={batch.error} /> : null}
      {error ? <Problem text={error} /> : null}
      {note ? (
        <p className="flex items-center gap-1.5 text-small text-success">
          <CircleCheck className="size-4" strokeWidth={1.75} /> {note}
        </p>
      ) : null}

      {batch.variants.length ? (
        <>
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5" aria-label="Variations">
            {batch.variants.map((v) => {
              const sent = batch.ledger.find((l) => l.variantId === v.id);
              return (
                <li key={v.id} className="flex min-w-0 flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPlaying(playing === v.id ? null : v.id)}
                    className="group relative aspect-[9/16] w-full overflow-hidden rounded-md border border-border bg-surface-2"
                    aria-label={`Play ${v.id}`}
                  >
                    {playing === v.id && v.assetId ? (
                      <video src={`/api/media/${v.assetId}`} autoPlay controls playsInline className="size-full object-cover" />
                    ) : v.posterId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/media/${v.posterId}`} alt="" loading="lazy" className="size-full object-cover" />
                    ) : (
                      <Film className="absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-fg-3" />
                    )}
                    {playing !== v.id ? (
                      <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
                        <span className="grid size-8 place-items-center rounded-full bg-surface-1/90 text-fg">
                          <Play className="size-3.5 translate-x-px" fill="currentColor" />
                        </span>
                      </span>
                    ) : null}
                  </button>
                  <p className="flex items-center justify-between gap-1 text-caption tabular">
                    <span className="font-medium text-fg">{clock(v.at, settings.tz)}</span>
                    <span className="text-fg-3">{v.speed}×</span>
                  </p>
                  <p className="truncate text-caption text-fg-2" title={v.title || "No title"}>
                    {v.title || "No title"}
                  </p>
                  {sent ? <span className="text-caption text-fg-3">{sent.status === "scheduled" ? "Scheduled" : sent.status === "published" || sent.postStatus === "published" ? "Posted" : sent.status === "cancelled" ? "Cancelled" : sent.status === "failed" ? "Didn't go out" : "Sending"}</span> : null}
                </li>
              );
            })}
          </ul>

          <div className="rounded-lg border border-border bg-surface-2 p-4 text-small text-fg-2">
            <p>
              <span className="font-medium text-fg">{batch.variants.length} trial reels</span> on {dayLabel(batch.date)}, {settings.window.start} to {settings.window.end} {settings.tz.replace(/_/g, " ")}
              {batch.variants.length > 1 ? `, ${every(settings.window, batch.variants.length)}` : ""}, taking turns between videos. Instagram trial only, never on your grid. Graduation: {settings.graduation === "auto" ? "automatic when they do well" : "manual (you decide)"}.
            </p>
            {batch.sources.map((s) => {
              const sample = batch.variants.find((v) => v.reel === s.slug);
              return (
                <p key={s.slug} className="mt-2">
                  <span className="text-fg">“{s.name}”</span>: {batch.variants.filter((v) => v.reel === s.slug).length} variations · titles {s.titles.length ? s.titles.map((t) => `“${t}”`).join(", ") : "none"} · {s.layout}
                  {sample ? (
                    <span className="mt-1 block truncate text-fg-3" title={sample.caption}>
                      Sample caption: {sample.caption}
                    </span>
                  ) : null}
                </p>
              );
            })}
            {batch.timings?.renderS ? <p className="mt-2 text-caption text-fg-3 tabular">Rendered in {Math.round(batch.timings.renderS)}s and checked: format, length, captions, title and end ask.</p> : null}
          </div>
        </>
      ) : null}

      {batch.status === "failed" ? (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={() => act(() => cancelTrialReelsAction({ batchId: batch.id }))}>
            Discard
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => act(() => retryTrialBatchAction(batch.id))}>
            Make them again
          </Button>
        </div>
      ) : null}

      {(batch.status === "ready" || batch.status === "partial") && !busy ? (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          {!settings.ackAccepted ? <NoticeGate /> : null}
          {firstOnly ? (
            <p className="text-small text-fg-2">
              First time on this account: <span className="text-fg">one goes out right away</span>, so you can check it stays off your grid. The rest wait for that check.
            </p>
          ) : null}
          {confirming ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-small text-fg">
                {firstOnly ? "Post 1 trial reel now?" : `Schedule ${left} trial reels on ${dayLabel(batch.date)}?`}
              </span>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Not yet
              </Button>
              <Button
                variant="primary"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                  act(() => scheduleTrialReelsAction(batch.id));
                }}
              >
                Yes, schedule
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={pending} onClick={() => act(() => cancelTrialReelsAction({ batchId: batch.id }))}>
                Discard
              </Button>
              <Button variant="primary" disabled={pending || !settings.ackAccepted} onClick={() => setConfirming(true)}>
                {firstOnly ? "Post the first trial reel" : `Schedule ${left} trial reels`}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {batch.status === "proving" && !busy ? (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          {batch.proofNeeded ? (
            <>
              <p className="text-small text-fg-2">
                The first trial reel went out to check that trial reels stay off your grid.{" "}
                {batch.proofPost?.status === "published" ? (
                  <>It's live{batch.proofPost.url ? <> (<a href={batch.proofPost.url} target="_blank" rel="noreferrer" className="text-fg underline">open it</a>)</> : null}. Look at your profile: is it <span className="text-fg">not</span> on your grid?</>
                ) : (
                  "When it's live, look at your profile and come back here."
                )}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" disabled={pending} onClick={() => act(() => cancelTrialReelsAction({ batchId: batch.id }))}>
                  It's on my grid: stop
                </Button>
                <Button variant="primary" disabled={pending || batch.proofPost?.status !== "published"} onClick={() => act(() => confirmTrialProofAction(batch.proofPost!.postId))}>
                  It stayed off my grid
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-small text-fg-2">Checked: trial reels stay off your grid.</span>
              <Button variant="primary" disabled={pending} onClick={() => act(() => scheduleTrialReelsAction(batch.id))}>
                Schedule the other {left}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {(batch.status === "scheduled" || batch.status === "partial") && !busy ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <span className="mr-auto text-small text-fg-2">{scheduledCount} on your calendar, marked Trial reel.</span>
          <Button variant="ghost" disabled={pending} onClick={() => act(() => cancelTrialReelsAction({ batchId: batch.id }))}>
            Cancel the ones not live yet
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function NoticeGate() {
  const [on, setOn] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const n = NOTICES.trialReelsRisk!;
  return (
    <div className="rounded-lg border border-warning/40 bg-surface-2 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium text-fg">{n.title}: read this first</p>
          <p className="mt-1 text-small text-fg-2">{n.body}</p>
          {msg ? <p className="mt-2 text-caption text-fg-3">{msg}</p> : null}
        </div>
        <Switch
          checked={on}
          disabled={pending || on}
          label="Accept the trial reels notice"
          onChange={(v) =>
            run(async () => {
              const r = await saveSettingsAction([{ path: "acknowledgements.trialReelsRisk", value: v }]);
              if (r.ok) {
                setOn(true);
                setMsg(r.message ?? "Saved.");
              } else setMsg(r.error);
            })
          }
        />
      </div>
    </div>
  );
}

function Loading({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="flex items-start gap-2 text-small text-fg-2" role="status">
      <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-fg-3 motion-reduce:animate-none" strokeWidth={1.75} />
      <div>
        <p className="text-fg">{text}</p>
        {sub ? <p className="text-caption text-fg-3">{sub}</p> : null}
      </div>
    </div>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-small text-danger" role="alert">
      <CircleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} /> {text}
    </p>
  );
}

// ───────────────────────────── Edit page section ─────────────────────────────

/** Edit page: recent trial-reel batches and clean reels uploaded for them. Hidden when there's nothing to show. */
export function TrialReelsSection({ summary }: { summary: TrialSummary }) {
  const { openTrial } = useTrialReels();
  if (!summary.ready || (!summary.batches.length && !summary.cleanUploads.length)) return null;
  return (
    <section aria-labelledby="edit-trial">
      <h2 id="edit-trial" className="mb-3 text-h3 font-medium text-fg">
        Trial reels
      </h2>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
        {summary.cleanUploads.map((u) => (
          <li key={u.id} className="flex items-center gap-3 px-3 py-3">
            <Film className="size-4 shrink-0 text-fg-3" strokeWidth={1.5} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-small font-medium text-fg">{u.name}</p>
              <p className="text-caption text-fg-3">Clean reel, uploaded for trial reels</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => openTrial({ kind: "upload", assetId: u.id, name: u.name })}>
              <Sparkles className="size-3.5" strokeWidth={1.75} /> Make trial reels
            </Button>
          </li>
        ))}
        {summary.batches.map((b) => {
          const st = STATUS[b.status];
          return (
            <li key={b.id} className="flex items-center gap-3 px-3 py-3" data-trial={b.status}>
              <div className={cn("relative h-[52px] w-[30px] shrink-0 overflow-hidden rounded-[6px] border border-border bg-surface-2")}>
                {b.previewId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/media/${b.previewId}`} alt="" className="h-full w-full object-cover object-left" />
                ) : (
                  <Sparkles className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-fg-3" strokeWidth={1.5} aria-hidden />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-small font-medium text-fg">
                  {b.total} trial reels of {b.names.map((n) => `“${n}”`).join(", ")}
                </p>
                <p className="mt-0.5 flex items-center gap-2 text-caption text-fg-2">
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <span className="truncate">{b.progress ?? (b.error && b.status === "failed" ? b.error : dayLabel(b.date))}</span>
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => openTrial({ kind: "batch", batchId: b.id })}>
                Open
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
