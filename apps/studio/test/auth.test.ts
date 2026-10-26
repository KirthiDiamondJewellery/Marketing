import { describe, expect, it } from "vitest";
import {
  authSettings,
  checkToken,
  decideAccess,
  isPublicPath,
  isSameOriginMutation,
  isLocalHost,
  RateLimiter,
  safeNext,
  SESSION_MAX_AGE_S,
  signSession,
  verifySession,
} from "../src/server/auth.ts";

const TOKEN = "k3y-for-tests-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 10, 12);

describe("studio sessions", () => {
  it("signs and verifies a 30-day session", () => {
    const cookie = signSession(TOKEN, NOW);
    expect(cookie).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
    expect(cookie).not.toContain(TOKEN);
    expect(verifySession(cookie, TOKEN, NOW)).toBe(true);
    expect(verifySession(cookie, TOKEN, NOW + (SESSION_MAX_AGE_S - 60) * 1000)).toBe(true);
    expect(verifySession(cookie, TOKEN, NOW + (SESSION_MAX_AGE_S + 1) * 1000)).toBe(false);
  });

  it("rejects tampering, another key and garbage", () => {
    const cookie = signSession(TOKEN, NOW);
    const [v, exp, sig] = cookie.split(".");
    expect(verifySession(`${v}.${Number(exp) + 1000}.${sig}`, TOKEN, NOW)).toBe(false);
    expect(verifySession(`${v}.${exp}.${sig!.slice(0, -2)}xx`, TOKEN, NOW)).toBe(false);
    expect(verifySession(cookie, "a-different-key-0123456789", NOW)).toBe(false);
    expect(verifySession(signSession(TOKEN, NOW, 400 * 86400), TOKEN, NOW)).toBe(false);
    for (const bad of [undefined, "", "v1", "v2.1.x", "v1.abc.x", "v1..", "v1.1.2.3"]) expect(verifySession(bad, TOKEN, NOW)).toBe(false);
    expect(verifySession(cookie, undefined, NOW)).toBe(false);
  });

  it("checks the typed key in constant time", () => {
    expect(checkToken(TOKEN, TOKEN)).toBe(true);
    expect(checkToken(`  ${TOKEN}\n`, TOKEN)).toBe(true);
    expect(checkToken("nope", TOKEN)).toBe(false);
    expect(checkToken("", TOKEN)).toBe(false);
    expect(checkToken(TOKEN, undefined)).toBe(false);
  });
});

describe("access rules", () => {
  const on = authSettings({ ATTENTIONOS_STUDIO_AUTH: "token", ATTENTIONOS_STUDIO_TOKEN: TOKEN });

  it("reads the mode from env", () => {
    expect(authSettings({}).mode).toBe("none");
    expect(authSettings({ ATTENTIONOS_STUDIO_TOKEN: TOKEN }).mode).toBe("token");
    expect(authSettings({ ATTENTIONOS_STUDIO_AUTH: "none", ATTENTIONOS_STUDIO_TOKEN: TOKEN }).mode).toBe("none");
    expect(on).toMatchObject({ mode: "token", token: TOKEN, trustTailscale: false });
  });

  it("lets public paths through and gates the rest", () => {
    for (const p of ["/login", "/api/auth/login", "/api/health", "/_next/static/chunks/a.js", "/favicon.ico", "/icon.png"]) expect(isPublicPath(p)).toBe(true);
    for (const p of ["/", "/settings", "/api/live", "/api/snapshot", "/api/export.png", "/api/healthz"]) expect(isPublicPath(p)).toBe(false);
    expect(decideAccess({ pathname: "/api/live", settings: on, now: NOW })).toBe("sign-in");
    expect(decideAccess({ pathname: "/api/live", cookie: signSession(TOKEN, NOW), settings: on, now: NOW })).toBe("allow");
    expect(decideAccess({ pathname: "/api/health", settings: on, now: NOW })).toBe("allow");
    expect(decideAccess({ pathname: "/", settings: authSettings({}), now: NOW })).toBe("allow");
    expect(decideAccess({ pathname: "/", settings: authSettings({ ATTENTIONOS_STUDIO_AUTH: "token" }), now: NOW })).toBe("misconfigured");
  });

  it("trusts Tailscale identity only when asked, and only listed users", () => {
    expect(decideAccess({ pathname: "/", tailscaleUser: "owner@example.com", settings: on, now: NOW })).toBe("sign-in");
    const ts = authSettings({ ATTENTIONOS_STUDIO_AUTH: "token", ATTENTIONOS_STUDIO_TOKEN: TOKEN, ATTENTIONOS_STUDIO_TRUST_TAILSCALE: "1" });
    expect(decideAccess({ pathname: "/", tailscaleUser: "owner@example.com", settings: ts, now: NOW })).toBe("allow");
    const only = authSettings({ ...{ ATTENTIONOS_STUDIO_AUTH: "token", ATTENTIONOS_STUDIO_TOKEN: TOKEN, ATTENTIONOS_STUDIO_TRUST_TAILSCALE: "1" }, ATTENTIONOS_STUDIO_TAILSCALE_USERS: "Owner@Example.com" });
    expect(decideAccess({ pathname: "/", tailscaleUser: "owner@example.com", settings: only, now: NOW })).toBe("allow");
    expect(decideAccess({ pathname: "/", tailscaleUser: "guest@example.com", settings: only, now: NOW })).toBe("sign-in");
  });

  it("reads the Docker modes: local (no sign-in), tailscale (identity + key) and token", () => {
    expect(authSettings({ ATTENTIONOS_STUDIO_AUTH: "local", ATTENTIONOS_STUDIO_TOKEN: TOKEN })).toMatchObject({ mode: "none", trustTailscale: false });
    expect(authSettings({ ATTENTIONOS_STUDIO_AUTH: "token", ATTENTIONOS_STUDIO_TOKEN: TOKEN })).toMatchObject({ mode: "token", trustTailscale: false });
    const ts = authSettings({ ATTENTIONOS_STUDIO_AUTH: "tailscale", ATTENTIONOS_STUDIO_TOKEN: TOKEN });
    expect(ts).toMatchObject({ mode: "token", trustTailscale: true });
    // A tailnet visitor gets in on their Tailscale login; anyone else (Funnel, a tagged device) needs the key.
    expect(decideAccess({ pathname: "/", tailscaleUser: "owner@example.com", settings: ts, now: NOW })).toBe("allow");
    expect(decideAccess({ pathname: "/", settings: ts, now: NOW })).toBe("sign-in");
    expect(decideAccess({ pathname: "/", cookie: signSession(TOKEN, NOW), settings: ts, now: NOW })).toBe("allow");
    expect(decideAccess({ pathname: "/settings", settings: authSettings({ ATTENTIONOS_STUDIO_AUTH: "local" }), now: NOW })).toBe("allow");
    const only = authSettings({ ATTENTIONOS_STUDIO_AUTH: "tailscale", ATTENTIONOS_STUDIO_TOKEN: TOKEN, ATTENTIONOS_STUDIO_TAILSCALE_USERS: "owner@example.com" });
    expect(decideAccess({ pathname: "/", tailscaleUser: "guest@example.com", settings: only, now: NOW })).toBe("sign-in");
  });

  it("only redirects to same-site paths", () => {
    expect(safeNext("/settings?tab=keys")).toBe("/settings?tab=keys");
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/login", "settings"]) expect(safeNext(bad)).toBe("/");
  });

  it("rejects cross-origin browser writes even without cookie authentication", () => {
    const request = (origin: string, site = "same-origin") => ({ method: "POST", url: "http://localhost:4747/api/media/upload", headers: new Headers({ origin, "sec-fetch-site": site }) });
    expect(isSameOriginMutation(request("http://localhost:4747"), "")).toBe(true);
    expect(isSameOriginMutation(request("https://evil.example"), "")).toBe(false);
    expect(isSameOriginMutation(request("null"), "")).toBe(false);
    expect(isSameOriginMutation(request("http://localhost:4747", "cross-site"), "")).toBe(false);
    expect(isSameOriginMutation(request("https://studio.example"), "https://studio.example")).toBe(true);
  });

  it("rejects attacker-controlled Host headers in local mode", () => {
    for (const host of ["localhost:4747", "127.0.0.1:4747", "[::1]:4747"]) expect(isLocalHost(host)).toBe(true);
    for (const host of [null, "evil.example:4747", "localhost.evil.example", "localhost@evil.example", "localhost/evil", " localhost"]) expect(isLocalHost(host)).toBe(false);
  });

  it("rate-limits sign-in attempts per window", () => {
    const rl = new RateLimiter(3, 60_000);
    expect([1, 2, 3].map(() => rl.hit("a", NOW).allowed)).toEqual([true, true, true]);
    expect(rl.hit("a", NOW)).toEqual({ allowed: false, retryAfterS: 60 });
    expect(rl.hit("b", NOW).allowed).toBe(true);
    expect(rl.hit("a", NOW + 60_001).allowed).toBe(true);
    rl.reset("a");
    expect(rl.hit("a", NOW).allowed).toBe(true);
  });
});
