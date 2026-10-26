// Unfinished feature: the Film page (what to shoot, a teleprompter per script, uploaded takes matched to scripts). Not wired into Studio yet; kept for a later release. See components/UNFINISHED.md.
"use client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Camera, Check, ChevronDown, Clock, PenLine, Plus, ScrollText, Upload } from "lucide-react";
import type { FilmData, FilmIdea, FilmScript } from "@/server/queries/film";
import { scriptableIdeas } from "@/server/queries/film-groups";
import { markFilmedAction, newIdeaAction, writeScriptsAction } from "@/server/actions/film";
import { decideApprovalAction } from "@/server/actions/approvals";
import { Badge, Button, Input, Textarea, buttonClass, cn } from "@/components/ui";
import { AgentMonogram } from "@/motion";
import { who } from "@/components/shell/format";
import { useLive } from "@/lib/use-live";
import { useToast } from "@/components/shell/toast";
import { useUploads } from "@/components/upload/upload-provider";
import { DropZone, TakesList } from "@/components/upload/takes-list";
import { AutoRefresh } from "@/components/production/auto-refresh";
import { Teleprompter } from "./teleprompter";

const EASE = [0.2, 0.8, 0.2, 1] as const;

function deadline(iso: string | null, tz: string): { text: string; urgent: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  const hours = (d.getTime() - Date.now()) / 3_600_000;
  const day = d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
  if (hours < 0) return { text: `Was due ${day}`, urgent: true };
  if (hours < 24) return { text: `Film by ${d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })} today`, urgent: true };
  return { text: `Film by ${day}`, urgent: false };
}

function ScriptCard({ s, index, tz, onPrompt }: { s: FilmScript; index: number; tz: string; onPrompt: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { add } = useUploads();
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<null | "script" | "shoot">(null);
  const [busy, setBusy] = useState(false);
  const due = deadline(s.filmBy, tz);
  const filmed = Boolean(s.filmedAt);

  const mark = async () => {
    setBusy(true);
    const r = await markFilmedAction(s.id, !filmed);
    setBusy(false);
    toast(r.ok ? r.message ?? "Saved" : r.error, r.ok ? "ok" : "error");
    router.refresh();
  };

  return (
    <li className="rounded-lg border border-border bg-surface-1 p-5 max-sm:p-4" data-script={s.id}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="grid size-6 place-items-center rounded-full bg-surface-3 text-caption font-medium text-fg-2 tabular" aria-label={`Script ${index + 1}`}>
          {index + 1}
        </span>
        {s.formatName ? <span className="text-small text-fg-3">{s.formatName}</span> : null}
        {s.keyword ? <Badge tone="neutral" className="font-mono text-[11px] tracking-normal">{s.keyword}</Badge> : null}
        <span className="ml-auto flex items-center gap-2">
          {s.takes ? <Badge tone="success">{s.takes} {s.takes === 1 ? "take" : "takes"} in</Badge> : filmed ? <Badge tone="info">Filmed, waiting for the take</Badge> : null}
          {due ? (
            <span className={cn("inline-flex items-center gap-1.5 text-small", due.urgent ? "font-medium text-warning" : "text-fg-2")}>
              <Clock className="size-3.5" strokeWidth={1.75} />
              {due.text}
            </span>
          ) : null}
        </span>
      </div>

      <h3 className="mt-3 text-[19px] font-medium leading-[26px] tracking-[-0.005em] text-fg">{s.title}</h3>
      {s.hook ? <p className="mt-3 border-l-2 border-brand pl-3 text-[16px] leading-6 text-fg">“{s.hook}”</p> : null}
      {s.why ? <p className="mt-2 text-small text-fg-2">{s.why}</p> : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onPrompt}>
          <ScrollText className="size-4" strokeWidth={1.75} /> Teleprompter
        </Button>
        <Button variant="secondary" onClick={() => file.current?.click()}>
          <Upload className="size-4" strokeWidth={1.75} /> Upload take
        </Button>
        <Button variant="ghost" onClick={mark} disabled={busy} aria-pressed={filmed}>
          <Check className={cn("size-4", filmed && "text-success")} strokeWidth={2} /> {filmed ? "Filmed" : "Mark as filmed"}
        </Button>
        <input
          ref={file}
          type="file"
          accept="video/*,.mov,.mp4,.m4v,.webm,.mkv"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) {
              const n = add(e.target.files, { contentId: s.id });
              if (n) toast(`Uploading ${n === 1 ? "the take" : `${n} takes`} for “${s.title}”. The edit starts when it's in.`);
            }
            e.target.value = "";
          }}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3">
        {(["script", "shoot"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k} className="flex items-center gap-1.5 py-1 text-small text-fg-2 hover:text-fg">
            <ChevronDown className={cn("size-4 transition-transform duration-200", open === k && "rotate-180")} strokeWidth={1.5} />
            {k === "script" ? "Full script" : "How to film it"}
          </button>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div key={open} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            {open === "script" ? (
              <div className="flex flex-col gap-2 pt-3 text-[15px] leading-6 text-fg">
                {s.body.split(/\n+/).filter(Boolean).map((p, i) => (
                  <p key={i} className={i === 0 ? "font-medium" : undefined}>
                    {p}
                  </p>
                ))}
              </div>
            ) : s.shoot ? (
              <dl className="grid gap-x-6 gap-y-3 pt-3 sm:grid-cols-[120px_1fr]">
                {s.shoot.sections.map((sec) => (
                  <div key={sec.label} className="contents">
                    <dt className="text-small text-fg-3">{sec.label}</dt>
                    <dd className="text-small text-fg">
                      {sec.text ? <p>{sec.text}</p> : null}
                      {sec.bullets.length ? (
                        <ul className="mt-1 flex flex-col gap-1.5">
                          {sec.bullets.map((b) => (
                            <li key={b} className="flex gap-2">
                              <Camera className="mt-1 size-3 shrink-0 text-fg-3" strokeWidth={1.5} />
                              {b}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="pt-3 text-small text-fg-2">Vertical (9:16), eyes on the lens, quiet room. Say the hook first; the last full take wins.</p>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Live line for the Copywriter: how many scripts are on the way and the latest thing it reported. */
function CopywriterProgress({ c }: { c: FilmData["copywriter"] }) {
  const { events } = useLive();
  const total = c.running + c.queued;
  const since = useMemo(() => Date.now() - 10 * 60_000, []);
  const latest = [...events].reverse().find((e) => e.agent === "copywriter" && (e.kind === "progress" || e.kind === "handoff") && Date.parse(e.ts) > since);
  if (!total) return null;
  const w = who("copywriter");
  const head = c.running
    ? `${w.name} is writing ${c.running + c.queued === 1 ? "a script" : plural(c.running + c.queued, "script")}…`
    : `${plural(c.queued, "script")} queued for the ${w.name}`;
  const detail = latest?.message ?? (c.titles.length ? c.titles.map((t) => `“${t}”`).join(", ") : null);
  return (
    <div role="status" aria-live="polite" className="mb-6 flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3 signal-left">
      <AgentMonogram agent={{ monogram: w.monogram, name: w.name, state: c.running ? "working" : "waiting" }} size={32} />
      <div className="min-w-0 flex-1">
        <p className="text-small font-medium text-fg">{head}</p>
        {detail ? <p className="truncate text-caption text-fg-3">{detail}</p> : null}
      </div>
      {!c.running ? <span className="hidden text-caption text-fg-3 sm:inline">Starts within minutes</span> : null}
    </div>
  );
}

function ClaimBadges({ claims }: { claims: FilmScript["claims"] }) {
  if (!claims.pass && !claims.fix && !claims.cut) return null;
  return (
    <span className="flex items-center gap-1.5" title="Claim ledger: every number traced to a source">
      {claims.pass ? <Badge tone="success">{plural(claims.pass, "claim")} checked</Badge> : null}
      {claims.fix ? <Badge tone="warning">{claims.fix} to fix</Badge> : null}
      {claims.cut ? <Badge tone="neutral">{claims.cut} cut</Badge> : null}
    </span>
  );
}

/** A script that passed every check and waits for the owner's OK; approving moves it to Ready to film. */
function WaitingCard({ s }: { s: FilmScript }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const approve = async () => {
    if (!s.approval) return;
    setBusy(true);
    const r = await decideApprovalAction(s.approval.id, "approved");
    setBusy(false);
    toast(r.ok ? (r.message ?? "Approved") : r.error, r.ok ? "ok" : "error");
    router.refresh();
  };
  return (
    <li className="rounded-lg border border-border bg-surface-1 p-4" data-waiting={s.id}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {s.formatName ? <span className="text-small text-fg-3">{s.formatName}</span> : null}
        {s.version && s.version > 1 ? <Badge tone="neutral">Version {s.version}</Badge> : null}
        {s.keyword ? <Badge tone="neutral" className="font-mono text-[11px] tracking-normal">{s.keyword}</Badge> : null}
        <span className="ml-auto">
          <ClaimBadges claims={s.claims} />
        </span>
      </div>
      <h3 className="mt-2 text-[17px] font-medium leading-6 text-fg">{s.title}</h3>
      {s.hook ? <p className="mt-2 border-l-2 border-brand pl-3 text-[15px] leading-6 text-fg">“{s.hook}”</p> : null}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="flex flex-col gap-2 pt-3 text-[15px] leading-6 text-fg">
              {s.body.split(/\n+/).filter(Boolean).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={approve} disabled={busy || !s.approval} className="max-sm:flex-1">
          <Check className="size-4" strokeWidth={2} /> {busy ? "Approving" : "Approve"}
        </Button>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex h-8 items-center gap-1.5 px-2 text-small text-fg-2 hover:text-fg">
          <ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} strokeWidth={1.5} />
          {open ? "Hide script" : "Read it"}
        </button>
        {s.approval ? (
          <Link href={`/approvals#${s.approval.ref}`} className="ml-auto flex h-8 items-center px-2 text-small text-fg-2 underline decoration-border-strong underline-offset-4 hover:text-fg">
            Request changes
          </Link>
        ) : null}
      </div>
    </li>
  );
}

const IDEA_STATE: Record<FilmIdea["state"], { label: string; tone: "info" | "neutral" | "warning" | "danger" } | null> = {
  new: null,
  writing: { label: "Writing…", tone: "info" },
  rejected: { label: "Script rejected", tone: "neutral" },
  needs_fix: { label: "Draft needs a fix", tone: "warning" },
  draft: { label: "Draft saved", tone: "neutral" },
};

function IdeaRow({ idea, tz, busy, onWrite }: { idea: FilmIdea; tz: string; busy: boolean; onWrite: () => void }) {
  const due = deadline(idea.filmBy, tz);
  const state = IDEA_STATE[idea.state];
  return (
    <li className="flex items-center gap-3 px-4 py-3 max-sm:flex-wrap" data-idea={idea.id}>
      <div className="min-w-0 flex-1 max-sm:basis-full">
        <p className="text-[15px] leading-6 text-fg sm:truncate">{idea.title}</p>
        <p className="flex flex-wrap items-center gap-x-2 text-caption text-fg-3">
          {[idea.kind, idea.formatName].filter(Boolean).join(" · ")}
          {due ? <span className={cn(due.urgent && "text-warning")}>{due.text}</span> : null}
        </p>
      </div>
      {state ? (
        <Badge tone={state.tone} className={cn(idea.state === "writing" && "signal-pulse")}>
          {state.label}
        </Badge>
      ) : null}
      {idea.state === "writing" ? null : idea.state === "needs_fix" || idea.state === "draft" ? (
        <span className="flex items-center gap-1">
          <Link href={`/content/${idea.id}`} className={buttonClass("ghost", "sm")}>
            Open
          </Link>
          <Button size="sm" variant="ghost" onClick={onWrite} disabled={busy}>
            Rewrite
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="ghost" onClick={onWrite} disabled={busy}>
          <PenLine className="size-3.5" strokeWidth={1.75} /> {idea.state === "rejected" ? "Write again" : "Write script"}
        </Button>
      )}
    </li>
  );
}

function NewIdea() {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [withNotes, setWithNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const r = await newIdeaAction({ title, notes });
    setBusy(false);
    toast(r.ok ? (r.message ?? "Added") : r.error, r.ok ? "ok" : "error");
    if (r.ok) {
      setTitle("");
      setNotes("");
      setWithNotes(false);
      router.refresh();
    }
  };
  return (
    <form
      className="flex flex-col gap-2 border-t border-border px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="new-idea" className="sr-only">
        New idea
      </label>
      <div className="flex items-center gap-2 max-sm:flex-wrap">
        <Input id="new-idea" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New idea: a working title" maxLength={140} className="h-9 min-w-0 flex-1 text-[14px]" />
        <div className="flex items-center gap-2 max-sm:w-full">
          {!withNotes ? (
            <Button size="sm" variant="ghost" onClick={() => setWithNotes(true)} className="max-sm:flex-1">
              Add notes
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" type="submit" disabled={busy || title.trim().length < 4} className="max-sm:flex-1">
            <Plus className="size-4" strokeWidth={1.75} /> {busy ? "Adding" : "Add and write"}
          </Button>
        </div>
      </div>
      {withNotes ? (
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="The angle, a story to tell, a number from your proof (optional)"
          maxLength={1000}
          className="min-h-16 text-[14px]"
          autoFocus
        />
      ) : null}
    </form>
  );
}

/** Ideas without a script yet, the button that asks the Copywriter for today's scripts, and a quick "new idea". */
function IdeasSection({ ideas, tz }: { ideas: FilmIdea[]; tz: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const write = async (ids: string[], key: string) => {
    setBusy(key);
    const r = await writeScriptsAction(ids);
    setBusy(null);
    toast(r.ok ? (r.message ?? "Queued") : r.error, r.ok ? "ok" : "error");
    router.refresh();
  };
  const today = scriptableIdeas(ideas, 5);
  return (
    <section aria-labelledby="ideas" className="mt-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="ideas" className="text-h2 font-medium text-fg">
          Ideas to script
          {ideas.length ? <span className="ml-2 text-fg-3 tabular">{ideas.length}</span> : null}
        </h2>
        {today.length ? (
          <Button variant="primary" onClick={() => write(today.map((i) => i.id), "all")} disabled={busy !== null} className="max-sm:w-full">
            <PenLine className="size-4" strokeWidth={1.75} />
            {busy === "all" ? "Asking the Copywriter" : `Write scripts for today${today.length > 1 ? ` (${today.length})` : ""}`}
          </Button>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
        {ideas.length ? (
          <ul className="divide-y divide-border">
            {ideas.map((i) => (
              <IdeaRow key={i.id} idea={i} tz={tz} busy={busy !== null} onWrite={() => write([i.id], i.id)} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-4 text-small text-fg-2">No open ideas. The Strategist plans tomorrow's at 6am, or add one here.</p>
        )}
        <NewIdea />
      </div>
    </section>
  );
}

/** Film: what to shoot, a teleprompter for each script, and the takes you've uploaded with the script each matched. */
export function FilmView({ data, scripts }: { data: FilmData; scripts: { id: string; title: string; status: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const { items, active } = useUploads();
  const [prompt, setPrompt] = useState<FilmScript | null>(null);
  const hasTakes = data.uploads.length > 0 || items.length > 0;
  // Takes that need a decision (or are uploading) come first; otherwise the scripts to film lead.
  const takesFirst = items.some((x) => x.status !== "done") || data.uploads.some((u) => ["matching", "suggested", "unmatched", "failed"].includes(u.status));
  const matching = data.uploads.some((u) => u.status === "matching" || (u.role === "edit" && ["queued", "prepping"].includes(u.editStatus ?? "")));

  return (
    <>
      <AutoRefresh active={matching || active > 0 || data.copywriter.running + data.copywriter.queued > 0} agents={["art_director", "publisher", "copywriter"]} />
      <div className="grid grid-cols-1 gap-8 @5xl:grid-cols-12 @5xl:gap-6">
        <section aria-labelledby="takes" className={cn(takesFirst ? "order-1" : "order-2", "@5xl:order-2 @5xl:col-span-5")}>
          <div className="@5xl:sticky @5xl:top-6">
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 id="takes" className="text-h2 font-medium text-fg">
                Your takes
                {data.uploads.length ? <span className="ml-2 text-fg-3 tabular">{data.uploads.length}</span> : null}
              </h2>
              {!data.editingOn ? <span className="text-small text-warning">Editing is off in settings</span> : null}
            </div>
            <div className="flex flex-col gap-3">
              <DropZone compact={hasTakes || data.scripts.length > 0} />
              <TakesList uploads={data.uploads} scripts={scripts} />
            </div>
            {!data.ready ? (
              <p className="mt-3 text-small text-fg-2">Turn on the production module to match takes to scripts automatically. Uploads still start an edit.</p>
            ) : null}
          </div>
        </section>

        <div className={cn(takesFirst ? "order-2" : "order-1", "@5xl:order-1 @5xl:col-span-7")}>
        <CopywriterProgress c={data.copywriter} />
        <section aria-labelledby="ready">
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 id="ready" className="text-h2 font-medium text-fg">
              Ready to film
              {data.scripts.length ? <span className="ml-2 text-fg-3 tabular">{data.scripts.length}</span> : null}
            </h2>
          </div>
          {data.scripts.length ? (
            <ol className="flex flex-col gap-3">
              {data.scripts.map((s, i) => (
                <ScriptCard key={s.id} s={s} index={i} tz={data.tz} onPrompt={() => setPrompt(s)} />
              ))}
            </ol>
          ) : (
            <div className="rounded-lg border border-dashed border-border-strong px-6 py-8 text-center">
              <p className="text-h3 font-medium text-fg">Nothing approved to film yet</p>
              <p className="mx-auto mt-1 max-w-sm text-small text-fg-2">
                {data.waiting.length
                  ? "Approve a script below and it moves here with a teleprompter and shoot notes."
                  : data.copywriter.running + data.copywriter.queued
                    ? "Scripts land below for your OK as the Copywriter finishes them."
                    : data.ideas.some((i) => i.state === "new")
                      ? "Ask the Copywriter for today's scripts below. You can still upload any take and edit it without a script."
                      : "Approved scripts show up here with a teleprompter and shoot notes. You can still upload any take and edit it without a script."}
              </p>
            </div>
          )}
        </section>

        {data.waiting.length ? (
          <section aria-labelledby="waiting" className="mt-10">
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 id="waiting" className="text-h2 font-medium text-fg">
                Waiting for your OK
                <span className="ml-2 text-fg-3 tabular">{data.waiting.length}</span>
              </h2>
              <Link href="/approvals" className="text-small text-fg-2 hover:text-fg">
                Open approvals
              </Link>
            </div>
            <ul className="flex flex-col gap-3">
              {data.waiting.map((s) => (
                <WaitingCard key={s.id} s={s} />
              ))}
            </ul>
          </section>
        ) : null}

        <IdeasSection ideas={data.ideas} tz={data.tz} />
        </div>
      </div>
      {prompt ? (
        <Teleprompter
          title={prompt.title}
          hook={prompt.hook}
          body={prompt.body}
          onClose={() => setPrompt(null)}
          onFilmed={async () => {
            const r = await markFilmedAction(prompt.id, true);
            toast(r.ok ? r.message ?? "Marked as filmed" : r.error, r.ok ? "ok" : "error");
            setPrompt(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
