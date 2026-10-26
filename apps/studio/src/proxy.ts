import { NextResponse, type NextRequest } from "next/server";
import { authSettings, decideAccess, isLocalHost, isSameOriginMutation, SESSION_COOKIE } from "./server/auth";
import { MOVED } from "./lib/nav";

/** Old page addresses (bookmarks, links in messages) go to the page that holds that work now. */
function moved(pathname: string): string | null {
  if (MOVED[pathname]) return MOVED[pathname];
  const m = /^\/insights\/(posts|competitors|working)(\/.*)?$/.exec(pathname);
  return m ? `/analytics/${m[1]}${m[2] ?? ""}` : null;
}

/**
 * Sign-in gate (see src/server/auth.ts). Off when Studio listens on loopback or runs in Docker's local mode
 * (ATTENTIONOS_STUDIO_AUTH=local); otherwise every page, API route and the live stream need a session cookie (or, in
 * tailscale mode, a Tailscale login from `tailscale serve`), except /login, /api/auth/*, /api/health and static assets.
 *
 * This is the primary guard. Every server action and API route also calls `requireSession()` as defence in depth
 * (test/action-auth.test.ts checks every exported action does).
 */
export function proxy(request: NextRequest) {
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  const to = moved(request.nextUrl.pathname);
  if (to) return NextResponse.redirect(new URL(to, request.url), 307);
  const settings = authSettings();
  if (settings.mode === "none") {
    if (!isLocalHost(request.headers.get("host"))) return NextResponse.json({ error: "Local Studio requires a localhost address. Enable token authentication for remote access." }, { status: 403 });
    return NextResponse.next();
  }
  const { pathname, search } = request.nextUrl;
  const decision = decideAccess({
    pathname,
    cookie: request.cookies.get(SESSION_COOKIE)?.value,
    tailscaleUser: request.headers.get("tailscale-user-login"),
    settings,
  });
  if (decision === "allow") return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  if (decision === "misconfigured") {
    const message = "Studio needs an access key: set ATTENTIONOS_STUDIO_TOKEN in your workspace .env and restart it.";
    return isApi ? NextResponse.json({ error: message }, { status: 503 }) : new NextResponse(message, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (isApi || request.headers.get("accept")?.includes("text/event-stream")) {
    return NextResponse.json({ error: "Sign in to Studio first." }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" && !search ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
