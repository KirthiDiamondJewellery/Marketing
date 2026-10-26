import type { AttentionOSConfig } from "@attentionos/core";
import type { EditPlan, EditRenderer, RenderRequest, RenderResult } from "@attentionos/media";

/**
 * Motion engine (Remotion), opt-in. v0.1 ships the interface only; see README.md and LICENSE-NOTICE.md.
 * It implements the same EditRenderer contract as the cut engine so the editing module can switch with
 * `config.providers.renderer: "motion"` once it exists.
 */

export class MotionEngineUnavailable extends Error {
  readonly code = "motion_unavailable" as const;
  constructor(message: string, public readonly fix: string) {
    super(message);
    this.name = "MotionEngineUnavailable";
  }
}

export const MOTION_LICENSE_URL = "https://www.remotion.dev/license";

export function createMotionRenderer(opts: { config: AttentionOSConfig }): EditRenderer {
  const acknowledged = opts.config.acknowledgements.remotionLicense;
  return {
    id: "motion",
    supports(_plan: EditPlan) {
      return { ok: false, unsupported: ["the motion engine is not available in this version"] };
    },
    async render(_req: RenderRequest): Promise<RenderResult> {
      if (!acknowledged) {
        throw new MotionEngineUnavailable(
          "The motion engine needs the Remotion license acknowledged first.",
          `Read ${MOTION_LICENSE_URL}, then set acknowledgements.remotionLicense: true in config/attentionos.config.ts.`,
        );
      }
      throw new MotionEngineUnavailable(
        "The motion engine is not available in this version of AttentionOS.",
        'Use the cut engine: set providers.renderer to "cut" (the default). The motion engine is planned for v0.4.',
      );
    },
  };
}
