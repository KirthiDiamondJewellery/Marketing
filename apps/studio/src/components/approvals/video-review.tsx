"use client";
import { forwardRef, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, CircleAlert, MessageSquarePlus, Pause, Play, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import type { ApprovalView, PreviewModel, VideoReview } from "@/server/queries/approvals";
import { approveVideoAction, decideApprovalAction, requestVideoChangesAction } from "@/server/actions/approvals";
import { Badge, Button, Textarea, cn } from "@/components/ui";
import { AgentMonogram, PlatformGlyph } from "@/motion";
import { platformLabel, who } from "@/components/shell/format";
import { RelTime } from "@/components/shell/rel-time";
import type { Decision } from "./approval-card";

const EASE = [0.2, 0.8, 0.2, 1] as const;
type Video = Extract<PreviewModel, { type: "video" }>;
type TimedNote = { id: number; at: number; text: string };

export const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function slotTime(iso: string | null, tz?: string): string {
  if (!iso) return "next open slot";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { weekday: "short", ...(tz ? { timeZone: tz } : {}) })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) })}`;
}

/** 9:16 player with a timeline you can click to pin a note to a moment. */
function Player({
  src,
  durationHint,
  notes,
  onPin,
  label,
}: {
  src: string;
  durationHint: number | null;
  notes: TimedNote[];
  onPin: (at: number) => void;
  label: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(durationHint ?? 0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setT(0);
    setPlaying(false);
    setFailed(false);
  }, [src]);

  const seekFrom = (e: ReactMouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const at = x * (dur || 0);
    if (video.current) {
      video.current.currentTime = at;
      video.current.pause();
    }
    setT(at);
    return at;
  };

  return (
    <div className="flex w-full max-w-[340px] flex-col gap-2.5 @2xl:w-[300px] @4xl:w-[340px]">
      <div className="relative w-full overflow-hidden rounded-[14px] border border-border-strong bg-[#08060a]" style={{ aspectRatio: "9 / 16" }}>
        {!failed ? (
          <video
            ref={video}
            key={src}
            src={src}
            className="h-full w-full cursor-pointer object-contain"
            playsInline
            muted={muted}
            preload="metadata"
            aria-label={label}
            onLoadedMetadata={(e) => setDur(e.currentTarget.duration || durationHint || 0)}
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setFailed(true)}
            onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
          />
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-small text-white/70">The video file isn't available on this machine.</div>
        )}
        {!playing && !failed ? (
          <button
            type="button"
            onClick={() => void video.current?.play()}
            className="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-transform hover:scale-105"
            aria-label="Play"
          >
            <Play className="ml-0.5 size-6" fill="currentColor" strokeWidth={0} />
          </button>
        ) : null}
      </div>
      {/* Transport + timeline */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => (video.current?.paused ? void video.current.play() : video.current?.pause())} className="grid size-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg" aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="size-4" fill="currentColor" strokeWidth={0} /> : <Play className="size-4" fill="currentColor" strokeWidth={0} />}
        </button>
        <span className="w-[74px] shrink-0 font-mono text-[11px] text-fg-3 tabular">
          {stamp(t)} / {stamp(dur)}
        </span>
        <button type="button" onClick={() => setMuted((m) => !m)} className="ml-auto grid size-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg" aria-label={muted ? "Sound on" : "Mute"}>
          {muted ? <VolumeX className="size-4" strokeWidth={1.75} /> : <Volume2 className="size-4" strokeWidth={1.75} />}
        </button>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Timeline: click to pin a note to this moment"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(t)}
        aria-valuetext={stamp(t)}
        data-testid="timeline"
        className="group relative h-9 cursor-pointer select-none"
        onClick={(e) => onPin(seekFrom(e))}
        onKeyDown={(e) => {
          if (!video.current) return;
          if (e.key === "ArrowRight") video.current.currentTime = Math.min(dur, video.current.currentTime + 1);
          else if (e.key === "ArrowLeft") video.current.currentTime = Math.max(0, video.current.currentTime - 1);
          else if (e.key === "Enter" || e.key === "n") onPin(video.current.currentTime);
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-3 transition-[height] group-hover:h-2" />
        <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-fg-3 group-hover:h-2" style={{ width: `${dur ? (t / dur) * 100 : 0}%` }} />
        {notes.map((n) => (
          <span
            key={n.id}
            title={`${stamp(n.at)}: ${n.text || "new note"}`}
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface-1 bg-brand"
            style={{ left: `${dur ? Math.min(100, (n.at / dur) * 100) : 0}%` }}
          />
        ))}
        <span className="pointer-events-none absolute top-1/2 h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg" style={{ left: `${dur ? (t / dur) * 100 : 0}%` }} />
      </div>
      <button type="button" onClick={() => onPin(video.current?.currentTime ?? t)} className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong py-2 text-small text-fg-2 hover:border-fg-3 hover:text-fg">
        <MessageSquarePlus className="size-4" strokeWidth={1.75} /> Add a note at {stamp(t)}
      </button>
    </div>
  );
}

function QcSummary({ qc }: { qc: VideoReview["qc"] }) {
  const [open, setOpen] = useState(false);
  const problems = qc.checks.filter((c) => c.status === "fail" || c.status === "warn");
  if (qc.passed === null && !qc.checks.length) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 text-left">
        {qc.passed === false || problems.some((p) => p.status === "fail") ? (
          <Badge tone="warning">Checks: {problems.length} to look at</Badge>
        ) : (
          <Badge tone="success">
            <Check className="mr-1 size-3" strokeWidth={2.5} /> Checks passed
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate text-small text-fg-2">{qc.summary}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-fg-3 transition-transform", open && "rotate-180")} strokeWidth={1.5} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="mt-2 flex flex-col gap-1 overflow-hidden">
            {[...problems, ...qc.checks.filter((c) => !problems.includes(c))].map((c) => (
              <li key={c.label} className="flex items-start gap-2 text-small">
                {c.status === "fail" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" strokeWidth={1.75} /> : c.status === "warn" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" strokeWidth={1.75} /> : <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2} />}
                <span className="text-fg">{c.label}</span>
                {c.detail && c.status !== "pass" ? <span className="text-fg-2">{c.detail}</span> : null}
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

type Props = {
  item: ApprovalView;
  p: Video & { review: VideoReview };
  handles: Record<string, string>;
  focused: boolean;
  tz?: string;
  onFocus: () => void;
  onSettled: (item: ApprovalView, decision: Decision, message?: string) => void;
};

/**
 * The approval card for a finished video: a big 9:16 player with v1/v2, notes pinned to moments on the timeline plus
 * free text, the caption per platform (editable), where and when it will post, and the QC result. Approve schedules
 * it; Request changes sends every note to the Art Director for the next version.
 */
export const VideoReviewCard = forwardRef<HTMLElement, Props>(function VideoReviewCard({ item, p, focused, tz, onFocus, onSettled }, ref) {
  const r = p.review;
  const w = who(item.agent);
  const latest = r.versions[r.versions.length - 1] ?? null;
  const [version, setVersion] = useState(latest?.version ?? p.version ?? 1);
  const current = r.versions.find((v) => v.version === version) ?? latest;
  const [notes, setNotes] = useState<TimedNote[]>([]);
  const [general, setGeneral] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const seq = useRef(0);
  const [tab, setTab] = useState(r.captions[0]?.platform ?? null);
  const [captions, setCaptions] = useState<Record<string, string>>(() => Object.fromEntries(r.captions.map((c) => [c.platform, c.text])));
  const [platforms, setPlatforms] = useState<string[]>(() => r.slots.map((s) => s.platform));
  const [busy, setBusy] = useState<null | "approve" | "changes" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState("");

  useEffect(() => setPlatforms((cur) => (cur.length ? cur : r.slots.map((s) => s.platform))), [r.slots]);

  const edited = useMemo(() => Object.fromEntries(Object.entries(captions).filter(([pl, text]) => text.trim() !== (r.captions.find((c) => c.platform === pl)?.text ?? "").trim())), [captions, r.captions]);
  const hasNotes = notes.some((n) => n.text.trim()) || general.trim().length > 0;
  const viewingOld = latest && version !== latest.version;

  const pin = (at: number) => {
    const id = ++seq.current;
    setNotes((ns) => [...ns, { id, at, text: "" }].sort((a, b) => a.at - b.at));
    setEditing(id);
  };

  const approve = async () => {
    setBusy("approve");
    setError(null);
    const res = await approveVideoAction(item.id, { captions: edited, platforms });
    setBusy(null);
    if (!res.ok) return setError(res.error);
    onSettled(item, "approved", res.message);
  };
  const changes = async () => {
    setBusy("changes");
    setError(null);
    const res = await requestVideoChangesAction(item.id, { notes: general, timestamps: notes.filter((n) => n.text.trim()).map((n) => ({ at: n.at, text: n.text })) });
    setBusy(null);
    if (!res.ok) return setError(res.error);
    onSettled(item, "revised", res.message);
  };
  const reject = async () => {
    setBusy("reject");
    const res = await decideApprovalAction(item.id, "rejected", why);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    onSettled(item, "rejected", res.message);
  };

  const slots = r.slots;
  const assistIg = slots.some((s) => s.platform === "instagram" && s.mode === "assist");

  return (
    <article
      ref={ref}
      id={item.ref}
      tabIndex={-1}
      onFocus={onFocus}
      onMouseDown={onFocus}
      aria-label={`Video from ${w.name}: ${item.title}`}
      data-approval="video"
      className={cn("relative scroll-mt-24 rounded-lg border bg-surface-1 p-6 outline-none transition-colors duration-200 max-sm:p-4", focused ? "border-border-strong" : "border-border")}
    >
      <span aria-hidden className="absolute bottom-4 left-[-1px] top-4 w-[2px] bg-brand" />
      <header className="flex items-center gap-3">
        <AgentMonogram agent={{ monogram: w.monogram, name: w.name, state: "idle" }} size={32} />
        <div className="min-w-0 flex-1 text-small">
          <span className="font-medium text-fg">{w.name}</span>
          <span className="text-fg-3"> · </span>
          <RelTime iso={item.requestedAt} prefix="cut " className="text-fg-3" />
        </div>
        <span className="hidden font-mono text-[11px] text-fg-3 sm:inline" title="Reply with this ref in chat to decide from your phone">
          {r.editRef} · {item.ref}
        </span>
      </header>

      <div className="mt-5 grid grid-cols-1 gap-6 @2xl:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-3 @2xl:items-start">
          {r.versions.length > 1 ? (
            <div role="tablist" aria-label="Version" className="flex items-center gap-1 rounded-md border border-border p-1">
              {r.versions.map((v) => (
                <button
                  key={v.version}
                  type="button"
                  role="tab"
                  aria-selected={v.version === version}
                  onClick={() => setVersion(v.version)}
                  className={cn("h-7 rounded-sm px-3 text-caption font-medium transition-colors", v.version === version ? "bg-surface-3 text-fg" : "text-fg-3 hover:text-fg-2")}
                >
                  v{v.version}
                  {v.version === latest?.version ? " · new" : ""}
                </button>
              ))}
            </div>
          ) : null}
          {current ? (
            <Player src={current.src} durationHint={current.durationS ?? p.durationS} notes={viewingOld ? [] : notes} onPin={pin} label={`${item.title}, version ${current.version}`} />
          ) : (
            <p className="text-small text-fg-2">The render isn't available yet.</p>
          )}
          {viewingOld ? <p className="max-w-[300px] text-center text-caption text-fg-3">You're watching v{version}. Notes and approval apply to v{latest?.version}.</p> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-small text-fg-3">Finished video</span>
              {(p.version ?? 1) > 1 ? <Badge tone="neutral">Version {p.version}</Badge> : null}
            </div>
            <h3 className="mt-1 text-[20px] font-medium leading-7 tracking-[-0.005em] text-fg">{item.title}</h3>
            {p.notes.length ? (
              <ul className="mt-2 flex flex-col gap-1">
                {p.notes.map((n) => (
                  <li key={n} className="flex items-start gap-2 text-small text-fg-2">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2} /> {n}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3">
              <QcSummary qc={r.qc} />
            </div>
          </div>

          {/* Feedback */}
          <section aria-label="Your notes" className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-small font-medium text-fg">Notes for the editor</h4>
              <span className="text-caption text-fg-3">Click the timeline to pin a note to a moment</span>
            </div>
            {notes.length ? (
              <ul className="flex flex-col gap-1.5" data-testid="timed-notes">
                {notes.map((n) => (
                  <li key={n.id} className="flex items-center gap-2 rounded-md bg-surface-2 py-1 pl-2.5 pr-1">
                    <span className="shrink-0 font-mono text-[12px] text-on-tint tabular">{stamp(n.at)}</span>
                    {editing === n.id ? (
                      <input
                        autoFocus
                        value={n.text}
                        placeholder="cut this pause, zoom here, bigger caption…"
                        aria-label={`Note at ${stamp(n.at)}`}
                        onChange={(e) => setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)))}
                        onBlur={() => {
                          setEditing(null);
                          if (!n.text.trim()) setNotes((ns) => ns.filter((x) => x.id !== n.id));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Escape") setEditing(null);
                        }}
                        className="h-8 min-w-0 flex-1 bg-transparent text-small text-fg outline-none placeholder:text-fg-3"
                      />
                    ) : (
                      <button type="button" onClick={() => setEditing(n.id)} className="h-8 min-w-0 flex-1 truncate text-left text-small text-fg">
                        {n.text || <span className="text-fg-3">Add what to change here</span>}
                      </button>
                    )}
                    <button type="button" onClick={() => setNotes((ns) => ns.filter((x) => x.id !== n.id))} className="grid size-7 shrink-0 place-items-center rounded-sm text-fg-3 hover:text-fg" aria-label={`Remove the note at ${stamp(n.at)}`}>
                      <X className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Textarea value={general} onChange={(e) => setGeneral(e.target.value)} placeholder="Anything else? “Tighten the hook”, “no music”, “end on the close-up”" className="min-h-16 bg-surface-1" aria-label="General notes" />
          </section>

          {/* Captions */}
          {r.captions.length ? (
            <section aria-label="Captions">
              <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Caption per platform">
                {r.captions.map((c) => (
                  <button
                    key={c.platform}
                    type="button"
                    role="tab"
                    aria-selected={tab === c.platform}
                    onClick={() => setTab(c.platform)}
                    className={cn("flex h-7 items-center gap-1.5 rounded-sm px-2 text-caption transition-colors", tab === c.platform ? "bg-surface-3 text-fg" : "text-fg-3 hover:text-fg-2")}
                  >
                    <PlatformGlyph platform={c.platform} size={13} />
                    {platformLabel(c.platform)}
                    {c.platform in edited ? <span className="size-1.5 rounded-full bg-brand" aria-label="edited" /> : null}
                  </button>
                ))}
              </div>
              {tab ? (
                <div className="relative mt-2">
                  <Textarea
                    value={captions[tab] ?? ""}
                    onChange={(e) => setCaptions((c) => ({ ...c, [tab]: e.target.value }))}
                    aria-label={`${platformLabel(tab)} caption`}
                    className="min-h-28 bg-surface-2 font-mono text-[12.5px] leading-5"
                  />
                  {tab in edited ? (
                    <button type="button" onClick={() => setCaptions((c) => ({ ...c, [tab]: r.captions.find((x) => x.platform === tab)?.text ?? "" }))} className="absolute bottom-2 right-2 flex items-center gap-1 rounded-sm bg-surface-1 px-2 py-1 text-caption text-fg-2 hover:text-fg">
                      <RotateCcw className="size-3" strokeWidth={2} /> Undo edits
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* Where it goes */}
          <section aria-label="Posting plan" className="rounded-md border border-border px-4 py-3">
            <h4 className="text-small font-medium text-fg">When you approve</h4>
            {slots.length ? (
              <ul className="mt-2 flex flex-col gap-1.5">
                {slots.map((s) => {
                  const on = platforms.includes(s.platform);
                  return (
                    <li key={s.platform} className="flex items-center gap-2.5 text-small">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setPlatforms((ps) => (on ? ps.filter((x) => x !== s.platform) : [...ps, s.platform]))}
                        aria-label={`Post on ${platformLabel(s.platform)}`}
                        className="size-4 accent-[var(--brand)]"
                      />
                      <PlatformGlyph platform={s.platform} size={14} />
                      <span className={cn("w-[72px] shrink-0 truncate", on ? "text-fg" : "text-fg-3 line-through")}>{platformLabel(s.platform)}</span>
                      <span className={cn("whitespace-nowrap tabular", on ? "text-fg-2" : "text-fg-3")} suppressHydrationWarning>
                        {slotTime(s.scheduledAt, tz)}
                      </span>
                      {s.mode === "assist" ? <Badge tone="info" className="ml-auto whitespace-nowrap">You post it</Badge> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1 text-small text-fg-2">The Publisher picks the next open slot on each platform.</p>
            )}
            {assistIg && !r.instagramAutopost ? (
              <p className="mt-2 text-caption text-fg-3">Instagram is on assist: trending audio can only be added in the app, so you get the file and caption at post time. Autopost is in Publishing settings.</p>
            ) : null}
            {!r.publisherAutopilot && slots.some((s) => s.mode === "auto") ? <p className="mt-1 text-caption text-fg-3">Approving the video approves these posts too.</p> : null}
          </section>
        </div>
      </div>

      {error ? (
        <p className="mt-5 flex items-start gap-2 text-small text-danger" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} /> {error}
        </p>
      ) : null}

      <AnimatePresence initial={false}>
        {rejecting ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="mt-5 flex flex-col gap-3 rounded-md border border-border bg-surface-2 p-4">
              <label htmlFor={`why-${item.id}`} className="text-small font-medium text-fg">
                Why not? (optional)
              </label>
              <Textarea id={`why-${item.id}`} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Not this week" className="min-h-16 bg-surface-1" />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={reject} disabled={busy !== null} className="bg-danger text-[#15101a] hover:bg-danger hover:opacity-90">
                  Reject video
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <footer className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-5">
        <Button variant="danger" className="px-3" onClick={() => setRejecting((v) => !v)} aria-expanded={rejecting}>
          <X className="size-4" strokeWidth={1.5} /> Reject
        </Button>
        <div className="flex-1" />
        <Button variant="secondary" onClick={changes} disabled={!hasNotes || busy !== null} title={hasNotes ? undefined : "Add a note first"}>
          {busy === "changes" ? "Sending…" : `Request changes${notes.filter((n) => n.text.trim()).length ? ` (${notes.filter((n) => n.text.trim()).length + (general.trim() ? 1 : 0)})` : ""}`}
        </Button>
        <Button variant={focused ? "primary" : "secondary"} onClick={approve} disabled={busy !== null || (slots.length > 0 && platforms.length === 0)} className="min-w-[160px] max-sm:flex-1">
          <Check className="size-4" strokeWidth={2} />
          {busy === "approve" ? "Approving…" : "Approve and schedule"}
        </Button>
      </footer>
    </article>
  );
});
