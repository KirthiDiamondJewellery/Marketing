import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export function Card({
  className,
  signal,
  padded = true,
  ...props
}: HTMLAttributes<HTMLDivElement> & { signal?: boolean; padded?: boolean }) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface-1", padded && "p-6", signal && "signal-left", className)}
      {...props}
    />
  );
}

export function MetricCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card padded={false} className="p-5">
      <div className="text-small text-fg-2">{label}</div>
      <div className="mt-1 text-h1 font-medium tabular">{value}</div>
      {hint ? <div className="mt-1 text-caption text-fg-3">{hint}</div> : null}
    </Card>
  );
}
