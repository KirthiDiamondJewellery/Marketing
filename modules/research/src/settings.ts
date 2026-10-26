import { z } from "zod";
import { moduleSettings, PLATFORMS, type WorkspaceContext } from "@attentionos/core";

const ruleOverride = z.object({
  weights: z.partialRecord(z.enum(["views", "likes", "comments", "shares"]), z.number().nonnegative()).optional(),
  threshold: z.number().positive().optional(),
  floors: z.partialRecord(z.enum(["views", "likes", "comments", "shares"]), z.number().nonnegative()).optional(),
  memeMaxS: z.number().nonnegative().optional(),
});

/** `config.modules.research.settings`. Every field has a safe default. */
export const researchSettingsSchema = z.object({
  competitorScan: z.object({
    /** Creators scanned per day (the rotation window). */
    creatorsPerDay: z.number().int().positive().default(15),
    /** Posts pulled per creator per scan. */
    postsPerCreator: z.number().int().positive().max(100).default(12),
    /** Baseline: mature after this many hours, ignore posts older than maxAgeDays, need minPosts. */
    matureHours: z.number().positive().default(48),
    maxAgeDays: z.number().positive().default(120),
    minBaselinePosts: z.number().int().positive().default(5),
    /** Winners per scan sent to transcription. */
    transcribeTopN: z.number().int().nonnegative().default(5),
    /** After a winner is transcribed, write its teardown and remix blueprint so the Copywriter can remake it. */
    autoTeardown: z.boolean().default(true),
    /** Own best posts torn down per scan (their remix blueprints feed the Copywriter's voice and "do it again" remixes). */
    ownTeardownsPerScan: z.number().int().nonnegative().max(10).default(2),
    /** Window for cross-creator trend detection. */
    crossCreatorDays: z.number().int().positive().default(14),
    /** Job that transcribes a competitor post (the editing module's media-py ASR). */
    transcribeJobId: z.string().default("editing.transcribe"),
    rules: z.partialRecord(z.enum(PLATFORMS), ruleOverride).default({}),
  }).default({
    creatorsPerDay: 15, postsPerCreator: 12, matureHours: 48, maxAgeDays: 120, minBaselinePosts: 5, transcribeTopN: 5, autoTeardown: true, ownTeardownsPerScan: 2,
    crossCreatorDays: 14, transcribeJobId: "editing.transcribe", rules: {},
  }),
  trendRadar: z.object({
    dayCap: z.number().int().nonnegative().default(6),
    perRun: z.number().int().nonnegative().default(1),
    perSourceLimit: z.number().int().positive().max(100).default(25),
    followUpFactor: z.number().min(1).default(2),
    /** News reels die after about two days; the kit carries this deadline. */
    filmWithinHours: z.number().positive().default(24),
    /** Trends not seen again for this long are expired. */
    expireAfterHours: z.number().positive().default(72),
    /** 0–1. Below this brand relevance a trend is never picked (0 = off). */
    minRelevance: z.number().min(0).max(1).default(0),
    heat: z.record(z.string(), z.object({
      weight: z.number().positive().optional(),
      bar: z.number().positive().optional(),
      floor: z.number().nonnegative().optional(),
      maxAgeHours: z.number().positive().optional(),
    })).default({}),
  }).default({ dayCap: 6, perRun: 1, perSourceLimit: 25, followUpFactor: 2, filmWithinHours: 24, expireAfterHours: 72, minRelevance: 0, heat: {} }),
  ownSync: z.object({
    /** Days of history re-read on a normal sync (covers the 30-day snapshot). */
    lookbackDays: z.number().int().positive().default(35),
  }).default({ lookbackDays: 35 }),
});

export type ResearchSettings = z.output<typeof researchSettingsSchema>;

export function researchSettings(ws: WorkspaceContext): ResearchSettings {
  return researchSettingsSchema.parse(moduleSettings(ws.config, "research").settings ?? {});
}
