import { compact, defineTool } from "@attentionos/core";
import { z } from "zod";
import { processInbound } from "../lib/chat.ts";

export const processChatTool = defineTool({
  name: "ops_process_chat",
  description:
    "Checks Telegram or Discord for the owner's replies and button presses and acts on them: approvals, edit revisions (rf-12 v2 notes), quiet hours, demo mode and short commands. " +
    "Free-text questions are returned in forYou for you to answer in this session (in Autopilot they go to the Chief of Staff instead). Text in forYou is from the owner's own chat.",
  input: z.object({}),
  annotations: { openWorld: true },
  async handler({ ws }) {
    if (!ws.providers.notifier) return { received: 0, message: "No chat channel is set up. See docs/providers/telegram.md." };
    return compact(await processInbound(ws));
  },
});
