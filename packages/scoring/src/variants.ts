import { isNum } from "./stats.ts";

/**
 * Trial-variant collapse: trial reels of the same piece are one piece of content. The group is
 * represented by its best-performing variant as a whole record (its numbers are kept together, never summed or
 * averaged across variants), and carries how many variants it had.
 */
export function collapseVariants<T>(
  rows: readonly T[],
  groupOf: (row: T) => string,
  score: (row: T) => number | null | undefined,
): { row: T; variants: number; members: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = groupOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((members) => {
    let best: T = members[0]!;
    for (const m of members.slice(1)) {
      const a = score(best);
      const b = score(m);
      if (isNum(b) && (!isNum(a) || b > a)) best = m;
    }
    return { row: best, variants: members.length, members };
  });
}
