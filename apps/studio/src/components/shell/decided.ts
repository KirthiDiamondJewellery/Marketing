"use client";
import { useSyncExternalStore } from "react";
import type { ApprovalItem } from "@/lib/live";

/**
 * Approvals decided in this tab, so the nav badge and the stream update the instant you decide instead of waiting for
 * the next live snapshot. Ids stay hidden for the life of the tab; a decided approval never returns to pending.
 */
let decided = new Set<string>();
const subs = new Set<() => void>();

export function markDecided(ids: string[]): void {
  decided = new Set([...decided, ...ids]);
  for (const fn of subs) fn();
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function usePendingApprovals(approvals: ApprovalItem[] | undefined): ApprovalItem[] {
  const set = useSyncExternalStore(subscribe, () => decided, () => decided);
  const list = approvals ?? [];
  return set.size ? list.filter((a) => !set.has(a.id)) : list;
}
