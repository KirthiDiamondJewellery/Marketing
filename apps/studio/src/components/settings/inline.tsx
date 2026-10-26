import { Fragment, type ReactNode } from "react";

/** Renders `backticked` spans of plain copy as inline code. */
export function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded-sm bg-surface-2 px-1 py-px font-mono text-[0.92em] text-fg">
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
