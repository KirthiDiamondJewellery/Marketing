/**
 * Alert dedupe. Each alert has a stable key ("account-expired:instagram", "run-failed:research.
 * competitor-scan"). `alert_log` remembers when each key was last sent; repeats inside the window are counted,
 * not sent, and the next alert after the window says how many were held back.
 */

export type AlertLogRow = { lastSentAt: Date; count: number } | null;

export type AlertDecision = {
  send: boolean;
  /** Repeats suppressed since the last delivery (shown in the next message). */
  suppressed: number;
  /** Values to store back into alert_log. */
  next: { lastSentAt: Date; count: number };
};

/**
 * Pure. `count` in alert_log is the number of occurrences since the last delivery (1 = just the delivered one).
 */
export function alertDecision(prev: AlertLogRow, now: Date, windowMs: number): AlertDecision {
  if (!prev) return { send: true, suppressed: 0, next: { lastSentAt: now, count: 1 } };
  const elapsed = now.getTime() - prev.lastSentAt.getTime();
  if (elapsed < windowMs) {
    return { send: false, suppressed: prev.count, next: { lastSentAt: prev.lastSentAt, count: prev.count + 1 } };
  }
  return { send: true, suppressed: Math.max(0, prev.count - 1), next: { lastSentAt: now, count: 1 } };
}

/** Message text for an alert, mentioning held-back repeats in plain language. */
export function alertText(text: string, suppressed: number): string {
  if (suppressed <= 0) return text;
  return `${text}\n_This happened ${suppressed} more time${suppressed === 1 ? "" : "s"} since the last alert._`;
}

/** Normalises an alert key: lowercase, no spaces, bounded length. */
export function alertKey(...parts: string[]): string {
  return parts
    .map((p) => p.toLowerCase().trim().replace(/\s+/g, "-"))
    .join(":")
    .slice(0, 200);
}
