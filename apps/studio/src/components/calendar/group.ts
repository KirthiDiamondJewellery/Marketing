import type { CalendarPost } from "@/server/queries/calendar";
import { dayKey, zonedParts } from "@/components/content/format";

/** One tile on the calendar: the posts of one piece of content going out at the same moment. */
export type PostGroup = {
  key: string;
  contentId: string | null;
  title: string;
  at: string;
  day: string;
  minutes: number;
  posts: CalendarPost[];
  thumbId: string | null;
  movable: boolean;
  status: string;
  /** Instagram trial reels: kept apart from the main post, never dragged (their times come from the day's plan). */
  trial: boolean;
};

export const MOVABLE = new Set(["draft", "queued", "scheduled", "assist"]);
const PRIORITY = ["failed", "assist", "publishing", "draft", "queued", "scheduled", "published"];

export function groupPosts(posts: CalendarPost[], tz: string): PostGroup[] {
  const map = new Map<string, PostGroup>();
  for (const p of posts) {
    const key = `${p.contentId ?? p.id}|${p.at}${p.trial ? "|trial" : ""}`;
    let g = map.get(key);
    if (!g) {
      const zp = zonedParts(p.at, tz);
      g = {
        key,
        contentId: p.contentId,
        title: p.title ?? p.caption?.split("\n")[0] ?? "Untitled post",
        at: p.at,
        day: dayKey(p.at, tz),
        minutes: zp.h * 60 + zp.mi,
        posts: [],
        thumbId: p.thumbId,
        movable: false,
        status: p.status,
        trial: p.trial,
      };
      map.set(key, g);
    }
    g.posts.push(p);
    if (MOVABLE.has(p.status) && !p.trial) g.movable = true;
  }
  for (const g of map.values()) {
    // Lead with what most of the posts are doing; a failure shows as its own count on the tile.
    const live = g.posts.filter((p) => p.status !== "failed");
    const pool = live.length ? live : g.posts;
    g.status = pool.reduce((best, p) => (PRIORITY.indexOf(p.status) < PRIORITY.indexOf(best) ? p.status : best), pool[0]!.status);
  }
  return [...map.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** Side-by-side lanes for tiles that overlap in time (greedy interval colouring). */
export function assignLanes(groups: PostGroup[], spanMinutes: number): Map<string, { lane: number; lanes: number; cluster: number }> {
  const out = new Map<string, { lane: number; lanes: number; cluster: number }>();
  let clusterNo = 0;
  const sorted = [...groups].sort((a, b) => a.minutes - b.minutes);
  let cluster: PostGroup[] = [];
  let clusterEnd = -1;
  const laneEnds: number[] = [];
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((g) => out.get(g.key)?.lane ?? 0).map((l) => l + 1));
    for (const g of cluster) out.set(g.key, { lane: out.get(g.key)?.lane ?? 0, lanes, cluster: clusterNo });
    clusterNo++;
    cluster = [];
    laneEnds.length = 0;
  };
  for (const g of sorted) {
    if (g.minutes >= clusterEnd && cluster.length) flush();
    let lane = laneEnds.findIndex((end) => end <= g.minutes);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = g.minutes + spanMinutes;
    out.set(g.key, { lane, lanes: 1, cluster: clusterNo });
    cluster.push(g);
    clusterEnd = Math.max(clusterEnd, g.minutes + spanMinutes);
  }
  if (cluster.length) flush();
  return out;
}

export function statusSummary(posts: CalendarPost[]): string {
  const counts = new Map<string, number>();
  for (const p of posts) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]))
    .map(([s, n]) => `${n} ${statusWords(s).label.toLowerCase()}`)
    .join(" · ");
}

export type Tone = "success" | "warning" | "danger" | "info" | "brand" | "neutral";

/** A post's status in plain words. */
export function statusWords(status: string): { tone: Tone; label: string } {
  switch (status) {
    case "published":
      return { tone: "success", label: "Posted" };
    case "publishing":
      return { tone: "brand", label: "Posting" };
    case "assist":
      return { tone: "warning", label: "You post it" };
    case "failed":
      return { tone: "danger", label: "Failed" };
    case "draft":
      return { tone: "neutral", label: "Waiting for your OK" };
    case "cancelled":
      return { tone: "neutral", label: "Cancelled" };
    default:
      return { tone: "info", label: "Scheduled" };
  }
}
