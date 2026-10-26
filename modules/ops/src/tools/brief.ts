import { compact, defineTool } from "@attentionos/core";
import { z } from "zod";
import { opsSettings } from "../settings.ts";
import { composeBrief } from "../lib/brief.ts";
import { loadBriefData } from "../lib/brief-data.ts";
import { loadMasker } from "../lib/store.ts";

export const getMorningBriefTool = defineTool({
  name: "ops_get_morning_brief",
  description:
    "Today's morning brief for the owner: pieces to film today (from the Strategist's daily plan), approvals waiting, posts going out today, yesterday's results against their own baseline, and alerts. " +
    'format "markdown" returns a ready-to-send brief; "data" returns the facts so you can write it yourself; "both" returns both. Numbers are exact; never add numbers that are not here.',
  input: z.object({ format: z.enum(["markdown", "data", "both"]).default("markdown") }),
  annotations: { readOnly: true, idempotent: true },
  async handler({ ws }, input) {
    const data = await loadBriefData(ws);
    const masker = await loadMasker(ws);
    const brief = composeBrief(data, { mask: masker.text, maxApprovals: opsSettings(ws.config).briefApprovals });
    return compact({
      date: data.date,
      title: brief.title,
      demoMode: masker.on || undefined,
      markdown: input.format === "data" ? undefined : brief.markdown,
      data: input.format === "markdown" ? undefined : data,
    });
  },
});
