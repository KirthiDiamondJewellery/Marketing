import { z } from "zod";
import {
  ProviderError,
  type AttentionOSConfig, type Logger, type ProviderHealth, type TrendItem, type TrendSource,
} from "@attentionos/core";
import { requestJson, type FetchLike } from "@attentionos/provider-shared";
import { parseFeed, stripHtml, type FeedEntry } from "./feed.ts";

export { parseFeed, stripHtml } from "./feed.ts";

/**
 * Trend sources on the open web. One package, five TrendSources keyed by the `kind` used in
 * `brand/sources.yaml`. None needs an account. `target` means:
 *
 * - rss:         a feed URL (RSS 2.0, RSS 1.0 or Atom), e.g. an industry publication or a YouTube channel feed.
 * - google_news: a search query → https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en
 *                (append ` when:2d` to the query to restrict recency on Google's side).
 * - hn:          "front_page", or a search query → Algolia HN Search API https://hn.algolia.com/api/v1/search
 * - reddit:      a subreddit name → https://www.reddit.com/r/<sub>/top.json?t=day (falls back to the
 *                Atom feed /top/.rss when the JSON endpoint is blocked; items then come back in rank order).
 * - github:      a repository search query (e.g. "topic:home-automation") → https://api.github.com/search/repositories
 *                limited to repos created in the last 7 days, sorted by stars. Optional GITHUB_TOKEN raises the
 *                rate limit from 10 to 30 searches/minute.
 *
 * Every `text` field is UNTRUSTED: only tool-less LLM calls with output validators may read it.
 * Items come back in the source's own ranking order (the radar uses the index as rank when no counters exist).
 */

export const TREND_KINDS = ["rss", "google_news", "hn", "reddit", "github"] as const;
export type WebTrendKind = (typeof TREND_KINDS)[number];

const USER_AGENT = "AttentionOS-trend-radar/0.1 (+https://github.com/evanbaker315/AttentionOS)";

type Opts = { secret(name: string): string | undefined; config: AttentionOSConfig; log: Logger; fetch?: FetchLike; now?: () => Date };

const sinceFilter = (since?: string) => (i: TrendItem) => !since || i.publishedAt >= since;

async function getText(fetchImpl: FetchLike, provider: string, url: string, headers: Record<string, string> = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", ...headers }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new ProviderError(provider, "upstream", `network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const code = res.status === 404 ? "not_found" : res.status === 429 ? "rate_limited" : res.status === 401 || res.status === 403 ? "auth" : res.status >= 500 ? "upstream" : "invalid_request";
    throw new ProviderError(provider, code, `HTTP ${res.status} from ${new URL(url).hostname}`, { status: res.status });
  }
  return res.text();
}

const health = (detail: string): (() => Promise<ProviderHealth>) => async () => ({ ok: true, detail });

export function feedEntryToItem(e: FeedEntry, sourceId: string, fallbackDate: string): TrendItem {
  return {
    sourceId,
    externalId: e.id,
    title: e.title,
    url: e.link,
    publishedAt: e.publishedAt ?? fallbackDate,
    ...(e.author ?? e.source ? { author: e.author ?? e.source } : {}),
    ...(e.text ? { text: e.text } : {}),
  };
}

export function createRss(opts: Opts): TrendSource {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? (() => new Date());
  return {
    id: "rss",
    health: health("RSS and Atom feeds need no account"),
    async fetch(target, o) {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        throw new ProviderError("rss", "invalid_request", `"${target}" is not a feed URL`);
      }
      if (!/^https?:$/.test(url.protocol)) throw new ProviderError("rss", "invalid_request", "feeds must be http(s) URLs");
      const xml = await getText(fetchImpl, "rss", url.toString());
      return parseFeed(xml).map((e) => feedEntryToItem(e, "rss", now().toISOString())).filter(sinceFilter(o?.since)).slice(0, o?.limit ?? 50);
    },
  };
}

export function googleNewsUrl(query: string, locale = { hl: "en-US", gl: "US", ceid: "US:en" }): string {
  return `https://news.google.com/rss/search?${new URLSearchParams({ q: query, ...locale })}`;
}

export function createGoogleNews(opts: Opts): TrendSource {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? (() => new Date());
  return {
    id: "google_news",
    health: health("Google News search feeds need no account"),
    async fetch(target, o) {
      const xml = await getText(fetchImpl, "google_news", googleNewsUrl(target));
      return parseFeed(xml)
        .map((e) => {
          // Google News titles end with " - Publisher"; keep the headline clean and the publisher as author.
          const title = e.source && e.title.endsWith(` - ${e.source}`) ? e.title.slice(0, -(e.source.length + 3)) : e.title;
          return feedEntryToItem({ ...e, title, text: undefined }, "google_news", now().toISOString());
        })
        .filter(sinceFilter(o?.since))
        .slice(0, o?.limit ?? 30);
    },
  };
}

const hnHitSchema = z.object({
  objectID: z.string(),
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  points: z.number().nullable().optional(),
  num_comments: z.number().nullable().optional(),
  created_at: z.string(),
  story_text: z.string().nullable().optional(),
});
const hnResponseSchema = z.object({ hits: z.array(z.unknown()) });

export function createHackerNews(opts: Opts): TrendSource {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  return {
    id: "hn",
    health: health("Hacker News search needs no account"),
    async fetch(target, o) {
      const limit = String(o?.limit ?? 30);
      const params = new URLSearchParams({ hitsPerPage: limit });
      if (target.trim() === "" || target === "front_page") params.set("tags", "front_page");
      else {
        params.set("query", target);
        params.set("tags", "story");
      }
      if (o?.since) params.set("numericFilters", `created_at_i>${Math.floor(new Date(o.since).getTime() / 1000)}`);
      const body = hnResponseSchema.parse(await requestJson(fetchImpl, `https://hn.algolia.com/api/v1/search?${params}`, { provider: "hn", timeoutMs: 20_000 }));
      const items: TrendItem[] = [];
      for (const raw of body.hits) {
        const h = hnHitSchema.safeParse(raw);
        if (!h.success || !h.data.title) continue;
        const text = stripHtml(h.data.story_text);
        items.push({
          sourceId: "hn",
          externalId: h.data.objectID,
          title: h.data.title,
          url: h.data.url || `https://news.ycombinator.com/item?id=${h.data.objectID}`,
          publishedAt: new Date(h.data.created_at).toISOString(),
          ...(h.data.author ? { author: h.data.author } : {}),
          ...(typeof h.data.points === "number" ? { points: h.data.points } : {}),
          ...(typeof h.data.num_comments === "number" ? { comments: h.data.num_comments } : {}),
          ...(text ? { text } : {}),
        });
      }
      return items;
    },
  };
}

const redditPostSchema = z.object({
  id: z.string(),
  title: z.string(),
  permalink: z.string(),
  author: z.string().optional(),
  score: z.number().optional(),
  num_comments: z.number().optional(),
  created_utc: z.number(),
  selftext: z.string().optional(),
  stickied: z.boolean().optional(),
  over_18: z.boolean().optional(),
});
const redditListingSchema = z.object({ data: z.object({ children: z.array(z.object({ data: z.unknown() })) }) });

export const subredditOf = (target: string) => target.trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");

export function createReddit(opts: Opts): TrendSource {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? (() => new Date());
  return {
    id: "reddit",
    health: health("Reddit public listings need no account"),
    async fetch(target, o) {
      const sub = subredditOf(target);
      if (!/^\w{2,21}$/.test(sub)) throw new ProviderError("reddit", "invalid_request", `"${target}" is not a subreddit name`);
      const limit = o?.limit ?? 25;
      try {
        const body = redditListingSchema.parse(await requestJson(fetchImpl, `https://www.reddit.com/r/${sub}/top.json?t=day&limit=${limit}&raw_json=1`, {
          provider: "reddit", headers: { "User-Agent": USER_AGENT }, timeoutMs: 20_000,
        }));
        const items: TrendItem[] = [];
        for (const child of body.data.children) {
          const p = redditPostSchema.safeParse(child.data);
          if (!p.success || p.data.stickied || p.data.over_18) continue;
          const text = stripHtml(p.data.selftext);
          items.push({
            sourceId: "reddit",
            externalId: p.data.id,
            title: p.data.title,
            url: `https://www.reddit.com${p.data.permalink}`,
            publishedAt: new Date(p.data.created_utc * 1000).toISOString(),
            ...(p.data.author ? { author: p.data.author } : {}),
            ...(typeof p.data.score === "number" ? { points: p.data.score } : {}),
            ...(typeof p.data.num_comments === "number" ? { comments: p.data.num_comments } : {}),
            ...(text ? { text } : {}),
          });
        }
        return items.filter(sinceFilter(o?.since));
      } catch (err) {
        // The JSON API is often blocked for anonymous clients; the Atom feed still works (no scores).
        if (!(err instanceof ProviderError) || !["auth", "rate_limited", "upstream"].includes(err.code)) throw err;
        opts.log.debug("reddit JSON blocked, using the feed", { sub, code: err.code });
        const xml = await getText(fetchImpl, "reddit", `https://www.reddit.com/r/${sub}/top/.rss?t=day&limit=${limit}`);
        return parseFeed(xml)
          .map((e) => feedEntryToItem({ ...e, id: e.id.replace(/^t3_/, "") }, "reddit", now().toISOString()))
          .filter(sinceFilter(o?.since));
      }
    },
  };
}

const ghRepoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  html_url: z.string(),
  description: z.string().nullable().optional(),
  stargazers_count: z.number(),
  forks_count: z.number().optional(),
  created_at: z.string(),
  owner: z.object({ login: z.string() }).optional(),
});
const ghSearchSchema = z.object({ items: z.array(z.unknown()) });

export function createGithub(opts: Opts): TrendSource {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? (() => new Date());
  return {
    id: "github",
    async health() {
      return opts.secret("GITHUB_TOKEN")
        ? { ok: true, detail: "GitHub search with your token" }
        : { ok: true, detail: "GitHub search works without a token (lower rate limit)", fix: "Optional: add GITHUB_TOKEN to .env for a higher search limit" };
    },
    async fetch(target, o) {
      const since = (o?.since ? new Date(o.since) : new Date(now().getTime() - 7 * 86_400_000)).toISOString().slice(0, 10);
      const q = `${target.trim()} created:>${since}`.trim();
      const params = new URLSearchParams({ q, sort: "stars", order: "desc", per_page: String(o?.limit ?? 25) });
      const token = opts.secret("GITHUB_TOKEN");
      const body = ghSearchSchema.parse(await requestJson(fetchImpl, `https://api.github.com/search/repositories?${params}`, {
        provider: "github",
        timeoutMs: 20_000,
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }));
      const items: TrendItem[] = [];
      for (const raw of body.items) {
        const r = ghRepoSchema.safeParse(raw);
        if (!r.success) continue;
        items.push({
          sourceId: "github",
          externalId: String(r.data.id),
          title: r.data.description ? `${r.data.full_name}: ${r.data.description}` : r.data.full_name,
          url: r.data.html_url,
          publishedAt: new Date(r.data.created_at).toISOString(),
          ...(r.data.owner ? { author: r.data.owner.login } : {}),
          points: r.data.stargazers_count,
          ...(r.data.description ? { text: r.data.description.slice(0, 1000) } : {}),
        });
      }
      return items;
    },
  };
}

/** All five sources, keyed by the `kind` used in `brand/sources.yaml`. */
export function create(opts: Opts): Record<WebTrendKind, TrendSource> {
  return {
    rss: createRss(opts),
    google_news: createGoogleNews(opts),
    hn: createHackerNews(opts),
    reddit: createReddit(opts),
    github: createGithub(opts),
  };
}
