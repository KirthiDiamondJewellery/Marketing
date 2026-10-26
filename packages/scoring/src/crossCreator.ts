import { contentWords } from "./text.ts";

/**
 * Cross-creator trends: a topic or hook pattern is a trend when it shows up in outliers from
 * at least `minCreators` different tracked creators. One creator having three hits on a topic is that
 * creator's niche, not a trend.
 */

export type OutlierTopicInput = {
  postId: string;
  /** Stable creator identity, e.g. `instagram:handle`. */
  creator: string;
  /** Explicit keys such as `pattern:question` or `format:green-screen`. */
  keys?: readonly string[];
  /** Free text (caption, spoken hook); content words become `topic:<word>` keys. */
  text?: string | null;
};

export type CrossCreatorTrend = {
  key: string;
  creators: string[];
  postIds: string[];
};

export type CrossCreatorOptions = {
  minCreators: number;
  /**
   * Keys that appear in more than this share of all posts are too generic to be a trend
   * ("business", "money"). Only applied once there are at least 6 posts. Default 0.5.
   */
  maxDocumentShare: number;
};

export function topicKeysOf(item: OutlierTopicInput): string[] {
  const keys = new Set<string>(item.keys ?? []);
  for (const w of contentWords(item.text)) keys.add(`topic:${w}`);
  return [...keys];
}

export function detectCrossCreatorTrends(items: readonly OutlierTopicInput[], opts: Partial<CrossCreatorOptions> = {}): CrossCreatorTrend[] {
  const minCreators = opts.minCreators ?? 2;
  const maxShare = opts.maxDocumentShare ?? 0.5;
  const byKey = new Map<string, { creators: Set<string>; postIds: Set<string> }>();
  for (const item of items) {
    for (const key of topicKeysOf(item)) {
      const entry = byKey.get(key) ?? { creators: new Set(), postIds: new Set() };
      entry.creators.add(item.creator);
      entry.postIds.add(item.postId);
      byKey.set(key, entry);
    }
  }
  const total = items.length;
  const out: CrossCreatorTrend[] = [];
  for (const [key, e] of byKey) {
    if (e.creators.size < minCreators) continue;
    if (total >= 6 && key.startsWith("topic:") && e.postIds.size / total > maxShare) continue;
    out.push({ key, creators: [...e.creators].sort(), postIds: [...e.postIds].sort() });
  }
  return out.sort((a, b) => b.creators.length - a.creators.length || b.postIds.length - a.postIds.length || a.key.localeCompare(b.key));
}
