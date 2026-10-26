import { z } from "zod";
import { moduleSettings, type AttentionOSConfig } from "@attentionos/core";

/** `config.modules.community.settings`. Every field has a safe default. */

export const communitySettingsSchema = z.object({
  dm: z.object({
    /** DM sent by the keyword automation. `{title}` = the lead magnet's title. Max 640 characters, no links (the button carries it). */
    text: z.string().min(1).max(640).default("Here's {title}. Tap the button below to open it."),
    buttonLabel: z.string().min(1).max(20).default("Get the guide"),
    /**
     * Instagram follow gate. Off by default: since 2026 Instagram refuses buttons to non-followers, and another DM tool on
     * the same account makes the gate's follow-up DM fail. Turn on only after testing on your account.
     */
    requireFollow: z.boolean().default(false),
    followGateText: z.string().max(640).optional(),
    /** Optional public reply on the comment. */
    replyComment: z.string().max(300).optional(),
    /** exact_word avoids firing on comments that merely contain the keyword inside another word. */
    matchMode: z.enum(["exact_word", "contains"]).default("exact_word"),
  }).default({ text: "Here's {title}. Tap the button below to open it.", buttonLabel: "Get the guide", requireFollow: false, matchMode: "exact_word" }),
  triage: z.object({
    /** How far back the first sweep looks. */
    lookbackHours: z.number().int().min(1).max(24 * 90).default(48),
    /** Items per AI classification batch. */
    batchSize: z.number().int().min(1).max(50).default(20),
    /** Hot becomes Warm after this many days waiting; Warm becomes Cold after warmDays. Priorities never move up. */
    hotDays: z.number().int().min(1).max(365).default(30),
    warmDays: z.number().int().min(1).max(730).default(90),
    /** Extra spam patterns (regular expressions, case-insensitive). */
    spamPatterns: z.array(z.string()).default([]),
    /** Links that mark a message as automated (link-in-bio tools, DM tools). */
    automationLinkPatterns: z.array(z.string()).default(["linktr\\.ee", "manychat", "bit\\.ly"]),
    /** Lines you really type often (so they aren't mistaken for automation). */
    humanTypedLines: z.array(z.string()).default([]),
  }).default({ lookbackHours: 48, batchSize: 20, hotDays: 30, warmDays: 90, spamPatterns: [], automationLinkPatterns: ["linktr\\.ee", "manychat", "bit\\.ly"], humanTypedLines: [] }),
  /** Seed for the rotating comment-reply bank (stored in the reply_bank table on first use). */
  replyBank: z.array(z.string().min(1).max(300)).default([]),
  leadMagnets: z.object({ emailGate: z.boolean().default(true) }).default({ emailGate: true }),
}).loose();
export type CommunitySettings = z.output<typeof communitySettingsSchema>;

export function communitySettings(config: AttentionOSConfig): CommunitySettings {
  const parsed = communitySettingsSchema.safeParse(moduleSettings(config, "community").settings);
  if (!parsed.success) throw new Error(`Community settings aren't valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Shown before automated DMs are turned on (config.acknowledgements.automatedDmRisk). */
export const AUTOMATED_DM_NOTICE =
  "Automated DMs act on your account. Instagram and Facebook limit them (one private reply per comment, within 7 days; replies only within 24 hours of the person's last message), and running a second DM tool on the same account can make messages fail. Set acknowledgements.automatedDmRisk to true in your config once you've read this.";
