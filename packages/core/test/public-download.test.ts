import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:http", () => ({ request }));
vi.mock("node:https", () => ({ request }));
import { downloadPublicFile, publicLookup } from "../src/public-http.ts";

const dirs: string[] = [];
afterEach(async () => { request.mockReset(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function destination() { const dir = await mkdtemp(join(tmpdir(), "aos-download-")); dirs.push(dir); return join(dir, "media.mp4"); }
function reply(status: number, headers: Record<string, string | undefined>, body: string) {
  request.mockImplementationOnce((_url, options, callback) => {
    expect(options.lookup).toBe(publicLookup);
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: status, headers });
      callback(response);
      queueMicrotask(() => response.end(body));
    };
    return req;
  });
}
describe("public media downloads", () => {
  it("streams successful content and removes the temporary file", async () => {
    const dest = await destination(); reply(200, {}, "video");
    await downloadPublicFile("https://cdn.example/video", dest, { signal: new AbortController().signal, maxBytes: 5 });
    expect(await readFile(dest, "utf8")).toBe("video");
    expect(await readdir(dirs[0]!)).toEqual(["media.mp4"]);
  });
  it.each([{}, { "content-length": "1" }])("enforces actual bytes and preserves an existing destination", async (headers) => {
    const dest = await destination(); await writeFile(dest, "original"); reply(200, headers, "too much data");
    await expect(downloadPublicFile("https://cdn.example/video", dest, { signal: new AbortController().signal, maxBytes: 5 })).rejects.toThrow("limit");
    expect(await readFile(dest, "utf8")).toBe("original");
    expect(await readdir(dirs[0]!)).toEqual(["media.mp4"]);
  });
  it("rejects a redirect to metadata before connecting", async () => {
    const dest = await destination(); reply(302, { location: "http://169.254.169.254/latest/meta-data" }, "");
    await expect(downloadPublicFile("https://cdn.example/video", dest, { signal: new AbortController().signal, maxBytes: 5 })).rejects.toThrow("public");
    expect(request).toHaveBeenCalledTimes(1);
    expect(await readdir(dirs[0]!)).toEqual([]);
  });
  it("follows public redirects and rejects private literals without a request", async () => {
    const dest = await destination(); reply(302, { location: "/next" }, ""); reply(200, {}, "ok");
    await downloadPublicFile("https://cdn.example/video", dest, { signal: new AbortController().signal, maxBytes: 5 });
    expect(request).toHaveBeenCalledTimes(2);
    await expect(downloadPublicFile("http://[::ffff:127.0.0.1]/", dest, { signal: new AbortController().signal, maxBytes: 5 })).rejects.toThrow("public");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("bounds redirect loops", async () => {
    const dest = await destination();
    for (let i = 0; i < 5; i++) reply(302, { location: "/again" }, "");
    await expect(downloadPublicFile("https://cdn.example/video", dest, { signal: new AbortController().signal, maxBytes: 5 })).rejects.toThrow("redirects");
    expect(request).toHaveBeenCalledTimes(5);
    expect(await readdir(dirs[0]!)).toEqual([]);
  });
  it("cancels an unfinished response on timeout and removes partial output", async () => {
    const dest = await destination();
    let response: PassThrough;
    request.mockImplementationOnce((_url, _options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end(): void };
      req.end = () => {
        response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
        callback(response);
        response.write("x");
      };
      return req;
    });
    await expect(downloadPublicFile("https://cdn.example/video", dest, { signal: new AbortController().signal, maxBytes: 5, timeoutMs: 20 })).rejects.toThrow();
    expect(response!.destroyed).toBe(true);
    expect(await readdir(dirs[0]!)).toEqual([]);
  });
});
