import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Studio sign-in. Pure Node (no Next imports at module level) so the proxy, route handlers, server actions and tests
 * share it.
 *
 * - Bound to loopback (the default `attentionos studio`): no sign-in, it's your own machine.
 * - Bound to anything else (`attentionos up` on a tailnet or VPS): an access key is required. The key is
 *   ATTENTIONOS_STUDIO_TOKEN in the workspace .env; signing in sets an httpOnly cookie holding an HMAC (keyed by the
 *   access key) of the expiry time, valid for 30 days. Changing the key signs every browser out.
 * - Optional: behind `tailscale serve`, trust the Tailscale-User-Login header (ATTENTIONOS_STUDIO_TRUST_TAILSCALE=1,
 *   only honoured when Studio listens on loopback so nobody can reach it without going through Tailscale).
 *
 * ATTENTIONOS_STUDIO_AUTH picks the mode explicitly. The CLI decides it (see decideBind in apps/cli) and passes
 * "none" or "token"; the Docker setup names the mode it runs in:
 * - "local" (or "none"): no sign-in. Docker's local profile, where the port is published to 127.0.0.1 only.
 * - "tailscale": trust Tailscale-User-Login from `tailscale serve` (Studio on loopback behind it); the access key still
 *   works for devices without a Tailscale login.
 * - "token": the access key, always.
 * Unset: sign-in is on whenever a key is set.
 */

export const SESSION_COOKIE = "aos_studio_session";
export const SESSION_DAYS = 30;
export const SESSION_MAX_AGE_S = SESSION_DAYS * 24 * 60 * 60;
const PURPOSE = "attentionos-studio-session:v1";
export const MIN_TOKEN_LENGTH = 24;

export type AuthMode = "none" | "token";

export type AuthSettings = {
  mode: AuthMode;
  token?: string;
  /** Accept `Tailscale-User-Login` from `tailscale serve` as proof of identity. */
  trustTailscale: boolean;
  /** When non-empty, only these Tailscale logins are accepted. */
  tailscaleUsers: string[];
};

export function authSettings(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const token = env.ATTENTIONOS_STUDIO_TOKEN?.trim() || undefined;
  const raw = env.ATTENTIONOS_STUDIO_AUTH?.trim().toLowerCase();
  const mode: AuthMode = raw === "none" || raw === "local" ? "none" : raw === "token" || raw === "tailscale" ? "token" : token ? "token" : "none";
  return {
    mode,
    token,
    trustTailscale: raw === "tailscale" || env.ATTENTIONOS_STUDIO_TRUST_TAILSCALE === "1",
    tailscaleUsers: (env.ATTENTIONOS_STUDIO_TAILSCALE_USERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

function mac(token: string, exp: number): string {
  return createHmac("sha256", token).update(`${PURPOSE}:${exp}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Cookie value: `v1.<expiry unix seconds>.<HMAC-SHA256(token, purpose:expiry)>`. */
export function signSession(token: string, now: number = Date.now(), maxAgeS: number = SESSION_MAX_AGE_S): string {
  const exp = Math.floor(now / 1000) + maxAgeS;
  return `v1.${exp}.${mac(token, exp)}`;
}

export function verifySession(value: string | undefined | null, token: string | undefined, now: number = Date.now()): boolean {
  if (!value || !token) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [version, expRaw, sig] = parts as [string, string, string];
  if (version !== "v1" || !/^\d{1,12}$/.test(expRaw) || !sig) return false;
  const exp = Number(expRaw);
  const nowS = Math.floor(now / 1000);
  if (exp <= nowS) return false;
  // A cookie can't outlive the session length (guards against a forged far-future expiry with a leaked key).
  if (exp > nowS + SESSION_MAX_AGE_S + 60) return false;
  return safeEqual(sig, mac(token, exp));
}

/** Constant-time comparison of what was typed against the access key. */
export function checkToken(input: string, token: string | undefined): boolean {
  if (!token || !input) return false;
  const h = (s: string) => createHmac("sha256", PURPOSE).update(s).digest();
  return timingSafeEqual(h(input.trim()), h(token));
}

/** Paths that never need a session: the sign-in page and its API, the health check and static assets. */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/login" || pathname.startsWith("/login/")) return true;
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/health") return true;
  if (pathname.startsWith("/_next/static/") || pathname.startsWith("/_next/image")) return true;
  if (pathname.startsWith("/api/")) return false;
  return /^\/[^/]*\.(ico|png|svg|jpg|jpeg|webp|gif|webmanifest|txt|woff2?)$/i.test(pathname);
}

export type AccessDecision = "allow" | "sign-in" | "misconfigured";

export function decideAccess(input: {
  pathname: string;
  cookie?: string | null;
  tailscaleUser?: string | null;
  settings: AuthSettings;
  now?: number;
}): AccessDecision {
  const { settings } = input;
  if (settings.mode === "none" || isPublicPath(input.pathname)) return "allow";
  if (settings.trustTailscale && input.tailscaleUser) {
    const login = input.tailscaleUser.trim().toLowerCase();
    if (login && (settings.tailscaleUsers.length === 0 || settings.tailscaleUsers.includes(login))) return "allow";
  }
  if (!settings.token) return "misconfigured";
  return verifySession(input.cookie, settings.token, input.now) ? "allow" : "sign-in";
}

/** Only same-site paths: "/settings?x=1" yes, "//evil.com" or "https://…" no. */
export function safeNext(next: string | null | undefined): string {
  // Browsers discard tabs and newlines when parsing URLs, which can turn a seemingly local path into //host.
  if (next && /[\u0000-\u0020\u007f\\]/.test(next)) return "/";
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/login") || next.startsWith("/api/auth")) return "/";
  return next;
}

/** Browser mutations must come from Studio itself, including when local mode has no session cookie. */
export function isSameOriginMutation(request: { method: string; url: string; headers: Headers }, publicUrl = process.env.ATTENTIONOS_STUDIO_URL): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  // Non-browser clients do not send Origin. Browser form and fetch mutations do.
  if (!origin) return true;
  try {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    const expected = new Set([url.origin]);
    if (host && !/[\s/@\\]/.test(host)) expected.add(new URL(`${url.protocol}//${host}`).origin);
    if (publicUrl) expected.add(new URL(publicUrl).origin);
    return expected.has(new URL(origin).origin) && origin !== "null";
  } catch {
    return false;
  }
}

/** Loopback binding alone does not prevent a hostile website from using DNS rebinding. */
export function isLocalHost(host: string | null): boolean {
  if (!host || /[\s/@\\]/.test(host)) return false;
  try {
    const name = new URL(`http://${host}`).hostname;
    return name === "localhost" || name === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(name);
  } catch {
    return false;
  }
}

/** Fixed-window limiter for sign-in attempts, per client and overall. In memory: one Studio process. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: number = Date.now()): { allowed: boolean; retryAfterS: number } {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.prune(now);
      return { allowed: true, retryAfterS: 0 };
    }
    entry.count++;
    return entry.count > this.limit ? { allowed: false, retryAfterS: Math.ceil((entry.resetAt - now) / 1000) } : { allowed: true, retryAfterS: 0 };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/** Shared by the login route: 10 tries per client and 30 overall per 10 minutes. */
export const loginLimits = {
  perClient: new RateLimiter(10, 10 * 60_000),
  overall: new RateLimiter(30, 10 * 60_000),
};

export function clientKey(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || headers.get("x-real-ip")?.trim() || headers.get("tailscale-user-login")?.trim() || "unknown";
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Sign in to Studio first.");
    this.name = "UnauthorizedError";
  }
}

/**
 * For server actions and route handlers: Proxy guards page and API requests, but server actions should check again
 * (Next's guidance). No-op when sign-in is off.
 */
export async function requireSession(): Promise<void> {
  const settings = authSettings();
  const { cookies, headers } = await import("next/headers");
  const [c, h] = await Promise.all([cookies(), headers()]);
  if (settings.mode === "none") {
    if (!isLocalHost(h.get("host"))) throw new UnauthorizedError();
    return;
  }
  const decision = decideAccess({
    pathname: "/__action",
    cookie: c.get(SESSION_COOKIE)?.value,
    tailscaleUser: h.get("tailscale-user-login"),
    settings,
  });
  if (decision !== "allow") throw new UnauthorizedError();
}
