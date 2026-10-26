"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Clapperboard, MessageSquareText, PenLine, RotateCcw, Trash2, X } from "lucide-react";
import type { ScriptItem } from "@/server/queries/scripts";
import { approveScriptAction, deleteScriptAction, reviseScriptAction, saveOwnEditAction } from "@/server/actions/scripts";
import { markFilmedAction, writeScriptsAction } from "@/server/actions/film";
import { Button, Input, Textarea, cn } from "@/components/ui";
import { useToast } from "@/components/shell/toast";
import { PLATFORM_LABEL } from "@/components/shell/format";
import { StateBadge, filmByText, restOfBody } from "./shared";

const EASE = [0.2, 0.8, 0.2, 1] as const;

type Panel = null | "change" | "edit" | "delete";

/** One script, opened: the whole thing to read, and what you can do with it. */
export function ScriptDrawer({ item, tz, onClose, onFilm, covered = false }: { item: ScriptItem | null; tz: string; onClose: () => void; onFilm: (s: ScriptItem) => void; covered?: boolean }) {
  useEffect(() => {
    // While the teleprompter covers the drawer, Esc is its own.
    if (!item || covered) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose, covered]);

  return (
    <AnimatePresence>
      {item ? (
        <>
          <motion.div
            key="scrim"
            className="fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--bg)_55%,transparent)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.aside
            key="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={item.title}
            className="fixed inset-x-0 bottom-0 z-50 max-h-[92vh] overflow-y-auto overscroll-contain rounded-t-xl border border-border bg-surface-2 shadow-[var(--shadow-3)] md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[520px] md:rounded-none md:rounded-l-xl"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.32, ease: EASE }}
          >
            <Body key={item.id} item={item} tz={tz} onClose={onClose} onFilm={onFilm} />
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}

function Body({ item, tz, onClose, onFilm }: { item: ScriptItem; tz: string; onClose: () => void; onFilm: (s: ScriptItem) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [hook, setHook] = useState(item.hook ?? "");
  const [rest, setRest] = useState(restOfBody(item));
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const due = item.state === "filmed" ? null : filmByText(item.filmBy, tz);
  const hasScript = item.version !== null;
  const working = item.state === "writing" || item.rewriting;

  useEffect(() => {
    closeBtn.current?.focus();
  }, []);

  // A fresh version arrived while open: the edit fields follow it unless you're editing.
  useEffect(() => {
    if (panel === "edit") return;
    setHook(item.hook ?? "");
    setRest(restOfBody(item));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.version, item.hook, item.body]);

  const run = async (key: string, fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, after?: () => void) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    toast(r.ok ? (r.message ?? "Done") : r.error, r.ok ? "ok" : "error");
    if (r.ok) after?.();
    router.refresh();
  };

  const paras = restOfBody(item).split(/\n+/).map((p) => p.trim()).filter(Boolean);

  return (
    <div className="flex flex-col gap-6 p-6 pb-24 max-sm:p-4 max-sm:pb-24">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge item={item} />
            {[item.formatName ?? item.kind].filter(Boolean).map((x) => (
              <span key={x} className="text-small text-fg-3">
                {x}
              </span>
            ))}
          </div>
          <h2 className="mt-2 text-h2 font-medium text-fg">{item.title}</h2>
          {item.basedOn ? (
            <p className="mt-1 text-small text-fg-2">
              <a href={item.basedOn.url} target="_blank" rel="noreferrer noopener" className="underline decoration-border underline-offset-2 hover:text-fg">
                {item.basedOn.line}
              </a>
            </p>
          ) : null}
          <p className="mt-1 flex flex-wrap gap-x-3 text-caption text-fg-3">
            {due ? <span className={cn(due.urgent && "font-medium text-warning")}>{due.text}</span> : null}
            {hasScript ? <span>{item.byYou ? `Version ${item.version}, written by you` : `Version ${item.version}, written by the AI`}</span> : null}
          </p>
        </div>
        <button ref={closeBtn} type="button" onClick={onClose} className="-mr-2 -mt-1 grid size-9 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      {working ? (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
          <span className="size-2 shrink-0 rounded-full bg-info signal-pulse" aria-hidden />
          <p className="text-small text-fg">
            {item.rewriting ? "Rewriting with your notes… The new version comes back here for your OK." : "Writing… It shows up here for your OK in a few minutes."}
          </p>
        </div>
      ) : null}

      {item.state === "stuck" ? (
        <div className="rounded-lg border border-border bg-surface-1 px-4 py-3">
          <p className="text-small text-fg">The AI couldn&apos;t finish this one.</p>
          <Button size="sm" variant="secondary" className="mt-3" disabled={busy !== null} onClick={() => run("retry", () => writeScriptsAction([item.id]))}>
            <RotateCcw className="size-3.5" strokeWidth={1.75} /> {busy === "retry" ? "Asking" : "Try again"}
          </Button>
        </div>
      ) : null}

      {item.state === "draft" ? (
        <p className="rounded-lg border border-border bg-surface-1 px-4 py-3 text-small text-fg-2">
          This draft didn&apos;t pass every check. Tell the AI what to change, or fix it yourself.
        </p>
      ) : null}

      {!hasScript && item.why ? (
        <section>
          <h3 className="text-small font-medium text-fg-3">What you asked for</h3>
          <p className="mt-1 whitespace-pre-line text-[15px] leading-6 text-fg">{item.why}</p>
        </section>
      ) : null}

      {hasScript && panel !== "edit" ? (
        <article className="flex flex-col gap-4">
          {item.hook ? (
            <div>
              <h3 className="text-caption font-medium uppercase tracking-[0.06em] text-fg-3">Hook</h3>
              <p className="mt-1.5 border-l-2 border-brand pl-3 text-[18px] font-medium leading-7 text-fg">{item.hook}</p>
            </div>
          ) : null}
          <div>
            <h3 className="text-caption font-medium uppercase tracking-[0.06em] text-fg-3">Script</h3>
            <div className="mt-1.5 flex flex-col gap-3 text-[15px] leading-[26px] text-fg">
              {paras.length ? paras.map((p, i) => <p key={i}>{p}</p>) : <p className="text-fg-3">Just the hook.</p>}
            </div>
          </div>
          {item.cta ? (
            <p className="text-small text-fg-2">
              <span className="text-fg-3">Call to action: </span>
              {item.cta}
            </p>
          ) : item.keyword ? (
            <p className="text-small text-fg-2">
              <span className="text-fg-3">Keyword: </span>
              {item.keyword}
            </p>
          ) : null}
          {item.captions.length ? (
            <div className="border-t border-border pt-3">
              <button type="button" onClick={() => setCaptionsOpen((o) => !o)} aria-expanded={captionsOpen} className="flex items-center gap-1.5 py-1 text-small text-fg-2 hover:text-fg">
                <ChevronDown className={cn("size-4 transition-transform duration-200", captionsOpen && "rotate-180")} strokeWidth={1.5} />
                Caption ideas
              </button>
              <AnimatePresence initial={false}>
                {captionsOpen ? (
                  <motion.dl initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="flex flex-col gap-3 overflow-hidden pt-2">
                    {item.captions.map((c) => (
                      <div key={c.platform}>
                        <dt className="text-caption text-fg-3">{PLATFORM_LABEL[c.platform] ?? c.platform}</dt>
                        <dd className="mt-0.5 whitespace-pre-line break-words text-small text-fg">{c.text}</dd>
                      </div>
                    ))}
                  </motion.dl>
                ) : null}
              </AnimatePresence>
            </div>
          ) : null}
        </article>
      ) : null}

      {panel === "edit" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run("edit", () => saveOwnEditAction(item.id, { hook, body: rest }), () => setPanel(null));
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-hook" className="text-small font-medium text-fg">
              Hook
            </label>
            <Input id="edit-hook" value={hook} onChange={(e) => setHook(e.target.value)} maxLength={400} autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-body" className="text-small font-medium text-fg">
              Script
            </label>
            <Textarea id="edit-body" value={rest} onChange={(e) => setRest(e.target.value)} maxLength={8000} className="min-h-64 text-[15px] leading-6" />
          </div>
          <p className="text-caption text-fg-3">Saving makes your version the one to film.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy !== null || (!hook.trim() && !rest.trim())} className="max-sm:flex-1">
              {busy === "edit" ? "Saving" : "Save my version"}
            </Button>
            <Button variant="ghost" onClick={() => setPanel(null)} className="max-sm:flex-1">
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {/* The one main thing to do next. */}
      {panel === null && item.state !== "writing" ? (
        <div className="flex flex-wrap gap-2">
          {item.state === "needs_ok" ? (
            <Button variant="primary" disabled={busy !== null} onClick={() => run("approve", () => approveScriptAction(item.id))} className="max-sm:flex-1">
              <Check className="size-4" strokeWidth={2} /> {busy === "approve" ? "Approving" : "Approve"}
            </Button>
          ) : null}
          {item.state === "ready" ? (
            <>
              <Button variant="primary" onClick={() => onFilm(item)} className="max-sm:flex-1">
                <Clapperboard className="size-4" strokeWidth={1.75} /> Film it
              </Button>
              <Button variant="secondary" disabled={busy !== null} onClick={() => run("filmed", () => markFilmedAction(item.id, true))} className="max-sm:flex-1">
                <Check className="size-4" strokeWidth={2} /> {busy === "filmed" ? "Saving" : "Mark as filmed"}
              </Button>
            </>
          ) : null}
          {item.state === "filmed" ? (
            <>
              <p className="w-full text-small text-fg-2">Filmed. Upload the footage on the Edit page and the editor takes it from there.</p>
              <Button variant="secondary" onClick={() => onFilm(item)} className="max-sm:flex-1">
                <Clapperboard className="size-4" strokeWidth={1.75} /> Film it again
              </Button>
              <Button variant="ghost" disabled={busy !== null} onClick={() => run("unfilm", () => markFilmedAction(item.id, false))} className="max-sm:flex-1">
                Not filmed yet
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {panel === "change" ? (
        <form
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run("change", () => reviseScriptAction(item.id, notes), () => {
              setNotes("");
              setPanel(null);
            });
          }}
        >
          <label htmlFor="change-notes" className="text-small font-medium text-fg">
            What should the AI change?
          </label>
          <Textarea
            id="change-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Punchier hook, cut the second half, mention the free guide at the end"
            maxLength={2000}
            autoFocus
          />
          {item.state === "ready" || item.state === "filmed" ? <p className="text-caption text-fg-3">This version stays ready to film until you approve the new one.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy !== null || !notes.trim()} className="max-sm:flex-1">
              {busy === "change" ? "Sending" : "Rewrite it"}
            </Button>
            <Button variant="ghost" onClick={() => setPanel(null)} className="max-sm:flex-1">
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {panel === "delete" ? (
        <div role="alertdialog" aria-labelledby="delete-q" className="flex flex-col gap-3 rounded-lg border border-[color-mix(in_srgb,var(--danger)_40%,var(--border))] bg-surface-1 p-4">
          <p id="delete-q" className="text-small text-fg">
            Delete “{item.title}”? It leaves your scripts.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" className="border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] max-sm:flex-1" disabled={busy !== null} autoFocus onClick={() => run("delete", () => deleteScriptAction(item.id), onClose)}>
              <Trash2 className="size-4" strokeWidth={1.75} /> {busy === "delete" ? "Deleting" : "Yes, delete it"}
            </Button>
            <Button variant="ghost" onClick={() => setPanel(null)} className="max-sm:flex-1">
              Keep it
            </Button>
          </div>
        </div>
      ) : null}

      {panel === null ? (
        <div className="flex flex-wrap gap-x-1 gap-y-1 border-t border-border pt-4">
          {hasScript && !working ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setPanel("change")}>
                <MessageSquareText className="size-4" strokeWidth={1.75} /> Tell the AI what to change
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPanel("edit")}>
                <PenLine className="size-4" strokeWidth={1.75} /> Edit it yourself
              </Button>
            </>
          ) : null}
          <Button variant="danger" size="sm" onClick={() => setPanel("delete")} className="ml-auto max-sm:ml-0">
            <Trash2 className="size-4" strokeWidth={1.75} /> Delete
          </Button>
        </div>
      ) : null}

      {item.why && hasScript ? (
        <details className="group text-small text-fg-2">
          <summary className="cursor-pointer list-none text-fg-3 hover:text-fg-2 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1.5">
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" strokeWidth={1.5} /> Why this script
            </span>
          </summary>
          <p className="mt-2 whitespace-pre-line">{item.why}</p>
        </details>
      ) : null}
      {item.byYou ? <p className="text-caption text-fg-3">You wrote this version, so the AI&apos;s checks weren&apos;t run on it.</p> : null}
    </div>
  );
}
