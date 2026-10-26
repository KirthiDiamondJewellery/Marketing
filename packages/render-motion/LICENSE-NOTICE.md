# License notice: Remotion

This package (`@attentionos/render-motion`) is MIT-licensed, like the rest of AttentionOS. **The library it will
use to render, Remotion, is not.** Remotion is free for individuals and for companies with up to 3 people; larger
companies need a paid Remotion Company License. Read the current terms before turning the motion engine on:
https://www.remotion.dev/license

What AttentionOS does about it:

- The motion engine is **opt-in**. The default renderer is the cut engine (ffmpeg, PIL and OpenCV in `media-py`),
  which has no such license.
- Remotion is **not a dependency of this repository**. It is installed into your workspace only when you enable
  the motion engine.
- Enabling it requires `acknowledgements.remotionLicense: true` in `config/attentionos.config.ts`; setup shows this
  notice and asks you to confirm it applies to you.

Assets follow the AttentionOS assets policy in either engine: CC0 or self-synthesised sound effects only, OFL fonts
only, and no third-party footage without a license and a provenance record.
