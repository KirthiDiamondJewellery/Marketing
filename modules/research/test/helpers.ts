import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalPost, OwnAnalytics, Platform, PostMetricsSnapshot, Scraper, TrendItem, TrendSource } from "@attentionos/core";
import { DEMO_BRAND_DIR } from "../src/testing/db.ts";

/** A writable copy of the demo Brand Kit (tools edit competitors.yaml). */
export function tempBrandDir(): string {
  const root = mkdtempSync(join(tmpdir(), "aos-research-"));
  const dir = join(root, "brand");
  cpSync(DEMO_BRAND_DIR, dir, { recursive: true });
  return dir;
}

export const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

/** Fake scraper with per-handle posts, a fixed price, and Apify-style spend reporting. */
export function fakeScraper(posts: Record<string, ExternalPost[]>, opts: { id?: string; usdPerCreator?: number; failFor?: string[] } = {}) {
  const calls: string[] = [];
  const spend: { usd: number }[] = [];
  const scraper: Scraper & { drainSpend(): { usd: number }[] } = {
    id: opts.id ?? "fake",
    health: async () => ({ ok: true, detail: "ok" }),
    estimateCostUsd: async (handles) => handles.length * (opts.usdPerCreator ?? 0.05),
    async listCreatorPosts(handle: string, platform: Platform) {
      calls.push(`${platform}:${handle}`);
      if (opts.failFor?.includes(handle)) throw new Error("profile is private");
      spend.push({ usd: opts.usdPerCreator ?? 0.05 });
      return posts[handle] ?? [];
    },
    drainSpend: () => spend.splice(0, spend.length),
  };
  return { scraper, calls };
}

export function igPost(handle: string, id: string, publishedAt: string, m: { views?: number; comments?: number; likes?: number; durationS?: number; pinned?: boolean; caption?: string }): ExternalPost {
  return {
    platform: "instagram",
    platformPostId: id,
    authorHandle: handle,
    url: `https://www.instagram.com/reel/${id}/`,
    publishedAt,
    caption: m.caption ?? `post ${id}`,
    views: m.views ?? 10_000,
    comments: m.comments ?? 40,
    likes: m.likes ?? 500,
    durationS: m.durationS ?? 35,
    isPinned: m.pinned ?? false,
    videoUrl: `https://cdn.example.invalid/${id}.mp4`,
  };
}

export function fakeTrendSource(byTarget: Record<string, TrendItem[]>): TrendSource & { set(target: string, items: TrendItem[]): void } {
  const data = { ...byTarget };
  return {
    id: "fake",
    health: async () => ({ ok: true, detail: "ok" }),
    fetch: async (target) => data[target] ?? [],
    set(target, items) {
      data[target] = items;
    },
  };
}

export function fakeAnalytics(snaps: PostMetricsSnapshot[], id = "fake-analytics"): OwnAnalytics & { set(s: PostMetricsSnapshot[]): void } {
  let data = snaps;
  return {
    id,
    health: async () => ({ ok: true, detail: "ok" }),
    listPostMetrics: async (_account, o) => data.filter((s) => !o?.since || !s.publishedAt || s.publishedAt >= o.since),
    set(s) {
      data = s;
    },
  };
}
