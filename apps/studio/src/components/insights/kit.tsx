import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui";

/** Small shared pieces for the Insights views (server-safe). */

export { fmtUnit, type Unit } from "./units";

/** Change indicator: success/danger text with an arrow, never a colored background (DESIGN §8.7). */
export function Delta({ change, better = "up", suffix = "vs previous period", points }: { change: number | null; better?: "up" | "down"; suffix?: string; points?: boolean }) {
  if (change === null) return <span className="text-caption text-fg-3">No earlier period to compare</span>;
  const pct = points ? change : change * 100;
  if (Math.abs(pct) < 0.5) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-fg-3">
        <Minus className="size-3.5" aria-hidden /> No change {suffix}
      </span>
    );
  }
  const up = pct > 0;
  const good = better === "up" ? up : !up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-1 text-caption", good ? "text-success" : "text-danger")}>
      <Icon className="size-3.5" aria-hidden />
      {Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}
      {points ? " pts" : "%"} {suffix}
    </span>
  );
}

/** Metric card (DESIGN §8.7): surface-1, small secondary label, heading-1 value, delta below. */
export function Stat({ label, value, delta, hint, className }: { label: string; value: ReactNode; delta?: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 px-5 py-4 sm:px-6", className)}>
      <span className="text-small text-fg-2">{label}</span>
      <span className="text-h1 font-medium text-fg">{value}</span>
      {delta}
      {hint ? <span className="text-caption text-fg-3">{hint}</span> : null}
    </div>
  );
}

/** A card with a title, the one-sentence takeaway above its chart (DESIGN §9) and optional actions. */
export function Panel({ title, takeaway, actions, children, className, id }: { title: string; takeaway?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section aria-labelledby={id} className={cn("min-w-0 rounded-lg border border-border bg-surface-1 p-5 sm:p-6", className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-h3 font-medium text-fg">
            {title}
          </h2>
          {takeaway ? <p className="mt-0.5 max-w-[68ch] text-small text-fg-2">{takeaway}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A GAP line: missing data stated plainly, never dressed as a finding. */
export function Gap({ children, className }: { children: ReactNode; className?: string }) {
  const text = typeof children === "string" ? children.replace(/^GAP:\s*/, "") : children;
  return (
    <p className={cn("rounded-md bg-surface-2 px-3 py-2 text-caption text-fg-2", className)}>
      <span className="font-medium text-fg">Gap:</span> {text}
    </p>
  );
}

export const VERDICT: Record<string, { label: string; tone: string }> = {
  clear_win: { label: "Clearly better", tone: "text-success" },
  leaning_up: { label: "Leaning better", tone: "text-fg-2" },
  flat: { label: "About usual", tone: "text-fg-3" },
  leaning_down: { label: "Leaning worse", tone: "text-fg-2" },
  clear_loss: { label: "Clearly worse", tone: "text-danger" },
  gap: { label: "Too few posts", tone: "text-fg-3" },
};
