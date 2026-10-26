import { describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns";
import { isPublicAddress, publicLookup } from "../src/lib/public-http.ts";
import { isPublicHttpUrl, readSite } from "../src/lib/web.ts";

vi.mock("node:dns", () => ({ lookup: vi.fn() }));

describe("public website network boundary", () => {
  it("rejects private, mapped, link-local and reserved addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.100.100.200", "192.168.1.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "fc00::1", "2002:7f00:1::", "0.0.0.0"]) expect(isPublicAddress(address), address).toBe(false);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(address), address).toBe(true);
    for (const url of ["http://2130706433", "http://0x7f000001", "http://[::ffff:127.0.0.1]", "https://user:password@example.com"]) expect(isPublicHttpUrl(url), url).toBe(false);
  });

  it("rejects DNS answers containing any private address at socket lookup time", () => {
    vi.mocked(lookup).mockImplementation(((_host: unknown, _opts: unknown, callback: Function) => callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }])) as typeof lookup);
    const callback = vi.fn();
    publicLookup("attacker.example", { all: true }, callback);
    expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("returns the validated DNS result directly to the connection", () => {
    const answers = [{ address: "8.8.8.8", family: 4 }];
    vi.mocked(lookup).mockImplementation(((_host: unknown, _opts: unknown, callback: Function) => callback(null, answers)) as typeof lookup);
    const callback = vi.fn();
    publicLookup("public.example", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, answers);
  });

  it("never fetches a private redirect target", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    const result = await readSite(["https://public.example"], { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.pages).toEqual([]);
    expect(result.problems[0]).toContain("Not a public HTTP address");
  });

  it("limits redirect loops and follows public relative redirects", async () => {
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/again" } }));
    expect((await readSite(["https://public.example"], { fetch: loop })).problems[0]).toContain("Too many redirects");
    expect(loop).toHaveBeenCalledTimes(5);
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/about" } })).mockResolvedValueOnce(new Response("<p>Our business</p>"));
    expect((await readSite(["https://public.example"], { fetch })).pages[0]?.url).toBe("https://public.example/about");
  });
});
