"use client";
import { relTime } from "./format";
import { useNow } from "./use-now";

/** Relative time that keeps itself current. */
export function RelTime({ iso, className, prefix }: { iso: string | null | undefined; className?: string; prefix?: string }) {
  const now = useNow();
  if (!iso) return null;
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning title={new Date(iso).toLocaleString()}>
      {prefix}
      {relTime(iso, now)}
    </time>
  );
}
