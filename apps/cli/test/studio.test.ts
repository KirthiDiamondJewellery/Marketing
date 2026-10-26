import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyHost, decideBind, ensureStudioToken, isLoopback, parseStudioAuthMode, parseTailscaleStatus, studioUrls } from "../src/commands/studio.ts";
import { defaultUpHost } from "../src/commands/up.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "tailscale", name), "utf8");
const TOKEN = "a".repeat(43);

describe("addresses", () => {
  it("classifies loopback, wildcard, tailnet, private and public addresses", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(classifyHost(h)).toBe("loopback");
    for (const h of ["0.0.0.0", "::", ""]) expect(classifyHost(h)).toBe("wildcard");
    for (const h of ["100.64.0.1", "100.101.102.103", "100.127.255.254", "fd7a:115c:a1e0::1", "studio-vps.example-tailnet.ts.net"]) expect(classifyHost(h)).toBe("tailscale");
    for (const h of ["10.0.0.5", "172.16.4.1", "172.31.0.1", "192.168.1.20", "fd12:3456::1"]) expect(classifyHost(h)).toBe("private");
    for (const h of ["169.254.1.1", "fe80::1"]) expect(classifyHost(h)).toBe("link-local");
    for (const h of ["8.8.8.8", "100.63.0.1", "100.128.0.1", "172.32.0.1", "2001:db8::1", "studio.example.com"]) expect(classifyHost(h)).toBe("public");
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("100.101.102.103")).toBe(false);
  });
});

describe("bind rules", () => {
  it("needs no sign-in on loopback unless forced", () => {
    expect(decideBind({ host: "127.0.0.1", allowPublic: false })).toEqual({ ok: true, auth: "none", kind: "loopback" });
    expect(decideBind({ host: "127.0.0.1", allowPublic: false, forceAuth: true })).toMatchObject({ ok: false });
    expect(decideBind({ host: "127.0.0.1", allowPublic: false, forceAuth: true, token: TOKEN })).toMatchObject({ ok: true, auth: "token" });
  });

  it("requires an access key on a tailnet or private network", () => {
    expect(decideBind({ host: "100.101.102.103", allowPublic: false })).toMatchObject({ ok: false, message: expect.stringContaining("access key") });
    expect(decideBind({ host: "100.101.102.103", allowPublic: false, token: TOKEN })).toEqual({ ok: true, auth: "token", kind: "tailscale" });
    expect(decideBind({ host: "192.168.1.20", allowPublic: false, token: TOKEN })).toMatchObject({ ok: true, auth: "token" });
    expect(decideBind({ host: "192.168.1.20", allowPublic: false, token: "short" })).toMatchObject({ ok: false, message: expect.stringContaining("too short") });
  });

  it("refuses 0.0.0.0 and public addresses without --allow-public and a key", () => {
    expect(decideBind({ host: "0.0.0.0", allowPublic: false, token: TOKEN })).toMatchObject({ ok: false, fix: expect.stringContaining("--allow-public") });
    expect(decideBind({ host: "203.0.113.7", allowPublic: false, token: TOKEN })).toMatchObject({ ok: false });
    expect(decideBind({ host: "0.0.0.0", allowPublic: true })).toMatchObject({ ok: false, message: expect.stringContaining("access key") });
    expect(decideBind({ host: "0.0.0.0", allowPublic: true, token: TOKEN })).toEqual({ ok: true, auth: "token", kind: "wildcard" });
    expect(decideBind({ host: "203.0.113.7", allowPublic: true, token: TOKEN })).toMatchObject({ ok: true, auth: "token" });
  });
});

describe("auth modes (ATTENTIONOS_STUDIO_AUTH)", () => {
  it("reads local, tailscale and token, and rejects anything else", () => {
    expect(parseStudioAuthMode(undefined)).toBeUndefined();
    expect(parseStudioAuthMode("  ")).toBeUndefined();
    expect(parseStudioAuthMode("local")).toBe("local");
    expect(parseStudioAuthMode("none")).toBe("local");
    expect(parseStudioAuthMode("Tailscale")).toBe("tailscale");
    expect(parseStudioAuthMode("token")).toBe("token");
    expect(() => parseStudioAuthMode("off")).toThrow(/ATTENTIONOS_STUDIO_AUTH/);
  });

  it("local: no sign-in on loopback, or on 0.0.0.0 only inside the container", () => {
    expect(decideBind({ host: "127.0.0.1", allowPublic: false, mode: "local" })).toEqual({ ok: true, auth: "none", kind: "loopback" });
    expect(decideBind({ host: "0.0.0.0", allowPublic: true, mode: "local", container: true })).toEqual({ ok: true, auth: "none", kind: "wildcard" });
    // Outside the container 0.0.0.0 could be any network: refuse, even with a key.
    expect(decideBind({ host: "0.0.0.0", allowPublic: true, mode: "local", token: TOKEN })).toMatchObject({ ok: false, message: expect.stringContaining("127.0.0.1") });
    // The container still needs --allow-public for 0.0.0.0.
    expect(decideBind({ host: "0.0.0.0", allowPublic: false, mode: "local", container: true })).toMatchObject({ ok: false, fix: expect.stringContaining("--allow-public") });
    expect(decideBind({ host: "100.101.102.103", allowPublic: false, mode: "local", container: true, token: TOKEN })).toMatchObject({ ok: false });
    expect(decideBind({ host: "203.0.113.7", allowPublic: true, mode: "local", container: true, token: TOKEN })).toMatchObject({ ok: false });
  });

  it("tailscale: trusts Tailscale identity only on loopback, with an access key as the fallback", () => {
    expect(decideBind({ host: "127.0.0.1", allowPublic: false, mode: "tailscale", token: TOKEN })).toEqual({ ok: true, auth: "token", kind: "loopback", trustTailscale: true });
    expect(decideBind({ host: "127.0.0.1", allowPublic: false, mode: "tailscale" })).toMatchObject({ ok: false, message: expect.stringContaining("access key") });
    expect(decideBind({ host: "127.0.0.1", allowPublic: false, mode: "tailscale", token: "short" })).toMatchObject({ ok: false, message: expect.stringContaining("too short") });
    // A tailnet device could reach 0.0.0.0 or the Tailscale address directly and forge the header.
    expect(decideBind({ host: "0.0.0.0", allowPublic: true, mode: "tailscale", container: true, token: TOKEN })).toMatchObject({ ok: false, fix: expect.stringContaining("--host 127.0.0.1") });
    expect(decideBind({ host: "100.101.102.103", allowPublic: false, mode: "tailscale", token: TOKEN })).toMatchObject({ ok: false });
  });

  it("token: the access key everywhere, including loopback and the container", () => {
    expect(decideBind({ host: "127.0.0.1", allowPublic: false, mode: "token" })).toMatchObject({ ok: false });
    expect(decideBind({ host: "127.0.0.1", allowPublic: false, mode: "token", token: TOKEN })).toEqual({ ok: true, auth: "token", kind: "loopback" });
    expect(decideBind({ host: "0.0.0.0", allowPublic: true, mode: "token", container: true, token: TOKEN })).toEqual({ ok: true, auth: "token", kind: "wildcard" });
  });

  it("unset: the container gets no exception, 0.0.0.0 still needs the access key", () => {
    expect(decideBind({ host: "0.0.0.0", allowPublic: true, container: true })).toMatchObject({ ok: false, message: expect.stringContaining("access key") });
    expect(decideBind({ host: "0.0.0.0", allowPublic: true, container: true, token: TOKEN })).toEqual({ ok: true, auth: "token", kind: "wildcard" });
  });
});

describe("tailscale status", () => {
  it("reads the address and MagicDNS name of a running node", () => {
    const ts = parseTailscaleStatus(fixture("status-running.json"));
    expect(ts).toEqual({
      running: true,
      ipv4: "100.101.102.103",
      ipv6: "fd7a:115c:a1e0::1234:5678",
      dnsName: "studio-vps.example-tailnet.ts.net",
      hostName: "studio-vps",
      tailnet: "owner@example.com",
    });
    expect(defaultUpHost(ts)).toBe("100.101.102.103");
  });

  it("treats a stopped node, garbage or no Tailscale as loopback-only", () => {
    const stopped = parseTailscaleStatus(fixture("status-stopped.json"));
    expect(stopped).toMatchObject({ running: false, ipv4: undefined });
    expect(parseTailscaleStatus("not json")).toEqual({ running: false });
    expect(defaultUpHost(stopped)).toBe("127.0.0.1");
    expect(defaultUpHost(null)).toBe("127.0.0.1");
  });

  it("lists every address worth opening", () => {
    const ts = parseTailscaleStatus(fixture("status-running.json"));
    expect(studioUrls("127.0.0.1", 4747, { tailscale: ts })).toEqual([{ url: "http://localhost:4747", label: "This computer" }]);
    expect(studioUrls("100.101.102.103", 4747, { tailscale: ts }).map((u) => u.url)).toEqual(["http://studio-vps.example-tailnet.ts.net:4747", "http://100.101.102.103:4747"]);
    const wild = studioUrls("0.0.0.0", 4747, {
      tailscale: ts,
      interfaces: {
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00", cidr: "127.0.0.1/8" }],
        en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:01", cidr: "192.168.1.20/24" }],
        utun4: [{ address: "100.101.102.103", family: "IPv4", internal: false, netmask: "255.255.255.255", mac: "00:00:00:00:00:00", cidr: "100.101.102.103/32" }],
      },
    });
    expect(wild).toEqual([
      { url: "http://localhost:4747", label: "This computer" },
      { url: "http://studio-vps.example-tailnet.ts.net:4747", label: "Your tailnet (MagicDNS)" },
      { url: "http://100.101.102.103:4747", label: "Your tailnet" },
      { url: "http://192.168.1.20:4747", label: "Your local network" },
    ]);
    expect(studioUrls("fd7a:115c:a1e0::1234:5678", 4747)[0]!.url).toBe("http://[fd7a:115c:a1e0::1234:5678]:4747");
  });
});

describe("access key", () => {
  it("creates a strong key once, saves it to .env and reuses it", () => {
    const root = mkdtempSync(join(tmpdir(), "aos-studio-token-"));
    writeFileSync(join(root, ".env"), "# secrets\nDATABASE_URL=postgres://x\n");
    const env: Record<string, string> = {};
    const ws = { paths: { root } as never, secret: (n: string) => env[n] };
    expect(ensureStudioToken(ws, false)).toEqual({ token: undefined, created: false });
    const first = ensureStudioToken(ws, true);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(`# secrets\nDATABASE_URL=postgres://x\nATTENTIONOS_STUDIO_TOKEN=${first.token}\n`);
    env.ATTENTIONOS_STUDIO_TOKEN = first.token!;
    expect(ensureStudioToken(ws, true)).toEqual({ token: first.token, created: false });
  });
});
