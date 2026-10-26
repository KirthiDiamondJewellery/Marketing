import { compact, defineTool, ToolError } from "@attentionos/core";
import { z } from "zod";
import { SETTING_KEYS } from "../settings.ts";
import { isQuietHours, parseQuietInput } from "../lib/quiet-hours.ts";
import { isDemoMode, quietWindow, setSetting } from "../lib/store.ts";

export const setQuietHoursTool = defineTool({
  name: "ops_set_quiet_hours",
  description:
    'Sets quiet hours in the workspace time zone, e.g. start "21:30", end "07:00" (may wrap past midnight), or off: true. During quiet hours normal and low priority messages wait; high priority ones (failed publishes, hot leads) still go out. Omit everything to read the current setting.',
  input: z.object({
    start: z.string().optional(),
    end: z.string().optional(),
    off: z.boolean().optional(),
  }),
  annotations: { idempotent: true },
  async handler({ ws }, input) {
    const tz = ws.config.workspace.timezone;
    if (input.off) {
      await setSetting(ws, SETTING_KEYS.quietHours, { off: true });
    } else if (input.start || input.end) {
      if (!input.start || !input.end) throw new ToolError("Give both a start and an end time.", 'For example start "21:30" and end "07:00".');
      let window;
      try {
        window = parseQuietInput(`${input.start}-${input.end}`);
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : "That isn't a valid time range.");
      }
      await setSetting(ws, SETTING_KEYS.quietHours, window);
    }
    const current = await quietWindow(ws);
    return compact({ timezone: tz, quietHours: current ?? "off", quietNow: isQuietHours(ws.now(), tz, current) });
  },
});

export const setDemoModeTool = defineTool({
  name: "ops_set_demo_mode",
  description:
    "Turns demo (reel) mode on or off. When on, other people's names, handles and emails are replaced with consistent fictional ones in briefs, approvals and chat, so the owner can film the product safely. Numbers stay real.",
  input: z.object({ on: z.boolean() }),
  annotations: { idempotent: true },
  async handler({ ws }, input) {
    await setSetting(ws, SETTING_KEYS.demoMode, { on: input.on });
    return { demoMode: await isDemoMode(ws) };
  },
});
