import { CTA_TYPES, PLATFORMS, type Sql } from "@attentionos/core";
import { z } from "zod";

/**
 * The onboarding state machine (Studio's setup wizard). One row in `settings`, key `onboarding:state`:
 * `{ step, completed, data }`. Resumable at any step; most steps can be skipped ("I'll do this later" keeps the
 * defaults) and revisited. Setup is finished once `data.finishedAt` is set (the go-live step, done or skipped).
 *
 * The flow: welcome → you (website + handles) → keys (Apify, Zernio) → competitors → start (the agents scrape,
 * transcribe and draft) → review (approve the drafts) → go live. `interview` is an optional extra step ("Add proof
 * and stories") reached from Review or the Brand Kit; it is not part of the main rail.
 *
 * Pure transitions live here so they can be unit tested; `updateState` applies one under a row lock so Studio
 * actions and agent jobs (which save drafts from the worker) never overwrite each other.
 *
 * No `server-only` and no Studio imports: Studio imports this file through `@attentionos/module-onboarding/state`.
 */

export const STATE_KEY = "onboarding:state";

/** The main steps, in order (the step rail and the progress line). */
export const STEP_IDS = ["welcome", "you", "keys", "competitors", "start", "review", "go-live"] as const;
/** Optional steps outside the rail. */
export const EXTRA_STEP_IDS = ["interview"] as const;
export const ALL_STEP_IDS = [...STEP_IDS, ...EXTRA_STEP_IDS] as const;
export type MainStepId = (typeof STEP_IDS)[number];
export type StepId = (typeof ALL_STEP_IDS)[number];

export const STEP_TITLES: Record<StepId, string> = {
  welcome: "Welcome",
  you: "You",
  keys: "Keys",
  competitors: "Competitors",
  start: "Start",
  review: "Review",
  "go-live": "Go live",
  interview: "Proof and stories",
};

export function isStepId(value: unknown): value is StepId {
  return typeof value === "string" && (ALL_STEP_IDS as readonly string[]).includes(value);
}

/** Step ids of the first wizard (9 steps), mapped onto the new flow so a half-finished setup resumes sensibly. */
export const LEGACY_STEPS: Record<string, StepId> = {
  business: "you",
  content: "you",
  strategy: "competitors",
  formats: "review",
  connect: "keys",
  team: "go-live",
};

const migrateStep = (v: unknown): StepId | undefined => (isStepId(v) ? v : typeof v === "string" ? LEGACY_STEPS[v] : undefined);
const migrateSteps = (v: unknown): StepId[] => (Array.isArray(v) ? [...new Set(v.map(migrateStep).filter((x): x is StepId => Boolean(x)))] : []);

/** Rewrites legacy step ids in a stored value (anything else is left for the schema to check). */
export function migrateLegacy(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  const data = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : undefined;
  return {
    ...raw,
    ...(raw.step !== undefined ? { step: migrateStep(raw.step) ?? "welcome" } : {}),
    ...(raw.completed !== undefined ? { completed: migrateSteps(raw.completed) } : {}),
    ...(data ? { data: { ...data, ...(data.skipped !== undefined ? { skipped: migrateSteps(data.skipped) } : {}) } } : {}),
  };
}

// ───────────────────────────── Drafts produced by agents ─────────────────────────────

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);

export const offerDraftSchema = z.object({
  id: slug,
  name: z.string().min(1).max(120),
  url: z.string().max(400).optional(),
  cta: z.enum(CTA_TYPES).default("book_call"),
  whoFor: z.string().max(600).default(""),
  whatTheyGet: z.string().max(1200).default(""),
  price: z.string().max(120).default(""),
  howToStart: z.string().max(300).default(""),
});
export type OfferDraft = z.output<typeof offerDraftSchema>;

export const businessDraftSchema = z.object({
  name: z.string().min(1).max(120),
  oneLiner: z.string().max(240).default(""),
  website: z.string().max(400).default(""),
  offers: z.array(offerDraftSchema).max(8).default([]),
  claimableResults: z.array(z.string().max(300)).max(12).default([]),
  neverPromise: z.array(z.string().max(300)).max(12).default([]),
  audience: z
    .object({
      who: z.string().max(1200).default(""),
      wants: z.string().max(1200).default(""),
      stuck: z.string().max(1200).default(""),
      quotes: z.array(z.string().max(300)).max(15).default([]),
      objections: z.array(z.string().max(400)).max(12).default([]),
      notFor: z.string().max(800).default(""),
    })
    .prefault({}),
  /** Three short lines the wizard shows back: what the analyst understood. */
  summary: z.array(z.string().max(300)).max(5).default([]),
  /** What the site didn't say; asked again in the interview. */
  openQuestions: z.array(z.string().max(300)).max(8).default([]),
});
export type BusinessDraft = z.output<typeof businessDraftSchema>;

export const voiceDraftSchema = z.object({
  oneLine: z.string().max(300).default(""),
  howWeTalk: z.array(z.string().max(400)).max(12).default([]),
  signatureMoves: z.array(z.string().max(300)).max(8).default([]),
  neverSay: z.array(z.string().max(300)).max(15).default([]),
  bannedPhrases: z.array(z.string().min(2).max(80)).max(25).default([]),
  /** Verbatim passages from the owner's own posts (checked in code). */
  examples: z.array(z.string().max(700)).max(5).default([]),
  summary: z.string().max(600).default(""),
  basedOnPosts: z.number().int().nonnegative().default(0),
});
export type VoiceDraft = z.output<typeof voiceDraftSchema>;

export const competitorSuggestionSchema = z.object({
  handle: z.string().min(2).max(80),
  platform: z.enum(PLATFORMS),
  tier: z.enum(["core", "adjacent", "aspirational", "remake"]).default("core"),
  why: z.string().max(300).default(""),
});
export const sourceSuggestionSchema = z.object({
  kind: z.enum(["rss", "google_news", "hn", "reddit", "github"]),
  target: z.string().min(2).max(300),
  why: z.string().max(300).default(""),
});

export const postSchema = z.object({
  id: z.string().min(1).max(64),
  platform: z.enum(PLATFORMS).optional(),
  url: z.string().max(600).optional(),
  text: z.string().max(12_000).default(""),
  source: z.enum(["paste", "url", "analytics"]).default("paste"),
  /** Why a URL couldn't be imported (shown so the owner can paste the caption instead). */
  problem: z.string().max(300).optional(),
});
export type ImportedPost = z.output<typeof postSchema>;

export const ANSWER_KINDS = ["pain", "want", "quote", "objection", "offer", "proof", "faq", "process", "story", "not_for", "other"] as const;
export const answerSchema = z.object({
  kind: z.enum(ANSWER_KINDS),
  text: z.string().min(1).max(2000),
  numbers: z.array(z.object({ value: z.string().min(1).max(60), label: z.string().min(1).max(200), source: z.string().min(3).max(200) })).max(10).default([]),
  clientConsent: z.boolean().default(false),
  at: z.string(),
});
export type InterviewAnswer = z.output<typeof answerSchema>;

export const chatMessageSchema = z.object({
  id: z.string().min(1).max(80),
  role: z.enum(["owner", "agent"]),
  text: z.string().max(6000),
  at: z.string(),
});
export type InterviewMessage = z.output<typeof chatMessageSchema>;

// ───────────────────────────── The state row ─────────────────────────────

const runRef = z.string().max(64).optional();

export const MAX_COMPETITORS_PER_PLATFORM = 10;
export const MAX_COMPETITORS = 60;

export const competitorEntrySchema = z.object({
  handle: z.string().min(2).max(80),
  platform: z.enum(PLATFORMS),
  tier: z.enum(["core", "adjacent", "aspirational", "remake"]).default("core"),
  notes: z.string().max(300).optional(),
});
export type CompetitorEntry = z.output<typeof competitorEntrySchema>;

export const connectedAccountSchema = z.object({
  platform: z.enum(PLATFORMS),
  handle: z.string().max(120),
  status: z.enum(["connected", "expired", "error"]).default("connected"),
});
export type ConnectedAccount = z.output<typeof connectedAccountSchema>;

export const onboardingDataSchema = z
  .object({
    business: z
      .object({
        url: z.string().max(400).default(""),
        extraUrls: z.array(z.string().max(400)).max(4).default([]),
        runId: runRef,
        draft: businessDraftSchema.optional(),
        approvedAt: z.string().optional(),
      })
      .prefault({}),
    content: z
      .object({
        handles: z.partialRecord(z.enum(PLATFORMS), z.string().max(80)).default({}),
        posts: z.array(postSchema).max(40).default([]),
        importRunId: runRef,
        voiceRunId: runRef,
      })
      .prefault({}),
    voice: z
      .object({
        draft: voiceDraftSchema.optional(),
        approvedAt: z.string().optional(),
        /** The Start run the current draft came from (so a re-run drafts again, once). */
        kickoff: z.string().max(40).optional(),
        runId: runRef,
      })
      .prefault({}),
    interview: z
      .object({
        messages: z.array(chatMessageSchema).max(200).default([]),
        answers: z.array(answerSchema).max(200).default([]),
        runId: runRef,
        done: z.boolean().default(false),
        savedAt: z.string().optional(),
      })
      .prefault({}),
    strategy: z
      .object({
        suggestRunId: runRef,
        suggestions: z
          .object({ competitors: z.array(competitorSuggestionSchema).max(20).default([]), sources: z.array(sourceSuggestionSchema).max(12).default([]) })
          .optional(),
        /** Competitor handles from the competitors step; written to brand/competitors.yaml when the owner starts. */
        competitors: z.array(competitorEntrySchema).max(MAX_COMPETITORS).default([]),
        savedAt: z.string().optional(),
      })
      .prefault({}),
    formats: z.object({ selected: z.array(z.string().max(48)).max(12).default([]), savedAt: z.string().optional() }).prefault({}),
    connect: z
      .object({
        checks: z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string().max(400), at: z.string() })).default({}),
        /** Social accounts connected in the publishing service (Zernio), as last listed. */
        accounts: z.array(connectedAccountSchema).max(40).default([]),
        accountsAt: z.string().optional(),
      })
      .prefault({}),
    start: z
      .object({
        /** One id per press of "Start": dedupes the queued work and the voice draft for that run. */
        kickoff: z.string().max(40).optional(),
        at: z.string().optional(),
        runIds: z.array(z.string()).max(12).default([]),
        /** Plain notes from the queueing step (e.g. "Competitor scan waits for your Apify token"). */
        notes: z.array(z.string().max(300)).max(12).default([]),
      })
      .prefault({}),
    review: z.object({ approvedAt: z.string().optional() }).prefault({}),
    team: z.object({ savedAt: z.string().optional() }).prefault({}),
    goLive: z.object({ runIds: z.array(z.string()).max(12).default([]), at: z.string().optional() }).prefault({}),
    skipped: z.array(z.enum(ALL_STEP_IDS)).default([]),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .prefault({});
export type OnboardingData = z.output<typeof onboardingDataSchema>;

export const onboardingStateSchema = z.object({
  step: z.enum(ALL_STEP_IDS).default("welcome"),
  completed: z.array(z.enum(ALL_STEP_IDS)).default([]),
  data: onboardingDataSchema,
});
export type OnboardingState = z.output<typeof onboardingStateSchema>;

// ───────────────────────────── Pure transitions ─────────────────────────────

export function initialState(now: Date = new Date()): OnboardingState {
  const s = onboardingStateSchema.parse({});
  s.data.startedAt = now.toISOString();
  return s;
}

/** Parses a stored value (legacy step ids are mapped first); anything unreadable starts over at the welcome step. */
export function parseState(value: unknown, now: Date = new Date()): OnboardingState {
  const migrated = migrateLegacy(value ?? {});
  const parsed = onboardingStateSchema.safeParse(migrated);
  if (parsed.success) return parsed.data;
  // Keep whatever still validates field by field: a bad draft shouldn't erase the rest of setup.
  const raw = (migrated && typeof migrated === "object" ? migrated : {}) as Record<string, unknown>;
  const base = initialState(now);
  if (isStepId(raw.step)) base.step = raw.step;
  if (Array.isArray(raw.completed)) base.completed = raw.completed.filter(isStepId);
  const data = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : {};
  for (const key of Object.keys(base.data) as (keyof OnboardingData)[]) {
    const one = onboardingDataSchema.safeParse({ [key]: data[key] });
    if (one.success && data[key] !== undefined) (base.data as Record<string, unknown>)[key] = one.data[key];
  }
  return base;
}

const isMain = (step: StepId): step is MainStepId => (STEP_IDS as readonly string[]).includes(step);
/** Position in the main rail; the extra steps sit with Review (where they're reached from). */
export const stepIndex = (step: StepId) => STEP_IDS.indexOf(isMain(step) ? step : "review");
export const nextStep = (step: StepId): StepId => (isMain(step) ? STEP_IDS[Math.min(STEP_IDS.length - 1, stepIndex(step) + 1)]! : "review");
export const prevStep = (step: StepId): StepId => (isMain(step) ? STEP_IDS[Math.max(0, stepIndex(step) - 1)]! : "review");

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const ordered = (xs: StepId[]) => uniq(xs).sort((a, b) => stepIndex(a) - stepIndex(b) || (isMain(a) ? -1 : 1));

export function goTo(state: OnboardingState, step: StepId): OnboardingState {
  return { ...state, step };
}

export function back(state: OnboardingState): OnboardingState {
  return { ...state, step: prevStep(state.step) };
}

/** Marks a step done and moves on. Finishing go-live finishes setup; finishing an extra step returns to Review. */
export function completeStep(state: OnboardingState, step: StepId, now: Date = new Date()): OnboardingState {
  const data = { ...state.data, skipped: state.data.skipped.filter((s) => s !== step) };
  if (step === "go-live") data.finishedAt = now.toISOString();
  return { step: step === "go-live" ? step : nextStep(step), completed: ordered([...state.completed, step]), data };
}

/** "I'll do this later": keeps the defaults, remembers the skip so the go-live summary can list it. */
export function skipStep(state: OnboardingState, step: StepId, now: Date = new Date()): OnboardingState {
  const data = { ...state.data, skipped: state.completed.includes(step) ? state.data.skipped : ordered([...state.data.skipped, step]) };
  if (step === "go-live") data.finishedAt = now.toISOString();
  return { ...state, step: step === "go-live" ? step : nextStep(step), data };
}

export function isFinished(state: OnboardingState): boolean {
  return Boolean(state.data.finishedAt);
}

/** 0..1 for the Attention Signal progress line: main steps done or skipped, out of all main steps. */
export function progress(state: OnboardingState): number {
  if (isFinished(state)) return 1;
  const touched = new Set<StepId>([...state.completed, ...state.data.skipped].filter(isMain));
  const base = touched.size / STEP_IDS.length;
  const here = stepIndex(state.step) / STEP_IDS.length;
  return Math.min(1, Math.max(base, here));
}

export function stepStatus(state: OnboardingState, step: StepId): "done" | "skipped" | "current" | "todo" {
  if (state.step === step && !isFinished(state)) return "current";
  if (state.completed.includes(step)) return "done";
  if (state.data.skipped.includes(step)) return "skipped";
  return "todo";
}

// ───────────────────────────── Persistence ─────────────────────────────

type Json = Parameters<Sql["json"]>[0];

export async function readState(sql: Sql, workspaceId: string): Promise<OnboardingState | null> {
  const rows = await sql<{ value: unknown }[]>`select value from settings where workspace_id = ${workspaceId} and key = ${STATE_KEY}`;
  return rows[0] ? parseState(rows[0].value) : null;
}

export async function writeState(sql: Sql, workspaceId: string, state: OnboardingState): Promise<void> {
  await sql`
    insert into settings (workspace_id, key, value, updated_at)
    values (${workspaceId}, ${STATE_KEY}, ${sql.json(state as unknown as Json)}, now())
    on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()`;
}

/**
 * Read-modify-write under a row lock: Studio actions and agent jobs (worker) update the same row, so each update
 * sees the latest value. Returns the new state.
 */
export async function updateState(sql: Sql, workspaceId: string, fn: (s: OnboardingState) => OnboardingState, now: Date = new Date()): Promise<OnboardingState> {
  return (await sql.begin(async (tx) => {
    await tx`
      insert into settings (workspace_id, key, value) values (${workspaceId}, ${STATE_KEY}, ${tx.json(initialState(now) as unknown as Json)})
      on conflict (workspace_id, key) do nothing`;
    const [row] = await tx<{ value: unknown }[]>`select value from settings where workspace_id = ${workspaceId} and key = ${STATE_KEY} for update`;
    const next = onboardingStateSchema.parse(fn(parseState(row?.value, now)));
    await tx`update settings set value = ${tx.json(next as unknown as Json)}, updated_at = now() where workspace_id = ${workspaceId} and key = ${STATE_KEY}`;
    return next;
  })) as OnboardingState;
}

/** Shallow-merges one section of `data` (e.g. `business`) under the row lock. */
export function patchSection<K extends keyof OnboardingData>(sql: Sql, workspaceId: string, key: K, patch: Partial<OnboardingData[K]>): Promise<OnboardingState> {
  return updateState(sql, workspaceId, (s) => ({ ...s, data: { ...s.data, [key]: { ...(s.data[key] as object), ...patch } } }));
}
