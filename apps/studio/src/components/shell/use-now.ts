"use client";
import { useEffect, useState } from "react";

/** Re-renders on an interval so relative times ("3 min ago") stay true. Starts at 0 on the server to avoid mismatches. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
