"use client";
import { useMemo, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { addCompetitors, bareHandle, parseHandleList, SETUP_PLATFORMS, type SetupPlatform } from "@attentionos/module-onboarding/handles";
import { Button, cn } from "@/components/ui";
import { NOTICES } from "@/components/settings/notices";
import { PlatformGlyph } from "@/motion";
import { saveCompetitorsAction, suggestCompetitorsAction } from "@/server/actions/onboarding";
import { AgentWorking, ChipsInput, isActive, StepFooter, StepHeader, useRefreshWhile, useSetupAction } from "./parts";
import type { StepProps } from "./wizard";

const LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn", x: "X", facebook: "Facebook", threads: "Threads" };
const MAX = 10;

type Entry = { handle: string; platform: SetupPlatform; tier: "core" | "adjacent" | "aspirational" | "remake"; notes?: string };

const REASON: Record<string, string> = {
  own: "is your own account",
  duplicate: "is already on the list",
  full: `would go over ${MAX} on this platform`,
  invalid: "doesn't look like a handle",
};

/** Step 4: who the Analyst learns from (3 to 10 per platform), with suggestions and the scraping notice inline. */
export function CompetitorsStep({ view, nav }: StepProps) {
  const st = view.state.data.strategy;
  const suggestRun = st.suggestRunId ? view.runs[st.suggestRunId] : undefined;
  const suggesting = isActive(suggestRun);
  useRefreshWhile(suggesting, 3000);
  const { run: act, pending } = useSetupAction();

  const own = view.state.data.content.handles;
  // The owner's platforms first, then the rest.
  const platforms = useMemo(() => [...SETUP_PLATFORMS].sort((a, b) => Number(!own[a]) - Number(!own[b])), [own]);
  const [tab, setTab] = useState<SetupPlatform>(platforms[0] ?? "instagram");
  const [list, setList] = useState<Entry[]>(() => {
    const saved = st.competitors.length ? st.competitors : view.tracked;
    return saved
      .filter((c) => (SETUP_PLATFORMS as readonly string[]).includes(c.platform))
      .map((c): Entry => ({ handle: c.handle, platform: c.platform as SetupPlatform, tier: "tier" in c ? (c.tier as Entry["tier"]) : "core", ...("notes" in c && typeof c.notes === "string" && c.notes ? { notes: c.notes } : {}) }));
  });
  const [note, setNote] = useState<string | null>(null);
  const needsAck = (view.scraper === "apify" || view.scraper === "ytdlp") && !view.scrapingAcknowledged;
  const [ack, setAck] = useState(!needsAck);

  const add = (platform: SetupPlatform, text: string, extra?: Partial<Entry>) => {
    const r = addCompetitors(list, platform, parseHandleList(platform, text).length ? parseHandleList(platform, text) : [text], {
      own,
      max: MAX,
      make: (c): Entry => ({ tier: "core", ...extra, handle: c.handle, platform: c.platform as SetupPlatform }),
    });
    setList(r.list);
    setNote(r.skipped.length ? r.skipped.map((s) => `${s.handle} ${REASON[s.reason]}`).join(". ") + "." : null);
  };
  const remove = (key: string) => setList((xs) => xs.filter((c) => `${c.platform}:${bareHandle(c.handle)}` !== key));

  const onTab = list.filter((c) => c.platform === tab);
  const suggestions = (st.suggestions?.competitors ?? []).filter(
    (s) => (SETUP_PLATFORMS as readonly string[]).includes(s.platform) && !list.some((c) => c.platform === s.platform && bareHandle(c.handle) === bareHandle(s.handle)),
  );
  const scannable = view.scrapable.includes(tab);
  const total = list.length;
  const thin = platforms.filter((p) => own[p] && view.scrapable.includes(p)).some((p) => list.filter((c) => c.platform === p).length < 3);

  const save = () => void nav.finish(() => saveCompetitorsAction({ competitors: list, acknowledge: needsAck && ack }));

  return (
    <div className="flex flex-1 flex-col">
      <StepHeader
        title="Who should your team learn from?"
        lede="Three to ten creators per platform who make the kind of posts you want to make. The Analyst finds their outliers, posts that did far better than their usual, and studies why. Never the words."
      />

      <div className="mt-10 flex flex-col gap-4">
        <div role="tablist" aria-label="Platform" className="flex gap-1 overflow-x-auto rounded-md border border-border bg-surface-2 p-1">
          {platforms.map((p) => {
            const n = list.filter((c) => c.platform === p).length;
            return (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={tab === p}
                onClick={() => setTab(p)}
                className={cn(
                  "inline-flex min-h-9 shrink-0 items-center gap-2 rounded-[7px] px-3 text-small font-medium transition-colors duration-[120ms]",
                  tab === p ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg",
                )}
              >
                <PlatformGlyph platform={p} />
                {LABEL[p]}
                {n ? <span className="tabular text-caption text-fg-3">{n}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2" role="tabpanel" aria-label={`${LABEL[tab]} creators`}>
          <ChipsInput
            id="competitor-input"
            label={`Add ${LABEL[tab]} creators`}
            placeholder={`Type or paste ${LABEL[tab]} handles, like @creator`}
            items={onTab.map((c) => ({ key: `${c.platform}:${bareHandle(c.handle)}`, label: c.handle, ...(c.notes ? { hint: c.notes } : {}) }))}
            onAdd={(text) => add(tab, text)}
            onRemove={remove}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-fg-3">
            <span className="tabular">
              {onTab.length} of {MAX} on {LABEL[tab]}
              {onTab.length > 0 && onTab.length < 3 ? " · 3 or more gives the Analyst enough to compare" : ""}
            </span>
            {!scannable ? <span>{view.scrapable.length ? `${LABEL[tab]} can't be scanned yet; these are saved for the Strategist.` : "Scanning needs a scraper (Apify)."}</span> : null}
          </div>
          {note ? <p className="text-small text-warning">{note}</p> : null}
        </div>

        {suggestions.length ? (
          <section aria-label="Suggested creators" className="rounded-lg border border-dashed border-border-strong p-4">
            <p className="text-small font-medium text-fg">Suggested by the Analyst</p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <li key={`${s.platform}:${s.handle}`}>
                  <button
                    type="button"
                    title={s.why}
                    onClick={() => add(s.platform as SetupPlatform, s.handle, { tier: s.tier, ...(s.why ? { notes: s.why } : {}) })}
                    className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-border bg-surface-1 px-2.5 text-small text-fg hover:border-border-strong"
                  >
                    <span className="text-fg-2">
                      <PlatformGlyph platform={s.platform} size={14} />
                    </span>
                    {s.handle}
                    <Plus className="size-3.5 text-fg-3" strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {suggesting || suggestRun?.status === "failed" ? <AgentWorking agent="analyst" run={suggestRun} fallback="Searching the web for creators in your niche" /> : null}
        {!suggesting ? (
          <Button variant="ghost" className="self-start" disabled={pending} onClick={() => void act(() => suggestCompetitorsAction(), { quiet: true })}>
            <Sparkles className="size-4" strokeWidth={1.75} />
            {st.suggestions ? "Suggest more" : "Suggest some"}
          </Button>
        ) : null}

        {needsAck ? (
          <section className="mt-2 rounded-lg border border-border bg-surface-1 p-4 md:p-5" aria-labelledby="notice-title">
            <h2 id="notice-title" className="text-body font-medium text-fg">
              {NOTICES.scrapingTerms!.title}
            </h2>
            <p className="mt-1 text-small text-fg-2">
              {NOTICES.scrapingTerms!.body} During setup it also reads your own public posts from the handles you gave.
            </p>
            <label className="mt-3 flex min-h-11 items-center gap-3 text-small text-fg">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="size-4 accent-brand" />
              I understand, read public posts for me
            </label>
            {!ack ? <p className="text-caption text-fg-3">Without this, the scan waits and your posts come from Zernio only (if connected).</p> : null}
          </section>
        ) : null}
      </div>

      <StepFooter
        busy={nav.busy || pending}
        onBack={nav.back}
        onSkip={nav.skip}
        secondary={total && thin ? <span className="text-caption text-fg-3 md:mr-2">Fewer than 3 on a platform works, just with less to compare.</span> : null}
        primary={{ label: total ? `Save ${total} creator${total === 1 ? "" : "s"}` : "Continue without competitors", onClick: save }}
      />
    </div>
  );
}
