"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Plus, Quote, Trash2 } from "lucide-react";
import type { BusinessDraft, OfferDraft, VoiceDraft } from "@attentionos/module-onboarding/state";
import { Badge, Button, Field, Input, Select, Textarea } from "@/components/ui";
import {
  approveAllAction,
  approveBusinessAction,
  approveVoiceAction,
  choosePresetAction,
  draftVoiceAction,
  reanalyzeSiteAction,
  saveLanesAction,
} from "@/server/actions/onboarding";
import { AgentWorking, isActive, ListEditor, StepFooter, StepHeader, useRefreshWhile, useSetupAction } from "./parts";
import type { StepProps } from "./wizard";

const CTA_OPTIONS: { value: OfferDraft["cta"]; label: string }[] = [
  { value: "book_call", label: "Book a call" },
  { value: "link_in_bio", label: "Buy or sign up online" },
  { value: "dm_keyword", label: "Send a message" },
  { value: "comment_keyword", label: "Comment a keyword" },
  { value: "follow", label: "Follow" },
  { value: "save_share", label: "Save or share" },
  { value: "none", label: "No call to action" },
];
const STAGE: Record<string, string> = { tofu: "Reach", mofu: "Trust", bofu: "Sale" };

function blankBusiness(view: StepProps["view"]): BusinessDraft {
  return {
    name: view.brand.name || view.workspaceName,
    oneLiner: view.brand.oneLiner,
    website: view.brand.website || view.state.data.business.url,
    offers: [],
    claimableResults: [],
    neverPromise: [],
    audience: { who: "", wants: "", stuck: "", quotes: [], objections: [], notFor: "" },
    summary: [],
    openQuestions: [],
  };
}

function Card({ title, by, approved, children, action }: { title: string; by: string; approved?: boolean | null; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col rounded-lg border border-border bg-surface-1 p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-h3 font-medium text-fg">{title}</h2>
          <p className="text-caption text-fg-3">{by}</p>
        </div>
        {approved === null ? null : approved ? <Badge tone="success">Approved</Badge> : <Badge tone="neutral">Draft</Badge>}
      </div>
      <div className="mt-5 flex flex-1 flex-col gap-4">{children}</div>
      {action ? <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-border pt-4">{action}</div> : null}
    </section>
  );
}

function BusinessCard({ view, value, onChange }: StepProps & { value: BusinessDraft; onChange: (d: BusinessDraft) => void }) {
  const b = view.state.data.business;
  const { run: act, pending } = useSetupAction();
  const set = <K extends keyof BusinessDraft>(k: K, v: BusinessDraft[K]) => onChange({ ...value, [k]: v });
  const setAud = <K extends keyof BusinessDraft["audience"]>(k: K, v: BusinessDraft["audience"][K]) => onChange({ ...value, audience: { ...value.audience, [k]: v } });
  const setOffer = (i: number, patch: Partial<OfferDraft>) => onChange({ ...value, offers: value.offers.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  return (
    <Card
      title="Your business"
      by={b.draft ? "Drafted by the Analyst from your website" : "Fill in the basics"}
      approved={Boolean(b.approvedAt)}
      action={
        <>
          {b.url ? (
            <Button variant="ghost" disabled={pending} onClick={() => void act(() => reanalyzeSiteAction(), { quiet: true })}>
              Read the site again
            </Button>
          ) : null}
          <Button variant="secondary" disabled={pending || !value.name.trim()} onClick={() => void act(() => approveBusinessAction(cleanOffers(value)))}>
            Approve
          </Button>
        </>
      }
    >
      {b.draft?.summary.length ? (
        <ul className="flex flex-col gap-1 rounded-md bg-surface-2 px-4 py-3 text-small text-fg-2">
          {b.draft.summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
      <Field label="Business name" htmlFor="b-name">
        <Input id="b-name" value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="Your business" />
      </Field>
      <Field label="What you do, in one sentence" htmlFor="b-one" hint="Who you help, and with what. Under 20 words.">
        <Textarea id="b-one" className="min-h-16" value={value.oneLiner} onChange={(e) => set("oneLiner", e.target.value)} />
      </Field>
      <div className="flex flex-col gap-3">
        <p className="text-small font-medium text-fg">Offers</p>
        {value.offers.map((o, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Input aria-label="Offer name" value={o.name} onChange={(e) => setOffer(i, { name: e.target.value })} placeholder="Offer name" className="flex-1" />
              <Button variant="ghost" size="sm" aria-label={`Remove ${o.name || "offer"}`} onClick={() => set("offers", value.offers.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" strokeWidth={1.75} />
              </Button>
            </div>
            <Textarea aria-label="Who it's for" className="min-h-14" value={o.whoFor} onChange={(e) => setOffer(i, { whoFor: e.target.value })} placeholder="Who it's for" />
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label="Price" value={o.price} onChange={(e) => setOffer(i, { price: e.target.value })} placeholder="Price (optional)" />
              <Select aria-label="How people start" value={o.cta} onChange={(e) => setOffer(i, { cta: e.target.value as OfferDraft["cta"] })}>
                {CTA_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ))}
        <Button
          variant="ghost"
          className="self-start"
          onClick={() => set("offers", [...value.offers, { id: `offer-${value.offers.length + 1}`, name: "", cta: "book_call", whoFor: "", whatTheyGet: "", price: "", howToStart: "" }])}
        >
          <Plus className="size-4" strokeWidth={1.75} />
          Add an offer
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-small font-medium text-fg">Ideal customer</p>
        <Textarea aria-label="Who they are" className="min-h-14" value={value.audience.who} onChange={(e) => setAud("who", e.target.value)} placeholder="Who they are" />
        <Textarea aria-label="What they want" className="min-h-14" value={value.audience.wants} onChange={(e) => setAud("wants", e.target.value)} placeholder="What they want" />
        <Textarea aria-label="What keeps them stuck" className="min-h-14" value={value.audience.stuck} onChange={(e) => setAud("stuck", e.target.value)} placeholder="What keeps them stuck" />
      </div>
    </Card>
  );
}

function cleanOffers(d: BusinessDraft): BusinessDraft {
  return {
    ...d,
    offers: d.offers.filter((o) => o.name.trim()).map((o, i) => ({ ...o, id: o.id && /^[a-z0-9][a-z0-9-]*$/.test(o.id) ? o.id : `offer-${i + 1}`, url: o.url?.trim() || undefined })),
  };
}

function VoiceCard({ view, value, onChange }: StepProps & { value: VoiceDraft; onChange: (d: VoiceDraft) => void }) {
  const v = view.state.data.voice;
  const { run: act, pending } = useSetupAction();
  const set = <K extends keyof VoiceDraft>(k: K, x: VoiceDraft[K]) => onChange({ ...value, [k]: x });
  return (
    <Card
      title="Your voice"
      by={`Drafted by the Copywriter from ${value.basedOnPosts} of your posts`}
      approved={Boolean(v.approvedAt)}
      action={
        <>
          <Button variant="ghost" disabled={pending} onClick={() => void act(() => draftVoiceAction(), { quiet: true })}>
            Draft again
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => void act(() => approveVoiceAction(value))}>
            Approve
          </Button>
        </>
      }
    >
      <Field label="How you sound, in one line" htmlFor="v-one">
        <Textarea id="v-one" className="min-h-16" value={value.oneLine} onChange={(e) => set("oneLine", e.target.value)} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="v-how" className="text-small font-medium text-fg">
          How you talk
        </label>
        <ListEditor id="v-how" items={value.howWeTalk} onChange={(x) => set("howWeTalk", x)} placeholder="Short sentences; opens with a direct claim" max={12} />
      </div>
      {value.signatureMoves.length ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="v-moves" className="text-small font-medium text-fg">
            Signature moves
          </label>
          <ListEditor id="v-moves" items={value.signatureMoves} onChange={(x) => set("signatureMoves", x)} placeholder="Counts points on fingers" max={8} />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="v-ban" className="text-small font-medium text-fg">
          Phrases you never use
        </label>
        <ListEditor id="v-ban" items={value.bannedPhrases} onChange={(x) => set("bannedPhrases", x)} placeholder="game changer" max={25} />
      </div>
      {value.examples.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-small font-medium text-fg">In your words</p>
          {value.examples.map((e) => (
            <blockquote key={e} className="flex gap-2 rounded-md bg-surface-2 px-3 py-2 text-small text-fg-2">
              <Quote className="mt-0.5 size-3.5 shrink-0 text-fg-3" strokeWidth={1.75} />
              <span>{e}</span>
            </blockquote>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function VoicePending({ view }: StepProps) {
  const d = view.state.data;
  const b = view.board;
  const { run: act, pending } = useSetupAction();
  const runId = d.voice.runId;
  const run = (runId ? view.runs[runId] : undefined) ?? (b?.runs.voice ? { ...b.runs.voice } : undefined);
  const waiting = b && b.own.transcribing > 0 ? `Waiting for ${b.own.transcribing} of your videos to be transcribed` : b?.own.posts ? "Waiting to start" : "Waiting for your posts";
  return (
    <Card title="Your voice" by="The Copywriter learns it from your own videos and captions">
      {isActive(run) || run?.status === "failed" ? (
        <AgentWorking agent="copywriter" run={run} fallback="Learning how you talk" />
      ) : (
        <AgentWorking agent="copywriter" run={undefined} fallback={waiting} />
      )}
      <p className="text-small text-fg-2">
        {d.start.at
          ? "It starts by itself once your transcripts are in. In a hurry? Draft it now from what's already here."
          : "Press Start in the previous step and it's drafted from your posts automatically."}
      </p>
      <Button variant="secondary" className="self-start" disabled={pending || isActive(run) || !b?.own.posts} onClick={() => void act(() => draftVoiceAction(), { quiet: true })}>
        Draft my voice now
      </Button>
    </Card>
  );
}

function LanesCard({ view, quotas, onChange }: StepProps & { quotas: Record<string, number>; onChange: (q: Record<string, number>) => void }) {
  const { run: act, pending } = useSetupAction();
  const preset = view.presets.find((p) => p.id === view.preset);
  const total = Object.values(quotas).reduce((a, n) => a + n, 0);
  return (
    <Card
      title="Content lanes"
      approved={null}
      by={`From the ${preset?.name.toLowerCase() ?? view.preset} preset · ${total} posts a week`}
      action={
        <Button variant="secondary" disabled={pending} onClick={() => void act(() => saveLanesAction(quotas))}>
          Save lanes
        </Button>
      }
    >
      {view.presets.length > 1 ? (
        <Field label="Starting point" htmlFor="preset" hint="Switching replaces your lanes and trend sources with the preset's.">
          <Select id="preset" value={view.preset} disabled={pending} onChange={(e) => void act(() => choosePresetAction(e.target.value))}>
            {view.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <ul className="flex flex-col divide-y divide-border">
        {view.lanes.map((l) => (
          <li key={l.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center md:gap-6">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-body text-fg">
                {l.name} <Badge tone="neutral">{STAGE[l.funnelStage] ?? l.funnelStage}</Badge>
              </p>
              <p className="text-small text-fg-2">{l.description}</p>
            </div>
            <label className="flex items-center gap-3 md:w-52">
              <span className="sr-only">{l.name} per week</span>
              <input
                type="range"
                min={0}
                max={7}
                step={1}
                value={quotas[l.id] ?? 0}
                onChange={(e) => onChange({ ...quotas, [l.id]: Number(e.target.value) })}
                className="h-11 flex-1 accent-[var(--text-secondary)]"
              />
              <span className="w-12 text-right text-small text-fg tabular">{quotas[l.id] ?? 0}/wk</span>
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Step 6: the agents' drafts side by side. Edit any card, approve one at a time or all at once. */
export function ReviewStep(props: StepProps) {
  const { view, nav } = props;
  const d = view.state.data;
  const siteRun = d.business.runId ? view.runs[d.business.runId] : undefined;
  const voiceRun = (d.voice.runId ? view.runs[d.voice.runId] : undefined) ?? view.board?.runs.voice;
  const siteWorking = isActive(siteRun);
  const voiceWaiting = !d.voice.draft && Boolean(d.start.at);
  useRefreshWhile(siteWorking || isActive(voiceRun) || voiceWaiting, 4000);

  // Each card keeps its own edits; a new draft from an agent starts that card fresh.
  const [business, setBusiness] = useState<{ key: string; value: BusinessDraft }>(() => ({ key: draftKey(d.business.draft), value: d.business.draft ?? blankBusiness(view) }));
  const [voice, setVoice] = useState<{ key: string; value: VoiceDraft } | null>(() => (d.voice.draft ? { key: draftKey(d.voice.draft), value: d.voice.draft } : null));
  const [quotas, setQuotas] = useState<Record<string, number>>(() => Object.fromEntries(view.lanes.map((l) => [l.id, l.weeklyQuota])));
  const businessValue = draftKey(d.business.draft) !== business.key && d.business.draft ? d.business.draft : business.value;
  const voiceValue = d.voice.draft && (!voice || draftKey(d.voice.draft) !== voice.key) ? d.voice.draft : voice?.value;

  const approveAll = () =>
    void nav.finish(() =>
      approveAllAction({
        ...(businessValue.name.trim() && (d.business.draft || businessValue.oneLiner.trim() || businessValue.offers.length) ? { business: cleanOffers(businessValue) } : {}),
        ...(voiceValue ? { voice: voiceValue } : {}),
        quotas,
      }),
    );

  return (
    <div className="flex flex-1 flex-col">
      <StepHeader title="Here's what your team drafted" lede="Fix anything that's off. Approved cards become your Brand Kit, which every agent reads before it writes. You can come back here from the Brand Kit any time." />

      <div className="mt-10 grid items-start gap-4 lg:grid-cols-2">
        {siteWorking && !d.business.draft ? (
          <Card title="Your business" by="The Analyst is reading your website">
            <AgentWorking agent="analyst" run={siteRun} fallback="Reading your website" />
          </Card>
        ) : (
          <BusinessCard {...props} value={businessValue} onChange={(value) => setBusiness({ key: draftKey(d.business.draft), value })} />
        )}
        {voiceValue ? (
          <VoiceCard {...props} value={voiceValue} onChange={(value) => setVoice({ key: draftKey(d.voice.draft), value })} />
        ) : (
          <VoicePending {...props} />
        )}
      </div>

      <div className="mt-4">
        <LanesCard {...props} quotas={quotas} onChange={setQuotas} />
      </div>

      <Link
        href="/setup?step=interview"
        className="group mt-4 flex items-center gap-4 rounded-lg border border-dashed border-border-strong p-5 text-left transition-colors duration-[120ms] hover:border-brand"
      >
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-fg">Add proof and stories</p>
          <p className="text-small text-fg-2">
            Optional, about ten minutes. The Chief of Staff asks for results you can prove, client stories and the objections you hear.
            {d.interview.savedAt ? ` ${d.interview.answers.length} answers saved so far.` : ""}
          </p>
        </div>
        <ArrowRight className="size-5 shrink-0 text-fg-3 transition-transform duration-[120ms] group-hover:translate-x-0.5" strokeWidth={1.75} />
      </Link>

      <StepFooter busy={nav.busy} onBack={nav.back} onSkip={nav.skip} primary={{ label: "Approve all", onClick: approveAll }} />
    </div>
  );
}

function draftKey(d: BusinessDraft | VoiceDraft | undefined): string {
  if (!d) return "none";
  return "name" in d ? `b:${d.name}:${d.oneLiner}:${d.offers.length}` : `v:${d.oneLine}:${d.basedOnPosts}:${d.howWeTalk.length}`;
}
