# @attentionos/render-motion

The **motion engine**: an opt-in second renderer for the same `EditPlan` the cut engine renders (ADR-7). Status in
v0.1: **interface only**. The implementation (Remotion) lands in v0.4; until then every edit renders with the cut
engine in `media-py`.

Read [LICENSE-NOTICE.md](./LICENSE-NOTICE.md) first: Remotion needs a paid company license for companies with more
than 3 people.

## What it will do

- Layout-mode timelines (`full`, `split`, `fullVisual`, `inset`) from `plan.layout.segments`, keyed to OUTPUT frames
  through the same time map the cut engine uses (`@attentionos/media` `TimeMap`).
- Frozen, pre-rendered segments: approved segments are rendered once and reused, so revisions stay byte-stable.
- SFX keyed to keyframes (the cut engine's synthesised, CC0-by-construction sounds), captions and graphics from the
  plan, export at 1080×1920 / 30 fps, then the same `finish` (loudnorm) and `qc` steps as the cut engine.

## Interface

```ts
import { createMotionRenderer } from "@attentionos/render-motion";
const renderer = createMotionRenderer({ config }); // implements EditRenderer from @attentionos/media
renderer.supports(plan); // { ok, unsupported[] }
await renderer.render(request); // v0.1: throws MotionEngineUnavailable with a plain-language fix
```

`EditRenderer` (from `@attentionos/media`):

```ts
interface EditRenderer {
  readonly id: "cut" | "motion";
  supports(plan: EditPlan): { ok: boolean; unsupported: string[] };
  render(req: RenderRequest, opts?: MediaPyOptions): Promise<RenderResult>;
}
```
