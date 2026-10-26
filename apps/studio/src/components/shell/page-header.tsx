import type { ReactNode } from "react";

/** Page title + one primary action slot (DESIGN §4.1). Every OS page starts with one. */
export function PageHeader({ title, description, actions, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {meta ? <div className="mb-2 text-small text-fg-3">{meta}</div> : null}
        <h1 className="text-h1 font-medium tracking-[-0.01em] text-fg">{title}</h1>
        {description ? <p className="mt-1.5 max-w-[60ch] text-body text-fg-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Section title used inside pages: heading-2 with optional trailing link/action. */
export function SectionTitle({ children, action, id, count }: { children: ReactNode; action?: ReactNode; id?: string; count?: number }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-4">
      <h2 id={id} className="text-h2 font-medium text-fg">
        {children}
        {typeof count === "number" ? <span className="ml-2 text-fg-3 tabular">{count}</span> : null}
      </h2>
      {action}
    </div>
  );
}
