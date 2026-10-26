import type { EditPlan } from "./edit-plan.ts";
import { mediaPy, type MediaPyOptions } from "./media-py.ts";
import type { RenderRequest, RenderResult } from "./results.ts";

/**
 * One EditPlan, two renderers (ADR-7). The cut engine (media-py: ffmpeg + PIL + OpenCV) is the default; the motion
 * engine (`@attentionos/render-motion`, Remotion, opt-in with a license acknowledgement) implements the same
 * interface later.
 */
export interface EditRenderer {
  readonly id: "cut" | "motion";
  /** Whether this renderer can draw every element of the plan (unsupported parts are reported, not dropped silently). */
  supports(plan: EditPlan): { ok: boolean; unsupported: string[] };
  render(req: RenderRequest, opts?: MediaPyOptions): Promise<RenderResult>;
}

export const cutRenderer: EditRenderer = {
  id: "cut",
  supports: () => ({ ok: true, unsupported: [] }),
  render: (req, opts) => mediaPy<RenderResult>("render", req, opts),
};
