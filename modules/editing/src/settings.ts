import { moduleSettings, type WorkspaceContext } from "@attentionos/core";
import { z } from "zod";

/** `config.modules.editing.settings` (all optional). */
export const editingSettingsSchema = z
  .object({
    /** Format used when neither the request nor the content item names one. */
    defaultFormat: z.string().default("raw-talking-head"),
    /** Read by the ASR provider (asr-whispercpp): model size or path, language, threads. */
    asr: z
      .object({ model: z.string().default("small"), language: z.string().optional(), threads: z.number().int().positive().optional() })
      .prefault({}),
    /** Overrides for the cut planner (merged over the format's pacing.cut). */
    cut: z
      .object({
        strictDb: z.number().optional(),
        broadDb: z.number().optional(),
        wordPadS: z.number().nonnegative().optional(),
        hookProtectS: z.number().nonnegative().optional(),
        minKeepS: z.number().nonnegative().optional(),
        retakes: z.boolean().optional(),
        editNotes: z.boolean().optional(),
      })
      .prefault({}),
    /** Spoken phrases that mean "remove the take before this" (replace the defaults when set). */
    editNotePhrases: z.array(z.string().min(2)).optional(),
    /** Skip the cut-list review (it is also skipped when the Art Director runs on autopilot). */
    autoApproveCutList: z.boolean().default(false),
    /** x264 preset for renders: faster is lower quality per bit. */
    renderPreset: z.enum(["ultrafast", "veryfast", "fast", "medium"]).default("veryfast"),
  })
  .prefault({});

export type EditingSettings = z.output<typeof editingSettingsSchema>;

export function editingSettings(ws: Pick<WorkspaceContext, "config">): EditingSettings {
  const parsed = editingSettingsSchema.safeParse(moduleSettings(ws.config, "editing").settings);
  return parsed.success ? parsed.data : editingSettingsSchema.parse({});
}
