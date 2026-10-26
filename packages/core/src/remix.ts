/**
 * Provenance of a remix: a script that closely remakes one proven post (a competitor's outlier or one of the
 * owner's own breakouts). Stored on `content.brief.remixOf` by whoever picks the source (the Strategist, Studio's
 * "Remix this", or the Copywriter), so every surface can say where a script came from.
 */
export type RemixOf = {
  externalPostId: string;
  url: string;
  handle: string;
  platform: string;
  /** True for the owner's own post ("do that again, new angle"). */
  own: boolean;
  views: number | null;
  /** Times the creator's normal (competitors: the outlier x score; own posts: views over the owner's median). */
  x: number | null;
  /** "Based on @handle's reel, 1.2M views, 14x their normal". */
  line: string;
};

const PLATFORM_NOUN: Record<string, string> = {
  instagram: "reel", tiktok: "TikTok", youtube: "Short", facebook: "reel", linkedin: "video", x: "post", threads: "post",
};

/** 1.2M, 48K, 950. */
export function formatViews(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return null;
  const fmt = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`;
  if (n >= 1_000_000) return fmt(n / 1_000_000, "M");
  if (n >= 1_000) return fmt(n / 1_000, "K");
  return String(Math.round(n));
}

/** Plain-language provenance line shown next to a remix script. */
export function basedOnLine(s: { handle: string; platform: string; own: boolean; views: number | null; x: number | null }): string {
  const noun = PLATFORM_NOUN[s.platform] ?? "post";
  const who = s.own ? `your own ${noun}` : `@${s.handle.replace(/^@+/, "")}'s ${noun}`;
  const parts = [`Based on ${who}`];
  const views = formatViews(s.views);
  if (views) parts.push(`${views} views`);
  if (s.x !== null && Number.isFinite(s.x) && s.x > 0) parts.push(`${s.x >= 10 ? Math.round(s.x) : Math.round(s.x * 10) / 10}x ${s.own ? "your" : "their"} normal`);
  return parts.join(", ");
}

export function makeRemixOf(s: Omit<RemixOf, "line">): RemixOf {
  return { ...s, handle: s.handle.replace(/^@+/, ""), line: basedOnLine(s) };
}

/**
 * A remix's working title. Once its source has a checked blueprint the title is the blueprint's topic ("Remix: How
 * one person runs a company on agents"); before that, a placeholder that says where it came from.
 */
export function remixTitle(s: { topic?: string | null; own: boolean; handle: string; platform: string; views: number | null }): string {
  let topic = s.topic?.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  // A working title, not a paragraph: at most 80 characters, cut at a word.
  if (topic && topic.length > 80) topic = topic.slice(0, 81).replace(/\s+\S*$/, "").replace(/[\s,;:/(-]+$/, "");
  if (topic) return `Remix: ${topic.charAt(0).toUpperCase()}${topic.slice(1)}`;
  const views = formatViews(s.views);
  return `Remix: ${s.own ? "your" : `@${s.handle.replace(/^@+/, "")}'s`} ${views ? `${views}-view ` : ""}${s.platform} post`;
}

/** True for the placeholder `remixTitle` gives before the source's topic is known. */
export function isPlaceholderRemixTitle(title: string): boolean {
  return /^Remix: (your|@\S+'s) (\d[\d.]*[KM]?-view )?[a-z]+ post$/.test(title.trim());
}
