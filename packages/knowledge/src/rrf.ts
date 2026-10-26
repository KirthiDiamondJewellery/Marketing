/**
 * Reciprocal rank fusion (Cormack et al., 2009): each list contributes 1 / (k + rank) for every item it ranks,
 * rank starting at 1. Robust to the two lists' scores being on different scales (cosine vs ts_rank), which is
 * why hybrid search uses it instead of adding raw scores.
 */
export type Fused<T> = { id: T; score: number; ranks: (number | null)[] };

export function reciprocalRankFusion<T>(lists: T[][], k = 60): Fused<T>[] {
  const byId = new Map<T, Fused<T>>();
  lists.forEach((list, li) => {
    const seen = new Set<T>();
    list.forEach((id, i) => {
      if (seen.has(id)) return; // a duplicate in one list counts once, at its best rank
      seen.add(id);
      let entry = byId.get(id);
      if (!entry) {
        entry = { id, score: 0, ranks: lists.map(() => null) };
        byId.set(id, entry);
      }
      entry.ranks[li] = i + 1;
      entry.score += 1 / (k + i + 1);
    });
  });
  // Ties: the item ranked best in any list first, then the earlier list wins (stable and deterministic).
  const best = (f: Fused<T>) => Math.min(...f.ranks.map((r) => r ?? Number.POSITIVE_INFINITY));
  return [...byId.values()].sort((a, b) => b.score - a.score || best(a) - best(b));
}
