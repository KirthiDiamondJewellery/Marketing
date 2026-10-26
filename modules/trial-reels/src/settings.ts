import { z } from "zod";
import { moduleSettings, type AttentionOSConfig } from "@attentionos/core";

/**
 * `config.modules["trial-reels"].settings`. Every field has a safe default, so the module works with no settings at all.
 *
 *   modules: { "trial-reels": { settings: { dailyTotal: 9, window: { start: "08:00", end: "21:00" } } } }
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24-hour HH:MM");

/** The documented API publishing cap per rolling 24 hours, shared with every other post on the account. */
export const DAILY_CAP = 50;
export const MAX_SPEED = 1.1;
export const DEFAULT_SPEEDS = [1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1];
/** Colour filters and caption styles per variation. The speed count must share no factor with either. */
const GRADE_COUNT = 7;
const CAPTION_STYLE_COUNT = 5;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const hashtag = z.string().trim().transform((t) => t.replace(/^#+/, "")).pipe(z.string().regex(/^[\p{L}\p{N}_]{1,60}$/u, "a hashtag is one word (letters, numbers, _)"));

export const trialReelsSettingsSchema = z.object({
  /** Trial reels a day in total, split evenly across the clean reels of the day. */
  dailyTotal: z.number().int().min(1).max(DAILY_CAP).default(9),
  /** Rolling 24-hour cap on the Instagram account, counting every other post too. */
  dailyCap: z.number().int().min(1).max(DAILY_CAP).default(DAILY_CAP),
  /** Speeds a variation may use (audio pitch is kept). */
  speeds: z
    .array(z.number().gt(1).max(MAX_SPEED))
    .min(1)
    .default(DEFAULT_SPEEDS)
    .refine((s) => new Set(s).size === s.length, "speeds must all be different")
    .refine((s) => gcd(s.length, GRADE_COUNT) === 1 && gcd(s.length, CAPTION_STYLE_COUNT) === 1, `the number of speeds must share no factor with ${GRADE_COUNT} or ${CAPTION_STYLE_COUNT} (8 works), or two variations would share a look`),
  /** Posts are spread evenly across this window, in the workspace timezone. */
  window: z
    .object({ start: hhmm, end: hhmm })
    .default({ start: "08:00", end: "21:00" })
    .refine((w) => w.end > w.start, "the window must end after it starts"),
  /** "manual" (default): you decide when a trial reel is shown to your followers. "auto": Instagram does it when it performs well. */
  graduation: z.enum(["manual", "auto"]).default("manual"),
  /** Reusable topic hashtag sets, e.g. { tips: ["smallbusinesstips", …] }. Each post gets 5, reshuffled. */
  hashtagSets: z.record(z.string().min(1).max(40), z.array(hashtag).min(5).max(30)).default({}),
});
export type TrialReelsSettings = z.output<typeof trialReelsSettingsSchema>;

export function trialReelsSettings(config: AttentionOSConfig): TrialReelsSettings {
  const parsed = trialReelsSettingsSchema.safeParse(moduleSettings(config, "trial-reels").settings ?? {});
  if (!parsed.success) {
    throw new Error(`Trial reel settings aren't valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Zernio/Instagram graduation strategy for a setting. */
export function graduationStrategy(s: TrialReelsSettings): "MANUAL" | "SS_PERFORMANCE" {
  return s.graduation === "auto" ? "SS_PERFORMANCE" : "MANUAL";
}
