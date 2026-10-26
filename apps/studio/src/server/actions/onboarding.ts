"use server";
import { randomUUID } from "node:crypto";
import { AGENT_KEYS, PLATFORMS, proofInventorySchema, type Platform, type ProofItem } from "@attentionos/core";
import { parseYamlLoose, patchYaml, readLanes, setLanes } from "@attentionos/module-onboarding/brand-files";
import { bareHandle, cleanHandle, competitorHandle, ownHandleList, PLATFORM_NAMES, SCRAPER_PLATFORMS } from "@attentionos/module-onboarding/handles";
import {
  brandYamlFromBusiness,
  competitorsYaml,
  icpMd,
  icpMdWithAnswers,
  offersMd,
  proofInventoryWithAnswers,
  proofInventoryYaml,
  voiceMd,
} from "@attentionos/module-onboarding/render";
import {
  businessDraftSchema,
  competitorEntrySchema,
  completeStep,
  goTo,
  isStepId,
  MAX_COMPETITORS_PER_PLATFORM,
  skipStep,
  voiceDraftSchema,
  type BusinessDraft,
  type OnboardingState,
  type VoiceDraft,
} from "@attentionos/module-onboarding/state";
import { z } from "zod";
import { requireSession, UnauthorizedError } from "@/server/auth";
import { BAD_REQUEST, parse } from "@/server/validate";
import {
  applyPreset,
  brandFile,
  checkConnection,
  editConfig,
  enqueue,
  keySet,
  listPresets,
  loadState,
  mutateState,
  saveBrandFiles,
  sendTelegramTest,
  type ConnectionId,
} from "@/server/onboarding";
import { settingsApplyLive } from "@/server/live-settings";
import { readWorkspaceConfig, writeEnvKey } from "@/server/settings";
import { workspace } from "@/server/workspace";

export type SetupResult = { ok: true; message?: string; runId?: string; redirect?: string } | { ok: false; error: string };

const JOBS = {
  analyzeSite: "onboarding.analyze-site",
  importOwnPosts: "onboarding.import-own-posts",
  voiceReady: "onboarding.voice-ready",
  voiceProfile: "onboarding.voice-profile",
  interview: "onboarding.interview",
  suggestCompetitors: "onboarding.suggest-competitors",
  competitorScan: "research.competitor-scan",
  indexWorkspace: "knowledge.index-workspace",
  dailyBrief: "strategy.daily-brief",
  trendRadar: "research.trend-radar",
} as const;

/** Every action: signed in, and any failure comes back as one plain sentence. */
async function guarded(fn: () => Promise<SetupResult>): Promise<SetupResult> {
  try {
    await requireSession();
  } catch (e) {
    return { ok: false, error: e instanceof UnauthorizedError ? e.message : "Not allowed." };
  }
  try {
    return await fn();
  } catch (err) {
    console.error("[studio] setup:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Saves to the settings file or .env apply on their own under `attentionos up`; say so. */
const APPLYING = "Saved. Applying your settings…";

// ───────────────────────────── Navigation ─────────────────────────────

const stepInput = z.string().max(64);

export async function goToStepAction(step: string): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const id = parse(stepInput, step);
    if (!id || !isStepId(id)) return { ok: false, error: "Unknown step." };
    await mutateState((s) => goTo(s, id));
    return { ok: true };
  });
}

/** "I'll do this later": keeps the defaults and moves on. */
export async function skipStepAction(step: string): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const id = parse(stepInput, step);
    if (!id || !isStepId(id)) return { ok: false, error: "Unknown step." };
    const s = await mutateState((st) => skipStep(goTo(st, id), id));
    return { ok: true, ...(s.data.finishedAt ? { redirect: "/agents" } : {}) };
  });
}

export async function completeStepAction(step: string): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const id = parse(stepInput, step);
    if (!id || !isStepId(id) || id === "go-live") return { ok: false, error: "Unknown step." };
    await mutateState((s) => completeStep(s, id));
    return { ok: true };
  });
}

// ───────────────────────────── 2 · You: website and handles ─────────────────────────────

const youInput = z.object({
  website: z.string().max(400).default(""),
  handles: z.partialRecord(z.enum(PLATFORMS), z.string().max(200)).default({}),
});

/**
 * Saves the website and handles, then asks the Analyst to read the site in the background (the owner moves on
 * straight away; the draft shows up in Review).
 */
export async function saveYouAction(input: z.input<typeof youInput>): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const parsed = youInput.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, error: "Those details don't look right." };
    const website = parsed.data.website.trim();
    if (website && (website.length < 4 || !/\.[a-z]{2,}/i.test(website))) return { ok: false, error: "Enter your website like yourbusiness.com, or leave it empty." };
    const handles: Partial<Record<Platform, string>> = {};
    const bad: string[] = [];
    for (const [p, raw] of Object.entries(parsed.data.handles) as [Platform, string | undefined][]) {
      if (!raw?.trim()) continue;
      const h = cleanHandle(p, raw);
      if (h) handles[p] = h;
      else bad.push(PLATFORM_NAMES[p]);
    }
    if (bad.length) return { ok: false, error: `Check your ${bad.join(" and ")} handle: use the name after the @, or paste your profile link.` };
    if (!Object.keys(handles).length) return { ok: false, error: "Add at least one social handle so the team can find your posts." };

    const current = brandFile("brand.yaml");
    if (current.trim()) {
      await saveBrandFiles(
        [{ file: "brand.yaml", content: patchYaml(current, { handles, ...(website ? { website: /^https?:\/\//i.test(website) ? website : `https://${website}` } : {}) }) }],
        "Brand Kit updated: your website and handles",
      );
    }
    const before = await loadState();
    const siteChanged = website && (website !== before.data.business.url || !before.data.business.runId);
    let runId: string | undefined;
    if (siteChanged) {
      runId = await enqueue(JOBS.analyzeSite, "analyst", { url: website, extraUrls: [] }, { message: "Asked Analyst to read your website", maxAttempts: 2 });
    }
    await mutateState((s) =>
      completeStep(
        {
          ...s,
          data: {
            ...s.data,
            content: { ...s.data.content, handles },
            business: { ...s.data.business, url: website, ...(runId ? { runId, draft: undefined, approvedAt: undefined } : {}) },
          },
        },
        "you",
      ),
    );
    return { ok: true, ...(runId ? { runId, message: "The Analyst is reading your website in the background" } : {}) };
  });
}

// ───────────────────────────── 3 · Keys ─────────────────────────────

const CONNECT_KEYS: Record<string, ConnectionId> = { ZERNIO_API_KEY: "zernio", APIFY_TOKEN: "apify", TELEGRAM_BOT_TOKEN: "telegram" };
const connectionKeyInput = z.object({ name: z.string().max(100), value: z.string().max(10_000) });
const connectionInput = z.enum(["zernio", "apify", "telegram"]);

export async function saveConnectionKeyAction(name: string, value: string): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const args = parse(connectionKeyInput, { name, value });
    if (!args) return { ok: false, error: "That doesn't look like a key. Paste it again without spaces." };
    const id = Object.hasOwn(CONNECT_KEYS, args.name) ? CONNECT_KEYS[args.name] : undefined;
    if (!id) return { ok: false, error: "Setup doesn't save that key." };
    const v = args.value.trim();
    if (v.length < 8 || v.length > 4096 || /\s/.test(v)) return { ok: false, error: "That doesn't look like a key. Paste it again without spaces." };
    writeEnvKey(workspace().root, args.name, v);
    const r = await verify(id);
    return r.ok && settingsApplyLive() ? { ...r, message: [r.message, APPLYING].filter(Boolean).join(" ") } : r;
  });
}

async function verify(id: ConnectionId): Promise<SetupResult> {
  const r = await checkConnection(id);
  const at = new Date().toISOString();
  await mutateState((s) => ({
    ...s,
    data: {
      ...s.data,
      connect: {
        ...s.data.connect,
        checks: { ...s.data.connect.checks, [id]: { ok: r.ok, detail: r.detail, at } },
        ...(r.accounts ? { accounts: r.accounts, accountsAt: at } : {}),
      },
    },
  }));
  return r.ok ? { ok: true, message: r.detail } : { ok: false, error: r.detail };
}

/** "Check" (Apify, Telegram) and "Refresh" (Zernio's connected accounts). */
export async function checkConnectionAction(id: string): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const service = parse(connectionInput, id);
    if (!service) return { ok: false, error: "Unknown service." };
    return verify(service);
  });
}

export async function telegramTestAction(): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const r = await sendTelegramTest();
    return r.ok ? { ok: true, message: r.detail } : { ok: false, error: r.detail };
  });
}

// ───────────────────────────── 4 · Competitors ─────────────────────────────

export async function suggestCompetitorsAction(note?: string): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const args = parse(z.object({ note: z.string().max(5000).optional() }), { note: note ?? undefined });
    if (!args) return { ok: false, error: BAD_REQUEST };
    const runId = await enqueue(JOBS.suggestCompetitors, "analyst", args.note ? { note: args.note.slice(0, 500) } : {}, { message: "Asked Analyst to find creators in your niche" });
    await mutateState((s) => ({ ...s, data: { ...s.data, strategy: { ...s.data.strategy, suggestRunId: runId } } }));
    return { ok: true, runId };
  });
}

const competitorsInput = z.object({
  competitors: z.array(competitorEntrySchema).max(80),
  acknowledge: z.boolean().default(false),
});

export async function saveCompetitorsAction(input: z.input<typeof competitorsInput>): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const parsed = competitorsInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the handles: use the name after the @." };
    const s = await loadState();
    const own = new Set(ownHandleList(s.data.content.handles).map((h) => `${h.platform}:${bareHandle(h.handle)}`));
    const seen = new Set<string>();
    const list = parsed.data.competitors
      .map((c) => ({ ...c, handle: competitorHandle(c.platform, c.handle) }))
      .filter((c) => {
        const key = `${c.platform}:${bareHandle(c.handle)}`;
        if (!c.handle || own.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    for (const p of PLATFORMS) {
      if (list.filter((c) => c.platform === p).length > MAX_COMPETITORS_PER_PLATFORM) {
        return { ok: false, error: `Keep it to ${MAX_COMPETITORS_PER_PLATFORM} creators on ${PLATFORM_NAMES[p]}; the scan stays quick and cheap that way.` };
      }
    }
    const cfg = await readWorkspaceConfig(workspace().root);
    const acknowledged = cfg.ok ? cfg.config.acknowledgements.scrapingTerms : false;
    if (parsed.data.acknowledge && !acknowledged) await editConfig([{ path: "acknowledgements.scrapingTerms", value: true }]);
    await mutateState((st) => completeStep({ ...st, data: { ...st.data, strategy: { ...st.data.strategy, competitors: list, savedAt: new Date().toISOString() } } }, "competitors"));
    return { ok: true, message: list.length ? `Saved ${plural(list.length, "creator")} to watch` : undefined };
  });
}

// ───────────────────────────── 5 · Start ─────────────────────────────

/**
 * Writes what the owner gave (competitors.yaml, handles), then queues the team's first work in order: import the
 * owner's own posts (which queues transcription of the best videos and then the voice profile), scan the competitors,
 * index the workspace for search, and a safety check that starts the voice profile even if a transcription stalls.
 */
export async function startAction(): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const ws = workspace();
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const s = await loadState();
    const handles = s.data.content.handles;
    if (!ownHandleList(handles).length) return { ok: false, error: "Add at least one of your handles first (the You step)." };
    const cfg = await readWorkspaceConfig(ws.root);
    const config = cfg.ok ? cfg.config : ws.config;

    // 1. The Brand Kit: who to watch, and the owner's handles.
    const files: { file: string; content: string }[] = [];
    if (s.data.strategy.competitors.length) files.push({ file: "competitors.yaml", content: competitorsYaml(s.data.strategy.competitors) });
    const brand = brandFile("brand.yaml");
    if (brand.trim()) files.push({ file: "brand.yaml", content: patchYaml(brand, { handles }) });
    if (files.length) await saveBrandFiles(files, `Brand Kit updated: your handles and ${plural(s.data.strategy.competitors.length, "creator")} to watch`);

    // 2. Modules the first run needs (editing transcribes; research and knowledge are core). Only touch the config
    //    when something is off: saving it restarts the worker.
    const editingWasOff = config.modules["editing"]?.enabled === false;
    if (editingWasOff) await editConfig([{ path: "modules.editing.enabled", value: true }]);
    // The worker reloads after a config save. Give it a moment, so the import runs with editing on and transcribes.
    const afterReload = editingWasOff ? { runAfter: new Date(Date.now() + 20_000) } : {};

    // 3. The work, in order.
    const kickoff = `k${Date.now().toString(36)}`;
    const runIds: string[] = [];
    const notes: string[] = [];
    const add = async (jobId: string, agent: Parameters<typeof enqueue>[1], input: Record<string, unknown>, message: string, opts: { runAfter?: Date } = {}) => {
      const id = await enqueue(jobId, agent, input, { dedupeKey: `onboarding:start:${kickoff}:${jobId}`, message, maxAttempts: 2, ...opts });
      if (id) runIds.push(id);
    };
    const apify = config.providers.scraper === "apify" ? keySet("APIFY_TOKEN") : config.providers.scraper !== "none";
    const zernio = config.providers.ownAnalytics === "zernio" && keySet("ZERNIO_API_KEY");
    const scrapable = SCRAPER_PLATFORMS[config.providers.scraper] ?? [];
    if (!apify && !zernio) notes.push("Without an Apify token or a Zernio key there's no way to read your posts yet. Add one in Keys, then press Start again.");
    else if (!apify) notes.push("No Apify token: your posts come from Zernio, which doesn't share video files, so your voice is learned from captions.");
    if (apify && !config.acknowledgements.scrapingTerms) notes.push("Reading public posts waits for the scraping notice (Competitors step).");
    await add(JOBS.importOwnPosts, "analyst", { kickoff }, `Asked Analyst to bring in your posts from ${ownHandleList(handles).map((h) => PLATFORM_NAMES[h.platform]).join(", ")}`, afterReload);

    const creators = s.data.strategy.competitors;
    const scannable = creators.filter((c) => scrapable.includes(c.platform));
    if (creators.length && apify && config.acknowledgements.scrapingTerms && scannable.length) {
      await add(JOBS.competitorScan, "analyst", { handles: scannable.map((c) => c.handle) }, `Asked Analyst to scan ${plural(scannable.length, "creator")} for outliers`);
    } else if (creators.length && !apify) {
      notes.push(`The competitor scan waits for your Apify token; ${plural(creators.length, "creator is", "creators are")} saved.`);
    }
    const unscannable = [...new Set(creators.filter((c) => !scrapable.includes(c.platform)).map((c) => PLATFORM_NAMES[c.platform]))];
    if (unscannable.length && apify) notes.push(`${unscannable.join(" and ")} creators are saved for the Strategist; the scraper can't read those platforms yet.`);

    await add(JOBS.indexWorkspace, "analyst", {}, "Asked Analyst to index your workspace for search", { runAfter: new Date(Date.now() + 4 * 60_000) });
    // Safety net: if a transcription never reports back, the voice profile still starts from what's in.
    await enqueue(JOBS.voiceReady, "copywriter", { kickoff, force: true }, { dedupeKey: `onboarding:start:${kickoff}:voice-timer`, runAfter: new Date(Date.now() + 20 * 60_000), maxAttempts: 1 });

    await mutateState((st) => ({
      ...st,
      data: { ...st.data, start: { kickoff, at: startedAt, runIds, notes } },
    }));
    return { ok: true, message: "Your team is on it" };
  });
}

// ───────────────────────────── 6 · Review ─────────────────────────────

async function saveBusiness(draft: BusinessDraft): Promise<string[]> {
  const written = await saveBrandFiles(
    [
      { file: "brand.yaml", content: brandYamlFromBusiness(brandFile("brand.yaml"), draft) },
      { file: "offers.md", content: offersMd(brandFile("offers.md"), draft) },
      { file: "icp.md", content: icpMd(brandFile("icp.md"), draft) },
    ],
    `Brand Kit updated: your business, ${plural(draft.offers.length, "offer")} and your ideal customer`,
  );
  try {
    await editConfig([{ path: "workspace.name", value: draft.name.trim().slice(0, 80) }]);
  } catch (err) {
    console.error("[studio] saving the workspace name failed:", err);
    const why = err instanceof Error && err.message ? ` (${err.message.replace(/\.$/, "")})` : "";
    throw new Error(`Saved your business details to the Brand Kit, but couldn't save the business name to your settings file${why}. Try again.`);
  }
  return written;
}

async function saveVoice(draft: VoiceDraft): Promise<string[]> {
  const files = [{ file: "voice.md", content: voiceMd(brandFile("voice.md"), draft) }];
  const brand = brandFile("brand.yaml");
  if (brand.trim()) {
    const current = ((parseYamlLoose(brand) as { bannedPhrases?: unknown } | null)?.bannedPhrases ?? []) as unknown[];
    const merged = [...new Set([...current.filter((x): x is string => typeof x === "string"), ...draft.bannedPhrases])];
    files.push({ file: "brand.yaml", content: patchYaml(brand, { bannedPhrases: merged }) });
  }
  return saveBrandFiles(files, "Brand Kit updated: your voice profile and banned phrases");
}

async function saveQuotas(quotas: Record<string, number>): Promise<string[]> {
  const pillars = brandFile("pillars.md");
  const lanes = readLanes(pillars);
  if (!lanes.length) return [];
  return saveBrandFiles([{ file: "pillars.md", content: setLanes(pillars, lanes.map((l) => ({ ...l, weeklyQuota: quotas[l.id] ?? l.weeklyQuota }))) }], "Brand Kit updated: your weekly lanes");
}

function businessError(input: unknown): { draft: BusinessDraft } | { error: string } {
  const parsed = businessDraftSchema.safeParse(input);
  if (!parsed.success) return { error: `Check the business card: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
  if (!parsed.data.name.trim()) return { error: "Add your business name." };
  return { draft: parsed.data };
}

export async function approveBusinessAction(input: BusinessDraft): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const b = businessError(input);
    if ("error" in b) return { ok: false, error: b.error };
    const written = await saveBusiness(b.draft);
    await mutateState((s) => ({ ...s, data: { ...s.data, business: { ...s.data.business, draft: b.draft, approvedAt: new Date().toISOString() } } }));
    return { ok: true, message: written.length ? `Saved ${written.join(", ")}` : "Saved" };
  });
}

export async function approveVoiceAction(input: VoiceDraft): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const parsed = voiceDraftSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the voice profile fields." };
    await saveVoice(parsed.data);
    await mutateState((s) => ({ ...s, data: { ...s.data, voice: { ...s.data.voice, draft: parsed.data, approvedAt: new Date().toISOString() } } }));
    return { ok: true, message: "Saved your voice profile" };
  });
}

const quotasSchema = z.record(z.string().max(48), z.number().int().min(0).max(14));

export async function saveLanesAction(quotas: Record<string, number>): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const parsed = quotasSchema.safeParse(quotas);
    if (!parsed.success) return { ok: false, error: "Each lane takes 0 to 14 posts a week." };
    await saveQuotas(parsed.data);
    return { ok: true, message: "Saved your lanes" };
  });
}

const approveAllInput = z.object({ business: z.unknown().optional(), voice: z.unknown().optional(), quotas: quotasSchema.default({}) });

/** Approve all: saves every draft that's ready (business, voice, lanes) and moves on. */
export async function approveAllAction(input: z.input<typeof approveAllInput>): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const parsed = approveAllInput.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, error: "Check the cards." };
    const at = new Date().toISOString();
    let business: BusinessDraft | undefined;
    let voice: VoiceDraft | undefined;
    if (parsed.data.business !== undefined) {
      const b = businessError(parsed.data.business);
      if ("error" in b) return { ok: false, error: b.error };
      business = b.draft;
    }
    if (parsed.data.voice !== undefined) {
      const v = voiceDraftSchema.safeParse(parsed.data.voice);
      if (!v.success) return { ok: false, error: "Check the voice profile fields." };
      voice = v.data;
    }
    const saved: string[] = [];
    if (business) await saveBusiness(business).then(() => saved.push("your business"));
    if (voice) await saveVoice(voice).then(() => saved.push("your voice"));
    if (Object.keys(parsed.data.quotas).length) await saveQuotas(parsed.data.quotas).then(() => saved.push("your lanes"));
    await mutateState((s) =>
      completeStep(
        {
          ...s,
          data: {
            ...s.data,
            ...(business ? { business: { ...s.data.business, draft: business, approvedAt: at } } : {}),
            ...(voice ? { voice: { ...s.data.voice, draft: voice, approvedAt: at } } : {}),
            review: { approvedAt: at },
          },
        },
        "review",
      ),
    );
    return { ok: true, message: saved.length ? `Saved ${saved.join(", ").replace(/, ([^,]*)$/, " and $1")} to your Brand Kit` : undefined };
  });
}

/** Re-reads the website (Review: "Read the site again"). */
export async function reanalyzeSiteAction(): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const s = await loadState();
    const url = s.data.business.url;
    if (!url) return { ok: false, error: "Add your website in the You step first." };
    const runId = await enqueue(JOBS.analyzeSite, "analyst", { url, extraUrls: s.data.business.extraUrls }, { message: "Asked Analyst to read your website again", maxAttempts: 2 });
    await mutateState((st) => ({ ...st, data: { ...st.data, business: { ...st.data.business, runId } } }));
    return { ok: true, runId };
  });
}

/** Drafts the voice profile now from whatever posts are in (Review: "Draft my voice now"). */
export async function draftVoiceAction(): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const runId = await enqueue(JOBS.voiceProfile, "copywriter", {}, { message: "Asked Copywriter to learn your voice from your posts" });
    await mutateState((s) => ({ ...s, data: { ...s.data, voice: { ...s.data.voice, runId } } }));
    return { ok: true, runId };
  });
}

export async function choosePresetAction(id: string): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const presetId = parse(z.string().max(100), id);
    const preset = presetId ? listPresets().find((p) => p.id === presetId) : undefined;
    if (!preset) return { ok: false, error: "That preset isn't installed." };
    await applyPreset(preset);
    await editConfig([
      { path: "workspace.preset", value: preset.id },
      { path: "northStar.metric", value: preset.northStar },
    ]);
    return { ok: true, message: `Lanes now follow the ${preset.name.toLowerCase()} preset.${settingsApplyLive() ? " Applying your settings…" : ""}` };
  });
}

// ───────────────────────────── Optional: proof and stories (the interview) ─────────────────────────────

function interviewActive(s: OnboardingState, runs: { status: string } | undefined): boolean {
  return Boolean(s.data.interview.runId) && (runs?.status === "queued" || runs?.status === "running");
}

export async function startInterviewAction(): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const s = await loadState();
    if (s.data.interview.messages.length) return { ok: true };
    const ws = workspace();
    const [active] = await ws.sql<{ status: string }[]>`
      select status from agent_runs where workspace_id = ${ws.id} and job_id = ${JOBS.interview} and status in ('queued', 'running') limit 1`;
    if (interviewActive(s, active)) return { ok: true };
    const messageId = `start-${randomUUID().slice(0, 8)}`;
    const runId = await enqueue(JOBS.interview, "chief_of_staff", { messageId, text: "", start: true }, { message: "Chief of Staff is starting your interview" });
    await mutateState((st) => ({ ...st, data: { ...st.data, interview: { ...st.data.interview, runId } } }));
    return { ok: true, runId };
  });
}

export async function sendInterviewAction(text: string): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const args = parse(z.string().optional(), text ?? undefined);
    if (args === undefined && text != null) return { ok: false, error: BAD_REQUEST };
    const clean = (args ?? "").trim();
    if (!clean) return { ok: false, error: "Write an answer first." };
    if (clean.length > 4000) return { ok: false, error: "Keep it under 4,000 characters; send the rest next." };
    const messageId = `owner-${randomUUID().slice(0, 12)}`;
    await mutateState((s) => ({
      ...s,
      data: { ...s.data, interview: { ...s.data.interview, messages: [...s.data.interview.messages, { id: messageId, role: "owner" as const, text: clean, at: new Date().toISOString() }].slice(-200) } },
    }));
    const runId = await enqueue(JOBS.interview, "chief_of_staff", { messageId, text: clean }, { maxAttempts: 2 });
    await mutateState((s) => ({ ...s, data: { ...s.data, interview: { ...s.data.interview, runId } } }));
    return { ok: true, runId };
  });
}

/** Saves what the interview recorded: new proof items (numbers keep their sources) and additions to icp.md. */
export async function saveInterviewAction(): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const s = await loadState();
    const answers = s.data.interview.answers;
    const files: { file: string; content: string }[] = [];
    if (answers.length) {
      const current = proofInventorySchema.safeParse(parseYamlLoose(brandFile("proof-inventory.yaml")) ?? {});
      const items: ProofItem[] = proofInventoryWithAnswers(current.success ? current.data.items : [], answers, today());
      if (!current.success || items.length !== current.data.items.length) files.push({ file: "proof-inventory.yaml", content: proofInventoryYaml(items) });
      files.push({ file: "icp.md", content: icpMdWithAnswers(brandFile("icp.md"), answers) });
    }
    const written = files.length ? await saveBrandFiles(files, `Brand Kit updated from your interview: ${plural(answers.length, "answer")}`) : [];
    const after = await mutateState((st) => completeStep({ ...st, data: { ...st.data, interview: { ...st.data.interview, savedAt: new Date().toISOString() } } }, "interview"));
    return { ok: true, message: written.length ? `Saved ${written.join(", ")}` : "Nothing new to save", ...(after.data.finishedAt ? { redirect: "/brand" } : {}) };
  });
}

// ───────────────────────────── 7 · Go live ─────────────────────────────

const goLiveInput = z.object({ autonomy: z.enum(["review_all", "review_key"]).default("review_all"), autopilot: z.boolean().default(false) });

/**
 * Sets how much the team does on its own (every agent: review everything, or key posts only), Autopilot on or off,
 * then plans today's filming and finishes setup. The owner lands on the command view.
 */
export async function goLiveAction(input: z.input<typeof goLiveInput>): Promise<SetupResult> {
  await requireSession();
  return guarded(async () => {
    const parsed = goLiveInput.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, error: "Pick how much your team may do on its own." };
    const v = parsed.data;
    await editConfig([...AGENT_KEYS.map((k) => ({ path: `agents.${k}.autonomy`, value: v.autonomy })), { path: "mode", value: v.autopilot ? "autopilot" : "copilot" }]);
    const day = today();
    const runIds: string[] = [];
    const brief = await enqueue(JOBS.dailyBrief, "strategist", {}, { dedupeKey: `onboarding:go-live:${JOBS.dailyBrief}:${day}`, message: "Asked Strategist to plan today's filming", maxAttempts: 2, runAfter: new Date(Date.now() + 60_000) });
    if (brief) runIds.push(brief);
    const radar = await enqueue(JOBS.trendRadar, "analyst", {}, { dedupeKey: `onboarding:go-live:${JOBS.trendRadar}:${day}`, message: "Asked Analyst to check your trend sources", maxAttempts: 2 });
    if (radar) runIds.push(radar);
    await mutateState((s) => completeStep(goTo({ ...s, data: { ...s.data, team: { savedAt: new Date().toISOString() }, goLive: { runIds, at: new Date().toISOString() } } }, "go-live"), "go-live"));
    return { ok: true, redirect: "/agents", message: "Your team is live" };
  });
}
