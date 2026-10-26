"use client";
import Link from "next/link";
import { forwardRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Clock, Pencil, X } from "lucide-react";
import type { ApprovalView } from "@/server/queries/approvals";
import { Badge, Button, Textarea, buttonClass, cn } from "@/components/ui";
import { AgentMonogram, PlatformGlyph } from "@/motion";
import { clock, dayTime, who } from "@/components/shell/format";
import { RelTime } from "@/components/shell/rel-time";
import { CaptionTabs, PostFrame, ReplyFrame, ScriptFrame, VideoPreview } from "./previews";
import { VideoReviewCard } from "./video-review";

const EASE = [0.2, 0.8, 0.2, 1] as const;

export type Decision = "approved" | "rejected" | "revised";

const KIND: Record<string, { label: string; verb: string }> = {
  script: { label: "Script", verb: "wrote" },
  edit: { label: "Video edit", verb: "cut" },
  post: { label: "Post", verb: "scheduled" },
  dm_reply: { label: "DM reply", verb: "drafted" },
  comment_reply: { label: "Comment reply", verb: "drafted" },
  campaign: { label: "Campaign", verb: "planned" },
  spend: { label: "Spend", verb: "asked about" },
  brand_change: { label: "Brand Kit change", verb: "proposed" },
};

function ScriptBody({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const paras = body.split(/\n+/).filter(Boolean);
  const long = paras.length > 4;
  return (
    <div>
      <div className={cn("relative flex flex-col gap-2 text-[15px] leading-6 text-fg", !open && long && "max-h-[168px] overflow-hidden")}>
        {paras.map((p, i) => (
          <p key={i} className={i === 0 ? "font-medium" : undefined}>
            {p}
          </p>
        ))}
        {!open && long ? <div aria-hidden className="absolute inset-x-0 bottom-0 h-12 bg-[linear-gradient(to_bottom,transparent,var(--surface-1))]" /> : null}
      </div>
      {long ? (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-small text-fg-2 underline decoration-border-strong underline-offset-4 hover:text-fg">
          {open ? "Show less" : "Read the full script"}
        </button>
      ) : null}
    </div>
  );
}

const BEAT_LABEL: Record<string, string> = { hook: "Hook", turn: "Turn", proof: "Proof", rehook: "Rehook", play: "The play", close: "Close" };

/** The full script as the owner will say it, beat by beat, so it reads in one pass. */
function ScriptBeats({ beats, body }: { beats: { role: string; text: string }[]; body: string }) {
  if (!beats.length) return <ScriptBody body={body} />;
  return (
    <ol className="flex flex-col gap-2.5">
      {beats.map((b, i) => (
        <li key={i} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 max-sm:grid-cols-1 max-sm:gap-0.5">
          <span className="pt-[3px] text-caption text-fg-3">{BEAT_LABEL[b.role] ?? b.role}</span>
          <p className={cn("text-[15px] leading-6 text-fg", b.role === "hook" && "font-medium")}>{b.text}</p>
        </li>
      ))}
    </ol>
  );
}

const VERDICT: Record<string, { label: string; tone: "success" | "warning" | "neutral" }> = {
  PASS: { label: "Checked", tone: "success" },
  FIX: { label: "Fix", tone: "warning" },
  CUT: { label: "Cut", tone: "neutral" },
};

function sourceLabel(source: string | null): string | null {
  if (!source) return null;
  if (source.startsWith("proof:")) return `Proof: ${source.slice(6).replace(/-/g, " ")}`;
  if (source.startsWith("cited:")) return "Cited source";
  if (/^https?:\/\//.test(source)) {
    try {
      return new URL(source).hostname.replace(/^www\./, "");
    } catch {
      return source;
    }
  }
  return source;
}

/** Claim ledger: every number or factual claim in the script, with where it comes from. */
function ClaimLedger({ claims }: { claims: { claim: string; verdict: string; note: string | null; source: string | null }[] }) {
  const [open, setOpen] = useState(false);
  if (!claims.length) return null;
  const counts = claims.reduce<Record<string, number>>((m, c) => ((m[c.verdict] = (m[c.verdict] ?? 0) + 1), m), {});
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex flex-wrap items-center gap-2 text-small text-fg-2 hover:text-fg">
        <ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} strokeWidth={1.5} />
        Claims
        {Object.entries(counts).map(([v, n]) => (
          <Badge key={v} tone={VERDICT[v]?.tone ?? "neutral"}>
            {n} {(VERDICT[v]?.label ?? v).toLowerCase()}
          </Badge>
        ))}
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="flex flex-col gap-2 overflow-hidden pt-3">
            {claims.map((c, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <Badge tone={VERDICT[c.verdict]?.tone ?? "neutral"} className="mt-px shrink-0">
                  {VERDICT[c.verdict]?.label ?? c.verdict}
                </Badge>
                <span className="min-w-0 text-small">
                  <span className={cn("text-fg", c.verdict === "CUT" && "text-fg-3 line-through")}>{c.claim}</span>
                  {sourceLabel(c.source) || c.note ? <span className="block text-caption text-fg-3">{[sourceLabel(c.source), c.note].filter(Boolean).join(" · ")}</span> : null}
                </span>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function WhyThis({ item, tz }: { item: ApprovalView; tz?: string }) {
  const [open, setOpen] = useState(false);
  const { points, steps } = item.why;
  if (!points.length && !steps.length) return null;
  return (
    <div className="border-t border-border pt-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1.5 text-small text-fg-2 transition-colors hover:text-fg">
        <ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} strokeWidth={1.5} />
        Why this?
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="flex flex-col gap-4 pt-4">
              {points.length ? (
                <dl className="grid gap-3 sm:grid-cols-[140px_1fr]">
                  {points.map((p) => (
                    <div key={p.label + p.text} className="contents">
                      <dt className="text-small text-fg-3">{p.label}</dt>
                      <dd className="text-small text-fg">{p.text}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {steps.length ? (
                <ol className="rounded-md bg-surface-2 px-3.5 py-3 font-mono text-[12px] leading-5 text-fg-2">
                  {steps.map((s, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="shrink-0 text-fg-3 tabular" suppressHydrationWarning>
                        {clock(s.ts, tz)}
                      </span>
                      <span className="text-fg">{s.message}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

type Props = {
  item: ApprovalView;
  handles: Record<string, string>;
  focused: boolean;
  busy: boolean;
  tz?: string;
  onFocus: () => void;
  onDecide: (item: ApprovalView, decision: Decision, note?: string) => Promise<boolean>;
  /** A card that ran its own decision (the video review) reports it here. */
  onSettled?: (item: ApprovalView, decision: Decision, message?: string) => void;
};

/** The approval card (DESIGN §8.2): where a person signs off on agent work. */
export const ApprovalCard = forwardRef<HTMLElement, Props>(function ApprovalCard(props, ref) {
  const { item, handles, focused, tz, onFocus, onSettled } = props;
  const p = item.preview;
  if (p.type === "video" && p.review && item.status === "pending" && onSettled) {
    return <VideoReviewCard ref={ref} item={item} p={{ ...p, review: p.review }} handles={handles} focused={focused} tz={tz} onFocus={onFocus} onSettled={onSettled} />;
  }
  return <GenericCard ref={ref} {...props} />;
});

const GenericCard = forwardRef<HTMLElement, Props>(function GenericCard({ item, handles, focused, busy, tz, onFocus, onDecide }, ref) {
  const [mode, setMode] = useState<null | "revise" | "reject">(null);
  const [note, setNote] = useState("");
  const w = who(item.agent);
  const kind = KIND[item.kind] ?? { label: "Request", verb: "drafted" };
  const p = item.preview;
  const handle = (platform: string) => handles[platform] ?? handles.instagram ?? null;
  const pending = item.status === "pending";

  const submitNote = async () => {
    const ok = await onDecide(item, mode === "revise" ? "revised" : "rejected", note);
    if (ok) {
      setMode(null);
      setNote("");
    }
  };

  const frame =
    p.type === "video" ? (
      <VideoPreview p={p} handle={handle(p.caption?.platform ?? "instagram")} />
    ) : p.type === "script" ? (
      <ScriptFrame p={p} handle={handle(p.captions[0]?.platform ?? "instagram")} />
    ) : p.type === "post" ? (
      <PostFrame p={p} handle={handle(p.platform)} />
    ) : p.type === "reply" ? (
      <ReplyFrame p={p} />
    ) : null;

  return (
    <article
      ref={ref}
      id={item.ref}
      tabIndex={-1}
      onFocus={onFocus}
      onMouseDown={onFocus}
      aria-label={`${kind.label} from ${w.name}: ${item.title}`}
      className={cn(
        "relative scroll-mt-24 rounded-lg border bg-surface-1 p-6 outline-none transition-colors duration-200 max-sm:p-4",
                focused ? "border-border-strong" : "border-border",
      )}
    >
      {pending ? <span aria-hidden className="absolute bottom-4 left-[-1px] top-4 w-[2px] bg-brand" /> : null}
      <header className="flex items-center gap-3">
        <AgentMonogram agent={{ monogram: w.monogram, name: w.name, state: "idle" }} size={32} />
        <div className="min-w-0 flex-1 text-small">
          <span className="font-medium text-fg">{w.name}</span>
          <span className="text-fg-3"> · </span>
          <RelTime iso={item.requestedAt} prefix={`${kind.verb} `} className="text-fg-3" />
        </div>
        <span className="hidden font-mono text-[11px] text-fg-3 sm:inline" title="Reply with this ref in chat to decide from your phone">
          {item.ref}
        </span>
        <span className="flex items-center gap-1.5 text-fg-2">
          {item.platforms.slice(0, 4).map((pl) => (
            <span key={pl} className="grid size-6 place-items-center rounded-sm bg-surface-3">
              <PlatformGlyph platform={pl} size={14} />
            </span>
          ))}
        </span>
      </header>

      <div className={cn("mt-5 grid grid-cols-1 gap-6", frame && "@2xl:grid-cols-[auto_minmax(0,1fr)]")}>
        {frame ? <div className="flex justify-center @2xl:block">{frame}</div> : null}
        <div className="flex min-w-0 flex-col gap-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-small text-fg-3">{kind.label}</span>
              {p.type === "reply" && p.temperature === "hot" ? <Badge tone="warning">Hot lead</Badge> : null}
              {p.type === "post" && p.assist ? <Badge tone="info">You post this one</Badge> : null}
              {(p.type === "video" || p.type === "script") && p.version && p.version > 1 ? <Badge tone="neutral">Version {p.version}</Badge> : null}
              {p.type === "script" && p.keyword ? <Badge tone="neutral" className="font-mono text-[11px] tracking-normal">{p.keyword}</Badge> : null}
            </div>
            <h3 className="mt-1 text-[20px] font-medium leading-7 tracking-[-0.005em] text-fg">{item.title}</h3>
            {item.summary && !item.summary.includes(item.title) ? <p className="mt-1 text-small text-fg-2">{item.summary}</p> : null}
          </div>

          {p.type === "script" ? (
            <>
              <ScriptBeats beats={p.beats} body={p.body} />
              <ClaimLedger claims={p.claims} />
              {p.captions.length ? <CaptionTabs captions={p.captions} keyword={p.keyword} /> : null}
            </>
          ) : null}

          {p.type === "video" ? (
            <>
              {p.notes.length ? (
                <div>
                  <div className="text-small text-fg-3">Your notes, applied</div>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {p.notes.map((n) => (
                      <li key={n} className="flex items-start gap-2 text-small text-fg">
                        <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2} /> {n}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-small text-fg-2">{item.summary}</p>
              )}
              {p.caption ? <CaptionTabs captions={[p.caption]} /> : null}
            </>
          ) : null}

          {p.type === "post" ? (
            <div className="rounded-md bg-surface-2 px-3.5 py-3 font-mono text-[12.5px] leading-5">
              <p className="whitespace-pre-wrap text-fg">{p.caption}</p>
              {p.hashtags.length ? <p className="mt-2 text-fg-3">{p.hashtags.join(" ")}</p> : null}
            </div>
          ) : null}

          {p.type === "reply" ? (
            <div className="flex flex-col gap-2">
              <div className="text-small text-fg-3">Reply as drafted</div>
              <p className="text-[15px] leading-6 text-fg">{p.draft}</p>
              {p.reason ? <p className="text-small text-fg-2">Sorted as {p.temperature ?? "new"}: {p.reason.toLowerCase()}.</p> : null}
            </div>
          ) : null}

          {p.type === "text" ? <p className="text-[15px] leading-6 text-fg">{p.text}</p> : null}

          {item.scheduledFor ? (
            <p className="flex items-center gap-2 text-small text-fg-2">
              <Clock className="size-3.5 text-fg-3" strokeWidth={1.75} />
              Scheduled for <span className="text-fg" suppressHydrationWarning>{dayTime(item.scheduledFor, tz)}</span>
            </p>
          ) : null}

          <WhyThis item={item} tz={tz} />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {mode ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <form
              className="mt-6 flex flex-col gap-3 rounded-md border border-border bg-surface-2 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submitNote();
              }}
            >
              <label htmlFor={`note-${item.id}`} className="text-small font-medium text-fg">
                {mode === "revise" ? `What should ${w.name} change?` : "Why not? (optional)"}
              </label>
              <Textarea
                id={`note-${item.id}`}
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setMode(null);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitNote();
                }}
                placeholder={mode === "revise" ? (item.kind === "script" ? "Shorter hook, and lead with the number" : "Open on the bench reveal and cut the last line") : "Off-brand for this week"}
                className="min-h-20 bg-surface-1"
              />
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
                  Cancel
                </Button>
                {mode === "revise" ? (
                  <Button size="sm" variant="secondary" type="submit" disabled={busy || !note.trim()}>
                    Send back with notes
                  </Button>
                ) : (
                  <Button size="sm" type="submit" disabled={busy} className="bg-danger text-[#15101a] hover:bg-danger hover:opacity-90">
                    Reject
                  </Button>
                )}
              </div>
            </form>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {pending ? (
        <footer className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-5">
          {item.editHref ? (
            <Link href={item.editHref} className={buttonClass("ghost", "md", "px-3")}>
              <Pencil className="size-4" strokeWidth={1.5} /> Edit
            </Link>
          ) : null}
          <Button variant="ghost" className="px-3" onClick={() => setMode(mode === "revise" ? null : "revise")} aria-expanded={mode === "revise"}>
            Request changes
          </Button>
          <Button variant="danger" className="px-3" onClick={() => setMode(mode === "reject" ? null : "reject")} aria-expanded={mode === "reject"}>
            <X className="size-4" strokeWidth={1.5} /> Reject
          </Button>
          <div className="flex-1" />
          {focused ? <span className="mr-1 hidden text-caption text-fg-3 lg:inline">Press A</span> : null}
          <Button variant={focused ? "primary" : "secondary"} onClick={() => void onDecide(item, "approved")} disabled={busy} className="min-w-[120px] max-sm:flex-1">
            <Check className="size-4" strokeWidth={2} />
            {busy ? "Approving" : item.kind === "post" ? "Approve and schedule" : "Approve"}
          </Button>
        </footer>
      ) : (
        <footer className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-small text-fg-2">
          <Badge tone={item.status === "approved" ? "success" : item.status === "rejected" ? "danger" : "info"}>
            {item.status === "approved" ? "Approved" : item.status === "rejected" ? "Rejected" : item.status === "revised" ? "Changes requested" : item.status}
          </Badge>
          {item.decidedAt ? <RelTime iso={item.decidedAt} className="text-fg-3" /> : null}
          {item.note ? <span className="truncate">“{item.note}”</span> : null}
        </footer>
      )}
    </article>
  );
});
