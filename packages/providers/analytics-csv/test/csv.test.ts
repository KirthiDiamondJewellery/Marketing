import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig, silentLogger } from "@attentionos/core";
import { create, idFromUrl, isFollowerCsv, parseAnalyticsCsv, parseCsv, parseFollowersCsv, parseRetentionCurve } from "../src/index.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("CSV parsing", () => {
  it("handles quotes, doubled quotes, CRLF and embedded delimiters", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
    expect(parseCsv('a;b\n1;2')).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('a,b\n"multi\nline",2')).toEqual([["a", "b"], ["multi\nline", "2"]]);
  });

  it("maps documented columns and aliases to snapshots", () => {
    const { snapshots, issues } = parseAnalyticsCsv(readFileSync(fixture("instagram-export.csv"), "utf8"), { capturedAt: "2026-10-11T00:00:00.000Z" });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual({
      platformPostId: "18000000000000011", platform: "instagram", capturedAt: "2026-10-11T00:00:00.000Z",
      url: "https://www.instagram.com/reel/QfOwn11/", publishedAt: "2026-10-09T13:00:00.000Z", caption: 'Why we never quote from photos, "ever"',
      durationS: 38, views: 15400, reach: 11020, likes: 310, comments: 64, shares: 97, saves: 212, follows: 18, avgWatchTimeS: 9.1,
      skipRate: 0.41, completionRate: 0.22, raw: { source: "csv", line: 2 },
    });
    // id derived from the URL, platform defaulted, percent-style rate read as a share, empty cells unknown
    expect(snapshots[1]).toMatchObject({ platformPostId: "QfOwn14", platform: "instagram", skipRate: 0.55, completionRate: 0.18, durationS: 29 });
    expect(snapshots[1]!.reach).toBeUndefined();
    expect(issues).toEqual([{ line: 4, problem: "no post id or url" }, { line: 5, problem: 'unknown platform "myspace"' }]);
  });

  it("rejects files without an id column and filters by account", () => {
    expect(parseAnalyticsCsv("views\n1", { capturedAt: "x" }).issues[0]!.problem).toContain("post_id or url");
    expect(parseAnalyticsCsv("", { capturedAt: "x" }).issues[0]!.problem).toBe("the file is empty");
    const t = readFileSync(fixture("tiktok-semicolon.csv"), "utf8");
    const { snapshots } = parseAnalyticsCsv(t, { capturedAt: "2026-10-11T00:00:00.000Z", accountId: "acct-b" });
    expect(snapshots.map((s) => s.platformPostId)).toEqual(["7430000000000000001"]);
    expect(snapshots[0]!.skipRate).toBeUndefined();
    expect(parseAnalyticsCsv(t, { capturedAt: "x", accountId: "*" }).snapshots[1]!.skipRate).toBe(0.12);
  });

  it("idFromUrl", () => {
    expect(idFromUrl("https://www.instagram.com/reel/AbC/")).toBe("AbC");
    expect(idFromUrl("nope")).toBeUndefined();
  });
});

describe("OwnAnalytics contract", () => {
  it("reads every CSV in the import folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-csv-"));
    copyFileSync(fixture("instagram-export.csv"), join(dir, "a.csv"));
    copyFileSync(fixture("tiktok-semicolon.csv"), join(dir, "b.CSV"));
    const a = create({ secret: (k) => (k === "ANALYTICS_CSV_DIR" ? dir : undefined), config: parseConfig({}), log: silentLogger });
    const all = await a.listPostMetrics("*");
    expect(all).toHaveLength(4);
    expect(all.map((s) => s.platformPostId)).toContain("18000000000000011");
    expect(await a.listPostMetrics("*", { since: "2026-10-05T00:00:00Z" })).toHaveLength(3);
    expect((await a.health()).detail).toBe("2 CSV exports ready to import");
  });
  it("explains a missing folder", async () => {
    const a = create({ secret: () => undefined, config: parseConfig({}), log: silentLogger, cwd: "/nonexistent-aos" });
    expect(await a.health()).toMatchObject({ ok: false });
    await expect(a.listPostMetrics("*")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("retention curves, clicks and follower history", () => {
  it("reads a curve cell with a step and puts extras under raw.aos", () => {
    const { snapshots } = parseAnalyticsCsv(readFileSync(fixture("retention.csv"), "utf8"), { capturedAt: "2026-10-11T00:00:00.000Z" });
    expect(snapshots[0]!.skipRate).toBe(0.38);
    expect(snapshots[0]!.raw).toEqual({
      source: "csv", line: 2,
      aos: { clicks: 12, impressions: 1400, retention: [{ t: 0, pct: 100 }, { t: 1.5, pct: 78 }, { t: 3, pct: 61 }, { t: 4.5, pct: 50 }, { t: 6, pct: 44 }] },
    });
    expect(snapshots[1]!.raw).toEqual({ source: "csv", line: 3 });
  });

  it("reads one column per retention point", () => {
    const { snapshots } = parseAnalyticsCsv(readFileSync(fixture("retention-points.csv"), "utf8"), { capturedAt: "x" });
    expect((snapshots[0]!.raw as { aos: unknown }).aos).toEqual({ retention: [{ t: 0, pct: 100 }, { t: 3, pct: 62 }, { t: 10, pct: 41 }] });
  });

  it("parses curves in either scale and rejects single points", () => {
    expect(parseRetentionCurve("1 0.5")).toEqual([{ t: 0, pct: 100 }, { t: 1, pct: 50 }]);
    expect(parseRetentionCurve("100")).toBeUndefined();
    expect(parseRetentionCurve("")).toBeUndefined();
  });

  it("detects and parses follower history", () => {
    const text = readFileSync(fixture("followers.csv"), "utf8");
    expect(isFollowerCsv(text)).toBe(true);
    expect(isFollowerCsv("post_id,followers\n1,2")).toBe(false);
    const { stats, issues } = parseFollowersCsv(text, { capturedAt: "2026-10-11T00:00:00.000Z" });
    expect(stats).toEqual([
      { day: "2026-10-01", followers: 1204, following: 310, posts: 88, platform: "instagram", capturedAt: "2026-10-11T00:00:00.000Z" },
      { day: "2026-10-02", followers: 1219, following: 311, posts: 89, platform: "instagram", capturedAt: "2026-10-11T00:00:00.000Z" },
    ]);
    expect(issues).toEqual([{ line: 4, problem: "no follower count" }]);
    expect(parseFollowersCsv("followers\n1", { capturedAt: "x" }).issues[0]!.problem).toMatch(/date and followers/);
  });

  it("keeps follower files out of post metrics and serves them as account stats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aos-csv-"));
    copyFileSync(fixture("instagram-export.csv"), join(dir, "a.csv"));
    copyFileSync(fixture("followers.csv"), join(dir, "followers-oct.csv"));
    mkdirSync(join(dir, "followers"));
    writeFileSync(join(dir, "followers", "older.csv"), "day,followers\n2026-09-30,1190\n");
    const a = create({ secret: (k) => (k === "ANALYTICS_CSV_DIR" ? dir : undefined), config: parseConfig({}), log: silentLogger });
    expect(await a.listPostMetrics("*")).toHaveLength(2);
    const stats = await a.listAccountStats("*");
    expect(stats.map((s) => [s.day, s.followers])).toEqual([["2026-09-30", 1190], ["2026-10-01", 1204], ["2026-10-02", 1219]]);
    expect(await a.listAccountStats("*", { since: "2026-10-02T00:00:00Z" })).toHaveLength(1);
  });
});
