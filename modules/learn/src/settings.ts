import { z } from "zod";
import { moduleSettings, type AttentionOSConfig } from "@attentionos/core";

/** `config.modules.learn.settings`. */
export const learnSettingsSchema = z.object({
  attribution: z.object({
    /** Below this many posts a value gets a GAP line instead of a verdict. */
    minN: z.number().int().positive().default(5),
    confidence: z.number().min(0.5).max(0.99).default(0.9),
  }).default({ minN: 5, confidence: 0.9 }),
  weights: z.object({
    /** Share of picks that ignore the weights and explore. */
    explore: z.number().min(0).max(1).default(0.2),
    /** Own data takes over from competitor signals at about this many own posts. */
    fullTrustAt: z.number().int().positive().default(20),
    min: z.number().positive().default(0.5),
    max: z.number().positive().default(2),
  }).default({ explore: 0.2, fullTrustAt: 20, min: 0.5, max: 2 }),
  postMortem: z.object({
    breakoutX: z.number().positive().default(2),
    flopX: z.number().positive().default(0.6),
    /** A skip rate at or above this (most viewers gone in the first seconds) also gets a post-mortem. */
    flopSkipRate: z.number().min(0).max(1).default(0.7),
    /** Post-mortems wait for this snapshot so the numbers have settled. */
    afterSnapshot: z.enum(["72h", "7d"]).default("72h"),
  }).default({ breakoutX: 2, flopX: 0.6, flopSkipRate: 0.7, afterSnapshot: "72h" }),
  weeklyBriefing: z.object({
    /** Also queue a short LLM-written summary on top of the numbers. */
    prose: z.boolean().default(false),
  }).default({ prose: false }),
  slots: z.object({
    /** Hours per heatmap block (24 / blockHours blocks a day). */
    blockHours: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(6)]).default(3),
    /** Posts a slot needs before it can be called a best slot. */
    minN: z.number().int().positive().default(3),
    /** Pseudo-posts at the account's normal added to every slot, so one lucky post can't crown a slot. */
    priorN: z.number().int().min(0).default(3),
  }).default({ blockHours: 3, minN: 3, priorN: 3 }),
  pacing: z.object({
    /** Projected within this share of the target counts as "at risk" rather than "behind". */
    atRiskShare: z.number().min(0.5).max(1).default(0.85),
  }).default({ atRiskShare: 0.85 }),
  costWatch: z.object({
    /** Warn at this share of a budget; alert again at 100%. */
    warnAt: z.number().min(0.1).max(1).default(0.8),
  }).default({ warnAt: 0.8 }),
});
export type LearnSettings = z.output<typeof learnSettingsSchema>;

export function learnSettings(ws: { config: AttentionOSConfig }): LearnSettings {
  return learnSettingsSchema.parse(moduleSettings(ws.config, "learn").settings ?? {});
}
