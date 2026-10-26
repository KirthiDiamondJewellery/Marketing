import { moduleSettings, type WorkspaceContext } from "@attentionos/core";
import { z } from "zod";

/** `config.modules.production.settings`. Studio's edit queue can override `reviewCuts` live (settings table). */
export const productionSettingsSchema = z
  .object({
    /**
     * "Review cuts before editing": stop at the cut list for a person to approve it. Off by default, so the owner only
     * sees the finished video (the cut list is approved for them and they can still ask for changes on the video).
     */
    reviewCuts: z.boolean().default(false),
    /** Link an upload to its script on its own when the match is clear. */
    autoLink: z.boolean().default(true),
    /** Smallest match score (0 to 1) that links on its own. */
    autoLinkAbove: z.number().min(0).max(1).default(0.62),
    /** And it must beat the runner-up by this much. */
    autoLinkMargin: z.number().min(0).max(1).default(0.12),
    /** Seconds from the start of a take that are transcribed to find its script. */
    matchWindowS: z.number().int().min(10).max(300).default(60),
    /** Seconds between pipeline checks while edits are in flight. */
    advanceEveryS: z.number().int().min(5).max(300).default(12),
  })
  .prefault({});

export type ProductionSettings = z.output<typeof productionSettingsSchema>;

/** Key in the `settings` table for overrides saved from Studio (applied without a restart). */
export const LIVE_SETTINGS_KEY = "production:settings";

export function productionSettings(ws: Pick<WorkspaceContext, "config">, live?: Partial<ProductionSettings> | null): ProductionSettings {
  const raw = { ...((moduleSettings(ws.config, "production").settings as Record<string, unknown> | undefined) ?? {}), ...(live ?? {}) };
  const parsed = productionSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : productionSettingsSchema.parse({});
}

/** Config settings merged with the live overrides from the settings table. */
export async function loadProductionSettings(ws: Pick<WorkspaceContext, "config" | "sql" | "id">): Promise<ProductionSettings> {
  const rows = await ws.sql<{ value: Partial<ProductionSettings> }[]>`select value from settings where workspace_id = ${ws.id} and key = ${LIVE_SETTINGS_KEY}`;
  return productionSettings(ws, rows[0]?.value ?? null);
}
