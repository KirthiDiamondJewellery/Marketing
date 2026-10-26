import { z } from "zod";
import { PLATFORMS, moduleSettings, type AttentionOSConfig, type Platform } from "@attentionos/core";
import { WEEKDAYS } from "./lib/time.ts";

/** `config.modules.publishing.settings`. Presets override cadence; every field has a safe default. */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24-hour HH:MM");

export const platformCadenceSchema = z.object({
  /** Posts per week on this platform. 0 turns the platform off for planning. */
  perWeek: z.number().int().min(0).max(70),
  /** Days the planner may use. */
  days: z.array(z.enum(WEEKDAYS)).min(1).default([...WEEKDAYS]),
  /** Local times (workspace timezone) the planner may use, best first. */
  slots: z.array(hhmm).min(1),
  /** Hard cap per local day. */
  maxPerDay: z.number().int().min(1).max(24).default(2),
});
export type PlatformCadence = z.output<typeof platformCadenceSchema>;

/**
 * Starting cadence when the preset doesn't set one. Reels do best around the morning and the early evening;
 * LinkedIn takes video one or two days a week; no platform gets more than a few videos a day.
 */
export const DEFAULT_CADENCE: Partial<Record<Platform, z.input<typeof platformCadenceSchema>>> = {
  instagram: { perWeek: 5, days: ["mon", "tue", "wed", "thu", "fri"], slots: ["08:00", "17:30"], maxPerDay: 1 },
  tiktok: { perWeek: 7, slots: ["08:30", "19:00"], maxPerDay: 2 },
  youtube: { perWeek: 5, slots: ["14:00", "20:00"], maxPerDay: 2 },
  facebook: { perWeek: 3, days: ["mon", "wed", "fri"], slots: ["18:00"], maxPerDay: 1 },
  linkedin: { perWeek: 2, days: ["tue", "thu"], slots: ["10:30"], maxPerDay: 1 },
  x: { perWeek: 5, days: ["mon", "tue", "wed", "thu", "fri"], slots: ["11:00"], maxPerDay: 1 },
  threads: { perWeek: 5, slots: ["16:00"], maxPerDay: 1 },
};

export const publishingSettingsSchema = z.object({
  cadence: z.partialRecord(z.enum(PLATFORMS), platformCadenceSchema).default(
    Object.fromEntries(Object.entries(DEFAULT_CADENCE).map(([k, v]) => [k, platformCadenceSchema.parse(v)])) as Partial<Record<Platform, PlatformCadence>>,
  ),
  /** Slots closer than this to "now" are skipped (the provider needs time to process media). */
  leadMinutes: z.number().int().min(0).max(24 * 60).default(15),
  instagram: z.object({
    /**
     * ADR-13: Instagram main feed defaults to "assist". Trending audio can't be added by API, so the user gets the
     * file and caption to post themselves. Set to true to let the publisher post Instagram reels directly.
     */
    autopost: z.boolean().default(false),
    /** How long before the slot the assist message goes out. */
    assistLeadMinutes: z.number().int().min(0).max(24 * 60).default(60),
  }).default({ autopost: false, assistLeadMinutes: 60 }),
  tracking: z.object({
    utmMedium: z.string().min(1).default("social"),
    utmCampaign: z.string().min(1).default("organic"),
    /** Create a short link on your own site for each post (needs `brand.cta.siteUrl` and LINKS_API_TOKEN). */
    shortLinks: z.boolean().default(false),
    linkApiPath: z.string().startsWith("/").default("/api/links"),
    /** Where tracked links point when a post has no lead magnet. Defaults to `brand.cta.siteUrl`. */
    defaultDestination: z.string().url().optional(),
  }).default({ utmMedium: "social", utmCampaign: "organic", shortLinks: false, linkApiPath: "/api/links" }),
  crossPost: z.object({
    /** Platforms a reel already on Instagram is queued to. */
    platforms: z.array(z.enum(PLATFORMS)).default(["tiktok", "youtube", "facebook", "linkedin"]),
    /**
     * Replaces the comment-keyword CTA off Instagram, where the keyword automation doesn't run.
     * Placeholders: {link}. Must render to one line of at most 200 characters.
     */
    linkLine: z.string().max(200).default("The comment keyword only works on Instagram. Get it here instead: {link}"),
    /** Used where links in captions aren't clickable (TikTok). */
    linkInBioLine: z.string().max(200).default("Get it from the link in bio."),
  }).default({
    platforms: ["tiktok", "youtube", "facebook", "linkedin"],
    linkLine: "The comment keyword only works on Instagram. Get it here instead: {link}",
    linkInBioLine: "Get it from the link in bio.",
  }),
});
export type PublishingSettings = z.output<typeof publishingSettingsSchema>;

/** Effective settings; throws a plain-language error if the workspace config is invalid. */
export function publishingSettings(config: AttentionOSConfig): PublishingSettings {
  const raw = moduleSettings(config, "publishing").settings;
  const parsed = publishingSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Publishing settings aren't valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Secret names read from the workspace `.env`. */
export const PUBLISHING_SECRETS = { linksApiToken: "LINKS_API_TOKEN" } as const;
