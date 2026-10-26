import { z } from "zod";
import { moduleSettings, type WorkspaceContext } from "@attentionos/core";

/** `config.modules.knowledge.settings`. Which embedder to use is top-level config: `knowledge.embeddings`. */
export const knowledgeSettingsSchema = z.object({
  /**
   * When a search finds the index older than this many minutes, it catches up first (only changes are embedded).
   * Keeps "On request" workspaces fresh without the hourly schedule. 0 turns it off.
   */
  refreshOnSearchMinutes: z.number().int().nonnegative().default(60),
});
export type KnowledgeSettings = z.output<typeof knowledgeSettingsSchema>;

export function knowledgeSettings(ws: WorkspaceContext): KnowledgeSettings {
  return knowledgeSettingsSchema.parse(moduleSettings(ws.config, "knowledge").settings ?? {});
}
