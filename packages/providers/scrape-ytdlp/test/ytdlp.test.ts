import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, silentLogger } from "@attentionos/core";
import { create, entryToExternalPost, parseJsonLines, profileUrl, type ExecFn } from "../src/index.ts";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const base = { secret: () => undefined, config: parseConfig({}), log: silentLogger };

function fakeExec(result: { code: number; stdout?: string; stderr?: string } | Error) {
  const calls: { bin: string; args: string[] }[] = [];
  const exec: ExecFn = async (bin, args) => {
    calls.push({ bin, args });
    if (result instanceof Error) throw result;
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { exec, calls };
}

describe("parsing", () => {
  it("reads JSON lines and skips progress and broken lines", () => {
    expect(parseJsonLines(fx("tiktok-profile.jsonl"))).toHaveLength(2);
  });
  it("maps entries to external posts", () => {
    const [a, b] = parseJsonLines(fx("tiktok-profile.jsonl")).map((e) => entryToExternalPost(e, "tiktok", "@demo_creator_b"));
    expect(a).toMatchObject({ platform: "tiktok", platformPostId: "7430000000000000001", views: 210000, likes: 15400, comments: 310, shares: 420, durationS: 38, authorHandle: "demo_creator_b" });
    expect(a!.publishedAt).toBe(new Date(1791200000 * 1000).toISOString());
    expect(b).toMatchObject({ publishedAt: "2026-09-20T00:00:00.000Z", durationS: 9 });
    expect(b!.likes).toBeUndefined();
    const [y] = parseJsonLines(fx("youtube-shorts.jsonl")).map((e) => entryToExternalPost(e, "youtube", "demo_creator_c"));
    expect(y!.caption).toBe("Tile layout in 40 seconds\n\nFull video on the channel.");
    expect(entryToExternalPost({ id: "x" }, "tiktok", "a")).toBeNull();
  });
  it("builds profile URLs", () => {
    expect(profileUrl("@a", "tiktok")).toBe("https://www.tiktok.com/@a");
    expect(profileUrl("a", "youtube")).toBe("https://www.youtube.com/@a/shorts");
    expect(() => profileUrl("a", "instagram")).toThrow(/only set up/);
  });
});

describe("yt-dlp scraper contract", () => {
  it("lists posts with safe arguments (no shell)", async () => {
    const { exec, calls } = fakeExec({ code: 1, stdout: fx("tiktok-profile.jsonl"), stderr: "ERROR: one video failed" });
    const s = create({ ...base, exec });
    const posts = await s.listCreatorPosts("demo_creator_b", "tiktok", { limit: 5, since: "2026-09-01T00:00:00.000Z" });
    expect(posts.map((p) => p.platformPostId)).toEqual(["7430000000000000001", "7430000000000000002"]);
    expect(calls[0]!.bin).toBe("yt-dlp");
    expect(calls[0]!.args).toEqual(["-j", "--skip-download", "--no-warnings", "--ignore-errors", "--playlist-end", "5", "--dateafter", "20260901", "https://www.tiktok.com/@demo_creator_b"]);
    expect(await s.estimateCostUsd([])).toBe(0);
  });
  it("explains how to install yt-dlp when the binary is missing", async () => {
    const enoent = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
    const s = create({ ...base, exec: fakeExec(enoent).exec });
    await expect(s.listCreatorPosts("a", "tiktok")).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("brew install yt-dlp") });
    const h = await s.health();
    expect(h).toMatchObject({ ok: false, detail: "yt-dlp is not installed" });
    expect(h.fix).toContain("uv tool install yt-dlp");
  });
  it("maps yt-dlp errors when nothing came back", async () => {
    const s = create({ ...base, exec: fakeExec({ code: 1, stderr: "ERROR: [TikTok] demo: HTTP Error 404: Not Found" }).exec });
    await expect(s.listCreatorPosts("a", "tiktok")).rejects.toMatchObject({ code: "not_found" });
  });
  it("downloads media and returns the final path", async () => {
    const dest = join(tmpdir(), "aos-ytdlp-test");
    const { exec, calls } = fakeExec({ code: 0, stdout: `${dest}/7430000000000000001.mp4\n` });
    const s = create({ ...base, secret: (k: string) => (k === "YTDLP_PATH" ? "/opt/bin/yt-dlp" : undefined), exec });
    const r = await s.downloadMedia({ platform: "tiktok", platformPostId: "1", authorHandle: "a", url: "https://www.tiktok.com/@a/video/1", publishedAt: "2026-10-01T00:00:00Z" }, `${dest}/`);
    expect(r.localPath).toBe(`${dest}/7430000000000000001.mp4`);
    expect(calls[0]!.bin).toBe("/opt/bin/yt-dlp");
    expect(calls[0]!.args).toContain(`${dest}/%(id)s.%(ext)s`);
    expect(calls[0]!.args.at(-1)).toBe("https://www.tiktok.com/@a/video/1");
  });
  it("reports the version in health", async () => {
    const s = create({ ...base, exec: fakeExec({ code: 0, stdout: "2026.09.30\n" }).exec });
    expect(await s.health()).toEqual({ ok: true, detail: "yt-dlp 2026.09.30 is installed" });
  });
});
