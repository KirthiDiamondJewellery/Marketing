"use client";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CalendarClock, Check, ChevronDown, CircleAlert, Download, Inbox, RotateCcw, ThumbsUp, Wand2, X } from "lucide-react";
import type { ReviewVideo } from "@/server/queries/edit";
import { requestVideoChangesAction } from "@/server/actions/approvals";
import { looksGoodAction, type LooksGoodChoice } from "@/server/actions/edit";
import { Badge, Button, Textarea, cn } from "@/components/ui";
import { PlatformGlyph } from "@/motion";
import { platformLabel } from "@/components/shell/format";
import { RelTime } from "@/components/shell/rel-time";
import { useToast } from "@/components/shell/toast";
import { Player, stamp, type PinnedNote } from "./player";
import { defaultPickTime, localNow, slotTime, tzCity, zonedToIso } from "./time";

const EASE = [0.2, 0.8, 0.2, 1] as const;
const reveal = { initial: { height: 0, opacity: 0 }, animate: { height: "auto", opacity: 1 }, exit: { height: 0, opacity: 0 }, transition: { duration: 0.2, ease: EASE } };

type Mode = null | "changes" | "good";
type After = "schedule" | "download" | "ready";
type Settled = { kind: "changes" | "good"; message: string };

function QcLine({ qc }: { qc: ReviewVideo["qc"] }) {
  const [open, setOpen] = useState(false);
  const problems = qc.lines.filter((l) => l.status !== "pass");
  const icon =
    qc.ok === false || problems.length ? (
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.75} />
    ) : (
      <Check className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={2} />
    );
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!qc.lines.length} className="flex w-full items-start gap-2 text-left disabled:cursor-default">
        {icon}
        <span className="min-w-0 flex-1 text-small text-fg-2">{qc.summary}</span>
        {qc.lines.length ? <ChevronDown className={cn("mt-0.5 size-4 shrink-0 text-fg-3 transition-transform motion-reduce:transition-none", open && "rotate-180")} strokeWidth={1.5} /> : null}
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul {...reveal} className="flex flex-col gap-1 overflow-hidden pl-6 pt-2">
            {[...problems, ...qc.lines.filter((l) => l.status === "pass")].map((l) => (
              <li key={l.label} className="flex items-start gap-2 text-small">
                {l.status === "pass" ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2} /> : <CircleAlert className={cn("mt-0.5 size-3.5 shrink-0", l.status === "fail" ? "text-danger" : "text-warning")} strokeWidth={1.75} />}
                <span className="text-fg">{l.label}</span>
                {l.detail ? <span className="text-fg-2">{l.detail}</span> : null}
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * A finished video waiting for the owner: watch it, then "Needs changes" (notes, pinned to moments on the timeline)
 * or "Looks good" and pick what happens next: schedule it, download it, or save it as ready to post.
 */
export function ReviewCard({ v, tz, instagramAutopost }: { v: ReviewVideo; tz: string; instagramAutopost: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const latest = v.versions[v.versions.length - 1] ?? null;
  const [version, setVersion] = useState(latest?.version ?? v.version);
  const current = v.versions.find((x) => x.version === version) ?? latest;
  const viewingOld = latest !== null && version !== latest.version;

  const [mode, setMode] = useState<Mode>(null);
  const [notes, setNotes] = useState<PinnedNote[]>([]);
  const [general, setGeneral] = useState("");
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const seq = useRef(0);

  const [capsOpen, setCapsOpen] = useState(false);
  const [tab, setTab] = useState(v.captions[0]?.platform ?? null);
  const [captions, setCaptions] = useState<Record<string, string>>(() => Object.fromEntries(v.captions.map((c) => [c.platform, c.text])));
  const edited = useMemo(
    () => Object.fromEntries(Object.entries(captions).filter(([p, text]) => text.trim() !== (v.captions.find((c) => c.platform === p)?.text ?? "").trim())),
    [captions, v.captions],
  );

  const [after, setAfter] = useState<After>("schedule");
  const [platforms, setPlatforms] = useState<string[]>(() => v.slots.map((s) => s.platform));
  const [when, setWhen] = useState<"next" | "pick">("next");
  const [pickAt, setPickAt] = useState(() => defaultPickTime(tz));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<Settled | null>(null);

  const timed = notes.filter((n) => n.text.trim());
  const hasNotes = timed.length > 0 || general.trim().length > 0;
  const noteCount = timed.length + (general.trim() ? 1 : 0);

  const pin = (at: number) => {
    const id = ++seq.current;
    setNotes((ns) => [...ns, { id, at, text: "" }].sort((a, b) => a.at - b.at));
    setEditingNote(id);
    setMode("changes");
  };

  const sendChanges = async () => {
    setBusy(true);
    setError(null);
    const r = await requestVideoChangesAction(v.approvalId, { notes: general, timestamps: timed.map((n) => ({ at: n.at, text: n.text })) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSettled({ kind: "changes", message: `Your editor is making version ${v.version + 1}. It shows up under Being edited, then back here.` });
    toast(`Sent. Your editor is making version ${v.version + 1}.`);
    router.refresh();
  };

  const confirm = async () => {
    setError(null);
    let choice: LooksGoodChoice;
    if (after === "schedule") {
      if (!platforms.length) return setError("Pick at least one platform to post on.");
      if (when === "pick") {
        const iso = zonedToIso(pickAt, tz);
        if (!iso) return setError("Pick a date and time.");
        choice = { then: "at", at: iso };
      } else choice = { then: "next" };
    } else choice = { then: after };
    setBusy(true);
    const r = await looksGoodAction(v.approvalId, choice, { captions: edited, ...(after === "schedule" ? { platforms } : {}) });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      if ("releaseId" in r && r.releaseId) router.refresh();
      return;
    }
    if (r.downloadUrl) {
      const a = document.createElement("a");
      a.href = r.downloadUrl;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setSettled({ kind: "good", message: r.message ?? "Done." });
    toast(r.message ?? "Done.");
    router.refresh();
  };

  if (settled) {
    return (
      <article className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 px-5 py-4" aria-live="polite" data-review-settled={settled.kind}>
        {settled.kind === "changes" ? <Wand2 className="mt-0.5 size-4 shrink-0 text-brand-fg" strokeWidth={1.75} /> : <Check className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={2} />}
        <div className="min-w-0">
          <p className="text-small font-medium text-fg">{v.title}</p>
          <p className="mt-0.5 text-small text-fg-2">{settled.message}</p>
        </div>
      </article>
    );
  }

  const igAssist = platforms.includes("instagram") && v.slots.some((s) => s.platform === "instagram" && s.mode === "assist") && !instagramAutopost;
  const versionLine = v.version > 1 ? (v.changesAsked.length ? `Version ${v.version}, with your notes` : `Version ${v.version}`) : "First cut";

  return (
    <article aria-label={`${v.title}, ${versionLine}`} data-review={v.approvalId} className="relative rounded-lg border border-border-strong bg-surface-1 p-6 max-sm:p-4">
      <span aria-hidden className="absolute bottom-4 left-[-1px] top-4 w-[2px] bg-brand" />
      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-[300px_minmax(0,1fr)] @5xl:grid-cols-[320px_minmax(0,1fr)]">
        {/* The video */}
        <div className="flex flex-col items-center gap-3">
          {v.versions.length > 1 ? (
            <div role="tablist" aria-label="Version" className="flex items-center gap-1 rounded-md border border-border p-1">
              {v.versions.map((x) => (
                <button
                  key={x.version}
                  type="button"
                  role="tab"
                  aria-selected={x.version === version}
                  onClick={() => setVersion(x.version)}
                  className={cn("h-7 rounded-sm px-3 text-caption font-medium transition-colors", x.version === version ? "bg-surface-3 text-fg" : "text-fg-3 hover:text-fg-2")}
                >
                  Version {x.version}
                  {x.version === latest?.version ? " (new)" : ""}
                </button>
              ))}
            </div>
          ) : null}
          {current ? (
            <Player src={`/api/media/${current.assetId}`} durationHint={current.durationS ?? v.durationS} notes={viewingOld ? [] : notes} onPin={pin} label={`${v.title}, version ${current.version}`} />
          ) : (
            <p className="text-small text-fg-2">The video file isn&apos;t ready yet.</p>
          )}
          {viewingOld ? <p className="max-w-[300px] text-center text-caption text-fg-3">You&apos;re watching version {version}. Your notes and choice apply to version {latest?.version}.</p> : null}
        </div>

        {/* What it is, and your call */}
        <div className="flex min-w-0 flex-col gap-5">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-small text-fg-3">
              <span>{versionLine}</span>
              <span aria-hidden>·</span>
              <RelTime iso={v.requestedAt} prefix="ready " />
            </div>
            <h3 className="mt-1 text-[20px] font-medium leading-7 tracking-[-0.005em] text-fg">{v.title}</h3>
            {v.changesAsked.length ? (
              <div className="mt-3">
                <p className="text-caption text-fg-3">You asked for</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {v.changesAsked.map((n) => (
                    <li key={n} className="flex items-start gap-2 text-small text-fg-2">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2} /> {n}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="mt-3">
              <QcLine qc={v.qc} />
            </div>
          </div>

          {v.captions.length ? (
            <section aria-label="Captions" className="rounded-md border border-border">
              <button type="button" onClick={() => setCapsOpen((o) => !o)} aria-expanded={capsOpen} className="flex w-full items-center gap-2 px-4 py-3 text-left">
                <span className="text-small font-medium text-fg">Captions</span>
                <span className="flex items-center gap-1.5 text-fg-3">
                  {v.captions.map((c) => (
                    <PlatformGlyph key={c.platform} platform={c.platform} size={13} />
                  ))}
                </span>
                {Object.keys(edited).length ? <Badge tone="brand">Edited</Badge> : null}
                <span className="ml-auto text-caption text-fg-3">{capsOpen ? "Hide" : "Read or edit"}</span>
                <ChevronDown className={cn("size-4 shrink-0 text-fg-3 transition-transform motion-reduce:transition-none", capsOpen && "rotate-180")} strokeWidth={1.5} />
              </button>
              <AnimatePresence initial={false}>
                {capsOpen ? (
                  <motion.div {...reveal} className="overflow-hidden">
                    <div className="border-t border-border px-4 pb-4 pt-3">
                      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Caption per platform">
                        {v.captions.map((c) => (
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
                            className="min-h-28 bg-surface-2 text-[13px] leading-5"
                          />
                          {tab in edited ? (
                            <button
                              type="button"
                              onClick={() => setCaptions((c) => ({ ...c, [tab]: v.captions.find((x) => x.platform === tab)?.text ?? "" }))}
                              className="absolute bottom-2 right-2 flex items-center gap-1 rounded-sm bg-surface-1 px-2 py-1 text-caption text-fg-2 hover:text-fg"
                            >
                              <RotateCcw className="size-3" strokeWidth={2} /> Undo edits
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      <p className="mt-2 text-caption text-fg-3">Edits here are used when it posts.</p>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </section>
          ) : null}

          {/* The decision */}
          {mode === null ? (
            <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-5">
              <Button variant="secondary" size="lg" className="flex-1 basis-[160px]" onClick={() => setMode("changes")}>
                <Wand2 className="size-4" strokeWidth={1.75} /> Needs changes
              </Button>
              <Button variant="primary" size="lg" className="flex-1 basis-[160px]" onClick={() => setMode("good")}>
                <ThumbsUp className="size-4" strokeWidth={1.75} /> Looks good
              </Button>
            </div>
          ) : null}

          <AnimatePresence initial={false} mode="wait">
            {mode === "changes" ? (
              <motion.section key="changes" {...reveal} aria-label="What to change" className="overflow-hidden">
                <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-2 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h4 className="text-small font-medium text-fg">What should your editor change?</h4>
                    <span className="text-caption text-fg-3">Click the video&apos;s timeline to pin a note to a moment</span>
                  </div>
                  {notes.length ? (
                    <ul className="flex flex-col gap-1.5" data-testid="timed-notes">
                      {notes.map((n) => (
                        <li key={n.id} className="flex items-center gap-2 rounded-md bg-surface-1 py-1 pl-2.5 pr-1">
                          <span className="shrink-0 font-mono text-[12px] text-on-tint tabular">{stamp(n.at)}</span>
                          {editingNote === n.id ? (
                            <input
                              autoFocus
                              value={n.text}
                              placeholder="Cut this pause, zoom in here, bigger caption…"
                              aria-label={`Note at ${stamp(n.at)}`}
                              onChange={(e) => setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)))}
                              onBlur={() => {
                                setEditingNote(null);
                                if (!n.text.trim()) setNotes((ns) => ns.filter((x) => x.id !== n.id));
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === "Escape") setEditingNote(null);
                              }}
                              className="h-8 min-w-0 flex-1 bg-transparent text-small text-fg outline-none placeholder:text-fg-3"
                            />
                          ) : (
                            <button type="button" onClick={() => setEditingNote(n.id)} className="h-8 min-w-0 flex-1 truncate text-left text-small text-fg">
                              {n.text || <span className="text-fg-3">Say what to change here</span>}
                            </button>
                          )}
                          <button type="button" onClick={() => setNotes((ns) => ns.filter((x) => x.id !== n.id))} className="grid size-7 shrink-0 place-items-center rounded-sm text-fg-3 hover:text-fg" aria-label={`Remove the note at ${stamp(n.at)}`}>
                            <X className="size-3.5" strokeWidth={1.75} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Textarea
                    value={general}
                    onChange={(e) => setGeneral(e.target.value)}
                    placeholder="“Tighten the hook”, “no music”, “end on the close-up”"
                    className="min-h-20 bg-surface-1"
                    aria-label="Notes for your editor"
                  />
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button variant="ghost" onClick={() => setMode(null)} disabled={busy}>
                      Back
                    </Button>
                    <Button variant="primary" onClick={sendChanges} disabled={!hasNotes || busy} title={hasNotes ? undefined : "Add a note first"}>
                      {busy ? "Sending…" : `Send to your editor${timed.length ? ` (${noteCount} ${noteCount === 1 ? "note" : "notes"})` : ""}`}
                    </Button>
                  </div>
                </div>
              </motion.section>
            ) : mode === "good" ? (
              <motion.section key="good" {...reveal} aria-label="What happens next" className="overflow-hidden">
                <div className="flex flex-col gap-4 rounded-md border border-border bg-surface-2 p-4">
                  <h4 className="text-small font-medium text-fg">Nice. What next?</h4>
                  <div role="radiogroup" aria-label="What happens next" className="grid grid-cols-3 gap-2 max-sm:grid-cols-1">
                    {(
                      [
                        { id: "schedule", label: "Schedule", hint: "Post it on its own", icon: CalendarClock },
                        { id: "download", label: "Download", hint: "Save the file", icon: Download },
                        { id: "ready", label: "Save as ready", hint: "Decide later", icon: Inbox },
                      ] as const
                    ).map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        role="radio"
                        aria-checked={after === o.id}
                        onClick={() => setAfter(o.id)}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors sm:flex-col sm:items-start sm:gap-1.5",
                          after === o.id ? "border-brand bg-brand-tint/40 text-fg" : "border-border bg-surface-1 text-fg-2 hover:border-border-strong hover:text-fg",
                        )}
                      >
                        <o.icon className={cn("size-4 shrink-0", after === o.id ? "text-brand-fg" : "text-fg-3")} strokeWidth={1.75} />
                        <span className="min-w-0">
                          <span className="block text-small font-medium">{o.label}</span>
                          <span className="block text-caption text-fg-3">{o.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>

                  {after === "schedule" ? (
                    <div className="flex flex-col gap-3">
                      <fieldset>
                        <legend className="mb-1.5 text-caption text-fg-3">Post on</legend>
                        <ul className="flex flex-col gap-1.5">
                          {v.slots.map((s) => {
                            const on = platforms.includes(s.platform);
                            return (
                              <li key={s.platform}>
                                <label className="flex cursor-pointer items-center gap-2.5 text-small">
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={() => setPlatforms((ps) => (on ? ps.filter((x) => x !== s.platform) : [...ps, s.platform]))}
                                    className="size-4 accent-[var(--brand)]"
                                  />
                                  <PlatformGlyph platform={s.platform} size={14} />
                                  <span className={cn("w-[76px] shrink-0 truncate", on ? "text-fg" : "text-fg-3")}>{platformLabel(s.platform)}</span>
                                  {when === "next" ? (
                                    <span className={cn("min-w-0 truncate tabular", on ? "text-fg-2" : "text-fg-3")} suppressHydrationWarning>
                                      {slotTime(s.scheduledAt, tz)}
                                    </span>
                                  ) : null}
                                  {s.mode === "assist" && !instagramAutopost ? (
                                    <Badge tone="info" className="ml-auto whitespace-nowrap">
                                      You post it
                                    </Badge>
                                  ) : null}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </fieldset>
                      <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1.5 text-caption text-fg-3">When</legend>
                        <label className="flex cursor-pointer items-center gap-2.5 text-small text-fg">
                          <input type="radio" name={`when-${v.approvalId}`} checked={when === "next"} onChange={() => setWhen("next")} className="size-4 accent-[var(--brand)]" />
                          Next open slot on each platform
                        </label>
                        <label className="flex cursor-pointer flex-wrap items-center gap-2.5 text-small text-fg">
                          <input type="radio" name={`when-${v.approvalId}`} checked={when === "pick"} onChange={() => setWhen("pick")} className="size-4 accent-[var(--brand)]" />
                          Pick a time
                          {when === "pick" ? (
                            <input
                              type="datetime-local"
                              value={pickAt}
                              min={localNow(tz)}
                              onChange={(e) => setPickAt(e.target.value)}
                              aria-label="Post time"
                              className="h-8 rounded-md border border-border-strong bg-surface-1 px-2 text-[13px] text-fg focus:border-brand focus:outline-none max-sm:basis-full max-sm:ml-[26px]"
                            />
                          ) : null}
                        </label>
                        {when === "pick" ? <p className="pl-[26px] text-caption text-fg-3">{tzCity(tz)} time. Every platform you picked posts at this time.</p> : null}
                      </fieldset>
                      {igAssist ? <p className="text-caption text-fg-3">Instagram: you post this one yourself so you can add trending audio. You get the file and caption when it&apos;s time.</p> : null}
                    </div>
                  ) : after === "download" ? (
                    <p className="text-small text-fg-2">Saves the finished video to your computer. It also waits in Calendar under Ready to post, so you can schedule it later.</p>
                  ) : (
                    <p className="text-small text-fg-2">It goes to Calendar under Ready to post. Schedule it or download it whenever you like.</p>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button variant="ghost" onClick={() => setMode(null)} disabled={busy}>
                      Back
                    </Button>
                    <Button variant="primary" onClick={confirm} disabled={busy || (after === "schedule" && !platforms.length)} className="min-w-[150px] max-sm:flex-1">
                      {busy
                        ? "Saving…"
                        : after === "schedule"
                          ? when === "pick"
                            ? "Schedule at this time"
                            : `Schedule on ${platforms.length} ${platforms.length === 1 ? "platform" : "platforms"}`
                          : after === "download"
                            ? "Download"
                            : "Save as ready"}
                    </Button>
                  </div>
                </div>
              </motion.section>
            ) : null}
          </AnimatePresence>

          {error ? (
            <p className="flex items-start gap-2 text-small text-danger" role="alert">
              <CircleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} /> {error}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
