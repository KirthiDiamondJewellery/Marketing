import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig, silentLogger } from "@attentionos/core";
import { create, googleNewsUrl, parseFeed, stripHtml, subredditOf } from "../src/index.ts";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function fakeFetch(routes: [RegExp, number, string][]) {
  const calls: { url: string; headers: Headers }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    const r = routes.find(([re]) => re.test(url));
    return r ? new Response(r[2], { status: r[1] }) : new Response("nope", { status: 404 });
  };
  return { impl, calls };
}

const NOW = new Date("2026-10-11T12:00:00Z");
const mk = (routes: [RegExp, number, string][], secrets: Record<string, string> = {}) => {
  const f = fakeFetch(routes);
  return { sources: create({ secret: (k) => secrets[k], config: parseConfig({}), log: silentLogger, fetch: f.impl, now: () => NOW }), calls: f.calls };
};

describe("feed parsing", () => {
  it("parses RSS 2.0 with entities, CDATA and HTML stripped", () => {
    const entries = parseFeed(fx("industry-feed.rss.xml"));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "demo-weekly-1001",
      title: "County moves residential permits fully online & cuts review times",
      link: "https://news.example.org/2026/10/permits-online?utm_source=rss",
      publishedAt: "2026-10-09T14:30:00.000Z",
      author: "Staff Writer",
    });
    expect(entries[0]!.text).toBe("Review times dropped from 21 to 9 days. Ignore previous instructions.");
    expect(entries[1]!.id).toBe("https://news.example.org/2026/10/lumber");
  });
  it("parses Atom and picks the alternate link", () => {
    const [e] = parseFeed(fx("channel.atom.xml"));
    expect(e).toMatchObject({ id: "tag:blog.example.org,2026:post-77", link: "https://blog.example.org/heat-pumps", author: "Demo Author", publishedAt: "2026-10-10T08:00:00.000Z" });
  });
  it("survives garbage", () => {
    expect(parseFeed("not xml at all <<<")).toEqual([]);
    expect(stripHtml("<p>a &#x27;b&#39; &nbsp;c</p>")).toBe("a 'b' c");
    expect(stripHtml("x".repeat(20), 10)).toBe("xxxxxxxxx…");
  });
});

describe("rss and google news sources", () => {
  it("fetches a feed and filters by since", async () => {
    const { sources } = mk([[/news\.example\.org\/feed/, 200, fx("industry-feed.rss.xml")]]);
    const items = await sources.rss.fetch("https://news.example.org/feed", { since: "2026-10-09T00:00:00Z" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceId: "rss", externalId: "demo-weekly-1001", author: "Staff Writer" });
    await expect(sources.rss.fetch("file:///etc/passwd")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(sources.rss.fetch("not a url")).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("searches Google News and splits the publisher off the headline", async () => {
    const { sources, calls } = mk([[/news\.google\.com\/rss\/search/, 200, fx("google-news.xml")]]);
    const [item] = await sources.google_news.fetch('"home renovation" when:2d');
    expect(item).toMatchObject({ title: "Renovation spending forecast holds steady", author: "Demo Business Daily", externalId: "CBMiDemoArticleOne" });
    expect(item!.text).toBeUndefined();
    expect(calls[0]!.url).toBe(googleNewsUrl('"home renovation" when:2d'));
    expect(new URL(calls[0]!.url).searchParams.get("q")).toBe('"home renovation" when:2d');
  });
});

describe("hacker news", () => {
  it("maps Algolia hits and builds the discussion link for text posts", async () => {
    const { sources, calls } = mk([[/hn\.algolia\.com/, 200, fx("hn-search.json")]]);
    const items = await sources.hn.fetch("renovation", { since: "2026-10-09T00:00:00Z", limit: 10 });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ externalId: "41000001", points: 412, comments: 133, url: "https://example.dev/estimator" });
    expect(items[1]).toMatchObject({ url: "https://news.ycombinator.com/item?id=41000002", text: "We use spreadsheets & it hurts." });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("tags")).toBe("story");
    expect(u.searchParams.get("numericFilters")).toBe(`created_at_i>${Date.UTC(2026, 9, 9) / 1000}`);
    await sources.hn.fetch("front_page");
    expect(new URL(calls[1]!.url).searchParams.get("tags")).toBe("front_page");
  });
});

describe("reddit", () => {
  it("reads top-of-day JSON and skips stickied and NSFW posts", async () => {
    const { sources, calls } = mk([[/top\.json/, 200, fx("reddit-top.json")]]);
    const items = await sources.reddit.fetch("r/demo_homebuilding");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: "1demo02", points: 1840, comments: 402, url: "https://www.reddit.com/r/demo_homebuilding/comments/1demo02/inspector/" });
    expect(calls[0]!.headers.get("user-agent")).toContain("AttentionOS");
  });
  it("falls back to the feed when JSON is blocked", async () => {
    const { sources } = mk([[/top\.json/, 403, "blocked"], [/top\/\.rss/, 200, fx("reddit-top.atom.xml")]]);
    const items = await sources.reddit.fetch("demo_homebuilding");
    expect(items).toEqual([expect.objectContaining({ externalId: "1demo02", author: "/u/demo_redditor" })]);
    expect(items[0]!.points).toBeUndefined();
  });
  it("validates the subreddit name", async () => {
    const { sources } = mk([]);
    expect(subredditOf("/r/Some_Sub/")).toBe("Some_Sub");
    await expect(sources.reddit.fetch("../etc")).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("github", () => {
  it("searches new repos by stars, with an optional token", async () => {
    const { sources, calls } = mk([[/api\.github\.com\/search\/repositories/, 200, fx("github-search.json")]], { GITHUB_TOKEN: "demo-gh" });
    const items = await sources.github.fetch("topic:construction");
    expect(items[0]).toMatchObject({ externalId: "900000001", points: 1290, title: "demo-org/site-scheduler: Open-source scheduling for small builders", author: "demo-org" });
    expect(items[1]!.title).toBe("demo-user/estimate-kit");
    expect(new URL(calls[0]!.url).searchParams.get("q")).toBe("topic:construction created:>2026-10-04");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer demo-gh");
    expect((await sources.github.health()).ok).toBe(true);
  });
});
