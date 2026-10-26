import { z } from "zod";
import { defineNativeJob, ProviderError } from "@attentionos/core";
import { alertOnce } from "../lib/ops.ts";
import { collapseTrialVariants, syncOwnMetrics } from "../repo/ownPosts.ts";
import { researchSettings } from "../settings.ts";

export const ownSyncInput = z.object({
  /** Re-read the whole history instead of the recent lookback window (first run, or after connecting IG Graph). */
  backfill: z.boolean().default(false),
});

export const ownSyncJob = defineNativeJob({
  kind: "native",
  id: "research.own-sync",
  agent: "analyst",
  description: "Pulls your own posts and their latest numbers from your analytics provider.",
  input: ownSyncInput,
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const { ws } = ctx;
    if (!ws.providers.ownAnalytics) {
      await ctx.progress("No analytics provider is connected yet, so there were no numbers to pull");
      return { skipped: "no_provider" };
    }
    const settings = researchSettings(ws);
    const since = ctx.input.backfill ? undefined : new Date(ws.now().getTime() - settings.ownSync.lookbackDays * 86_400_000).toISOString();
    try {
      const res = await syncOwnMetrics(ws, since ? { since } : {});
      const collapsed = await collapseTrialVariants(ws);
      await ctx.progress(
        `Updated numbers for ${res.snapshots} post${res.snapshots === 1 ? "" : "s"}` +
          (res.postsCreated ? `, including ${res.postsCreated} older post${res.postsCreated === 1 ? "" : "s"} seen for the first time` : "") +
          (collapsed ? `; grouped ${collapsed} trial variant${collapsed === 1 ? "" : "s"} with their main post` : ""),
      );
      return { accounts: res.accounts, snapshots: res.snapshots, postsCreated: res.postsCreated, variantsCollapsed: collapsed };
    } catch (err) {
      if (err instanceof ProviderError && err.code === "auth") {
        await alertOnce(ws, `own-sync:auth:${err.provider}`, `Your ${err.provider} connection needs attention: ${err.message}. Run \`attentionos doctor\` for the fix.`);
        return { skipped: "auth" };
      }
      throw err;
    }
  },
});
