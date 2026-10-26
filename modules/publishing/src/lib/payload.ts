import { IssueCollector, validatePublishPayload, type ValidationResult } from "@attentionos/guardrails";
import type { CtaType, MediaRef, PublisherCapabilities, PublishRequest, SocialAccount } from "@attentionos/core";

/**
 * Payload gate run BEFORE any provider call. The generic checks (accounts snapshot, capabilities,
 * per-platform fields, media, schedule, trial-reel acknowledgement) come from `@attentionos/guardrails`; this adds
 * the publishing rules that depend on the post's call to action.
 */

export type PayloadCheckInput = {
  request: PublishRequest;
  accounts: readonly SocialAccount[];
  capabilities: PublisherCapabilities;
  now: Date;
  /** Minimum minutes between now and `scheduledAt`. */
  leadMinutes: number;
  acknowledgements?: { trialReelsRisk?: boolean };
  cta?: { type: CtaType | string | null; keyword?: string | null };
  /** Size lookup for local media, checked against the publisher's limit. */
  mediaBytes?: (media: MediaRef) => number | undefined;
};

export function checkPayload(input: PayloadCheckInput): ValidationResult {
  const c = new IssueCollector();
  c.merge(validatePublishPayload(input.request, input.accounts, input.capabilities, {
    now: input.now,
    minLeadMs: input.leadMinutes * 60_000,
    ...(input.acknowledgements ? { acknowledgements: input.acknowledgements } : {}),
    ...(input.mediaBytes ? { mediaBytes: input.mediaBytes } : {}),
  }));

  const { request: req } = input;
  const keyword = input.cta?.keyword?.trim();
  if (input.cta?.type === "comment_keyword" && keyword) {
    const lower = req.caption.toLowerCase();
    const kw = keyword.toLowerCase();
    if (req.platform === "instagram" && !new RegExp(`\\b${kw}\\b`).test(lower)) {
      c.error("publishing.keyword_missing", `The Instagram caption doesn't mention the comment keyword "${keyword.toUpperCase()}".`, {
        path: "caption", fix: `Add the CTA line, e.g. "Comment ${keyword.toUpperCase()} and I'll send it to you."`,
      });
    }
    if (req.platform === "tiktok" && !lower.includes(`dm me ${kw}`) && !lower.includes("link in bio")) {
      c.error("publishing.tiktok_cta", "The comment automation only runs on Instagram, so the TikTok caption needs another way in.", {
        path: "caption", fix: `Say "DM me ${keyword.toUpperCase()}" or "link in bio".`,
      });
    }
  }
  return c.result();
}

/** One plain-language line per problem, for tool output and notifications. */
export function describeCheck(check: ValidationResult): string {
  if (check.ok && check.warnings.length === 0) return "Looks good.";
  return [
    ...check.errors.map((e) => `Fix: ${e.message}${e.fix ? ` ${e.fix}` : ""}`),
    ...check.warnings.map((w) => `Note: ${w.message}`),
  ].join("\n");
}
