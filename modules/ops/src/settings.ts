import { moduleSettings, type AttentionOSConfig } from "@attentionos/core";
import { z } from "zod";

/** `config.modules.ops.settings` in the workspace config. */
export const opsSettingsSchema = z.object({
  /** The same alert is sent at most once per window; repeats are counted and mentioned next time. */
  alertDedupeMinutes: z.number().int().min(1).max(7 * 24 * 60).default(180),
  /** Reel mode: hide other people's names and handles (numbers stay real). The chat command overrides it. */
  demoMode: z.boolean().default(false),
  /** How many approvals the brief lists before "and N more". */
  briefApprovals: z.number().int().min(1).max(20).default(5),
  /** Messages delivered per outbox run. */
  dispatchBatch: z.number().int().min(1).max(100).default(20),
  /** Delivery attempts before a message is marked failed. */
  maxSendAttempts: z.number().int().min(1).max(20).default(5),
  /** Post a message for each new approval with approve/reject buttons. */
  notifyApprovals: z.boolean().default(true),
});
export type OpsSettings = z.output<typeof opsSettingsSchema>;

export function opsSettings(config: AttentionOSConfig): OpsSettings {
  const parsed = opsSettingsSchema.safeParse(moduleSettings(config, "ops").settings ?? {});
  return parsed.success ? parsed.data : opsSettingsSchema.parse({});
}

/** Keys in the `settings` table (runtime overrides set from chat or tools). */
export const SETTING_KEYS = {
  demoMode: "ops.demo_mode",
  quietHours: "ops.quiet_hours",
  inboundCursor: (channel: string) => `ops.inbound_cursor.${channel}`,
} as const;
