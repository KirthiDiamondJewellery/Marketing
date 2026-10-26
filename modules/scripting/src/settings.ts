import { z } from "zod";
import { CTA_TYPES, type WorkspaceContext } from "@attentionos/core";

/** `config.modules.scripting.settings` (all optional with safe defaults). */
export const scriptingSettingsSchema = z.object({
  /** Speaking rate used for the length window. */
  wpm: z.number().min(80).max(260).default(160),
  minSeconds: z.number().positive().default(15),
  maxSeconds: z.number().positive().default(60),
  hookMaxSeconds: z.number().positive().default(3),
  /** Revisions the write-script job asks the model for after the first draft. */
  maxRevisions: z.number().int().min(0).max(5).default(2),
  /** Share of hook picks that explore patterns regardless of learned weights. */
  exploration: z.number().min(0).max(1).default(0.2),
  /** Own openers that beat the median by this factor enter the own bank. */
  ownBankMultiplier: z.number().positive().default(3),
  /** Competitor bank size cap; lowest decayed scores are retired first. */
  competitorBankCap: z.number().int().positive().default(300),
  /** Competitor hook scores halve every N days. */
  competitorHalfLifeDays: z.number().positive().default(60),
  /** A bank hook used within this many days isn't offered again. */
  hookCooldownDays: z.number().int().nonnegative().default(14),
  /** Numbers said in the last N scripts count as spent stats. */
  spentStatWindow: z.number().int().nonnegative().default(10),
  /** Acronyms longer than 3 letters that may be written in capitals. */
  allowedCaps: z.array(z.string()).default([]),
  /** Brand CTA lines per CTA type; `{word}` is replaced with the keyword in capitals. */
  ctaLines: z.partialRecord(z.enum(CTA_TYPES), z.string()).default({}),
  /** Weekly text post counts. */
  textPosts: z.object({
    x: z.number().int().nonnegative().default(3),
    threads: z.number().int().nonnegative().default(2),
    linkedin: z.number().int().nonnegative().default(1),
  }).default({ x: 3, threads: 2, linkedin: 1 }),
});
export type ScriptingSettings = z.output<typeof scriptingSettingsSchema>;

export function scriptingSettings(ws: WorkspaceContext): ScriptingSettings {
  const raw = ws.config.modules?.scripting?.settings ?? {};
  const parsed = scriptingSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    ws.log.warn("scripting settings are invalid; using defaults", { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    return scriptingSettingsSchema.parse({});
  }
  return parsed.data;
}
