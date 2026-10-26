"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Clock, PenLine, Plus, Sparkles } from "lucide-react";
import type { ScriptItem, ScriptsData } from "@/server/queries/scripts";
import { markFilmedAction, writeScriptsAction } from "@/server/actions/film";
import { Button, cn } from "@/components/ui";
import { PageHeader } from "@/components/shell/page-header";
import { useToast } from "@/components/shell/toast";
import { AutoRefresh } from "@/components/production/auto-refresh";
import { Teleprompter } from "@/components/film/teleprompter";
import { NewScriptPanel, type NewMode } from "./new-script";
import { ScriptDrawer } from "./script-drawer";
import { StateBadge, filmByText, restOfBody } from "./shared";

type Filter = "all" | "needs" | "ready";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs your OK" },
  { id: "ready", label: "Ready to film" },
];
const matches = (f: Filter, s: ScriptItem) => (f === "all" ? true : f === "needs" ? s.state === "needs_ok" || s.state === "draft" : s.state === "ready");

const EASE = [0.2, 0.8, 0.2, 1] as const;

function ScriptCard({ item, tz, onOpen }: { item: ScriptItem; tz: string; onOpen: () => void }) {
  const due = item.state === "filmed" ? null : filmByText(item.filmBy, tz);
  const rest = restOfBody(item);
  const writingNew = item.state === "writing" && item.version === null;
  return (
    <motion.li layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE }}>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group flex h-full w-full flex-col rounded-lg border border-border bg-surface-1 p-5 text-left transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand max-sm:p-4",
          item.state === "needs_ok" && "signal-left",
        )}
        data-script={item.id}
      >
        <span className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <StateBadge item={item} />
          {item.formatName ?? item.kind ? <span className="text-small text-fg-3">{item.formatName ?? item.kind}</span> : null}
          {due ? (
            <span className={cn("ml-auto inline-flex items-center gap-1 text-caption", due.urgent ? "font-medium text-warning" : "text-fg-3")}>
              <Clock className="size-3.5" strokeWidth={1.75} />
              {due.text}
            </span>
          ) : null}
        </span>
        <span className="mt-3 block text-[17px] font-medium leading-6 text-fg">{item.title}</span>
        {writingNew ? (
          <span className="mt-3 flex flex-col gap-2" aria-hidden>
            <span className="h-3 w-11/12 rounded-sm bg-surface-3 signal-pulse" />
            <span className="h-3 w-4/5 rounded-sm bg-surface-3 signal-pulse" />
            <span className="h-3 w-3/5 rounded-sm bg-surface-3 signal-pulse" />
          </span>
        ) : item.state === "stuck" ? (
          <span className="mt-2 block text-small text-fg-2">The AI couldn&apos;t finish this one. Open it to try again.</span>
        ) : (
          <>
            {item.hook ? <span className="mt-2.5 block border-l-2 border-brand pl-3 text-[15px] leading-6 text-fg">“{item.hook}”</span> : null}
            {rest ? <span className="mt-2 line-clamp-2 text-small text-fg-2">{rest}</span> : null}
          </>
        )}
        <span className="mt-auto flex w-full items-center gap-2 pt-4 text-caption text-fg-3">
          {item.rewriting ? <span>Rewriting with your notes…</span> : item.version ? <span>{item.byYou ? "Written by you" : "Written by the AI"}{item.version > 1 ? `, version ${item.version}` : ""}</span> : <span>The AI is on it</span>}
          {item.keyword ? <span className="ml-auto font-mono text-[11px]">{item.keyword}</span> : null}
        </span>
      </button>
    </motion.li>
  );
}

/** Scripts: what the AI wrote, what you wrote, what needs your OK, and what's ready to film. */
export function ScriptsView({ data, initialOpen }: { data: ScriptsData; initialOpen?: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState<NewMode | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialOpen ?? null);
  const [prompt, setPrompt] = useState<ScriptItem | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useMemo(() => data.items.find((i) => i.id === openId) ?? null, [data.items, openId]);
  const shown = data.items.filter((i) => matches(filter, i));
  const counts = { all: data.items.length, needs: data.items.filter((i) => matches("needs", i)).length, ready: data.items.filter((i) => matches("ready", i)).length };
  const working = data.items.some((i) => i.state === "writing" || i.rewriting);
  const close = useCallback(() => {
    setOpenId(null);
    // Opened from a link: drop ?open= so a reload doesn't reopen it.
    if (window.location.search.includes("open=")) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Opened from a link (?open=<id>) to a script that's gone: drop it quietly.
  useEffect(() => {
    if (openId && !data.items.some((i) => i.id === openId)) setOpenId(null);
  }, [data.items, openId]);

  const writeToday = async () => {
    setBusy(true);
    const r = await writeScriptsAction(data.ideasWithoutScript.slice(0, 5));
    setBusy(false);
    toast(r.ok ? (r.message ?? "Asked the AI") : r.error, r.ok ? "ok" : "error");
    router.refresh();
  };

  const ideas = data.ideasWithoutScript.length;
  const n = (k: keyof typeof counts) => counts[k];
  const description = [
    n("needs") ? `${n("needs")} ${n("needs") === 1 ? "needs" : "need"} your OK` : null,
    n("ready") ? `${n("ready")} ready to film` : null,
    data.items.filter((i) => i.state === "writing").length ? `${data.items.filter((i) => i.state === "writing").length} being written` : null,
  ].filter(Boolean);

  return (
    <MotionConfig reducedMotion="user">
      <AutoRefresh active={working} agents={["copywriter"]} />
      <PageHeader
        title="Scripts"
        description={description.length ? `${description.join(", ").replace(/^./, (c) => c.toUpperCase())}.` : "What you'll say on camera. Ask the AI for one, or write your own."}
        actions={
          <>
            {ideas ? (
              <Button variant="ghost" onClick={writeToday} disabled={busy} className="max-sm:flex-1">
                <Sparkles className="size-4" strokeWidth={1.75} /> {busy ? "Asking the AI" : `Write scripts for today${ideas > 1 ? ` (${Math.min(ideas, 5)})` : ""}`}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setCreating((c) => (c ? null : "ai"))} aria-expanded={creating !== null} className="max-sm:flex-1">
              <Plus className="size-4" strokeWidth={2} /> New script
            </Button>
          </>
        }
      />

      <AnimatePresence initial={false}>
        {creating ? (
          <motion.div key="new" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
            <NewScriptPanel
              mode={creating}
              onMode={setCreating}
              onClose={() => setCreating(null)}
              onCreated={() => {
                setCreating(null);
                setFilter("all");
              }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {data.items.length ? (
        <>
          <div role="tablist" aria-label="Show" className="mb-5 flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-3 text-small font-medium transition-colors",
                  filter === f.id ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
                )}
              >
                {f.label}
                <span className={cn("tabular", filter === f.id ? "text-fg-2" : "text-fg-3")}>{counts[f.id]}</span>
              </button>
            ))}
          </div>
          {shown.length ? (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              <AnimatePresence initial={false}>
                {shown.map((i) => (
                  <ScriptCard key={i.id} item={i} tz={data.tz} onOpen={() => setOpenId(i.id)} />
                ))}
              </AnimatePresence>
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border-strong px-6 py-8 text-center text-small text-fg-2">
              {filter === "needs" ? "Nothing needs your OK right now." : "Nothing ready to film yet. Approve a script and it shows up here."}
            </p>
          )}
        </>
      ) : creating ? null : (
        <div className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
          <p className="text-h3 font-medium text-fg">No scripts yet. Ask the AI for one, or write your own.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => setCreating("ai")} className="max-sm:w-full">
              <Sparkles className="size-4" strokeWidth={1.75} /> Ask the AI
            </Button>
            <Button variant="secondary" onClick={() => setCreating("own")} className="max-sm:w-full">
              <PenLine className="size-4" strokeWidth={1.75} /> Write it myself
            </Button>
          </div>
        </div>
      )}

      <ScriptDrawer item={open} tz={data.tz} onClose={close} onFilm={(s) => setPrompt(s)} covered={prompt !== null} />

      {prompt ? (
        <Teleprompter
          title={prompt.title}
          hook={prompt.hook}
          body={prompt.body}
          onClose={() => setPrompt(null)}
          onFilmed={async () => {
            const r = await markFilmedAction(prompt.id, true);
            toast(r.ok ? "Marked as filmed. Upload the footage on the Edit page." : r.error, r.ok ? "ok" : "error");
            setPrompt(null);
            router.refresh();
          }}
        />
      ) : null}
    </MotionConfig>
  );
}
