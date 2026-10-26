import { NextResponse } from "next/server";
import { authSettings, checkToken, clientKey, loginLimits, safeNext, SESSION_COOKIE, SESSION_MAX_AGE_S, signSession } from "@/server/auth";

export const dynamic = "force-dynamic";

function isHttps(request: Request): boolean {
  return request.headers.get("x-forwarded-proto") === "https" || new URL(request.url).protocol === "https:";
}

/** Relative redirect, so it works behind `tailscale serve` and any other proxy that rewrites the host. */
function redirect(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

/** Sign in with the access key. Accepts a form post (the /login page, works without JavaScript) or JSON. */
export async function POST(request: Request) {
  const json = request.headers.get("content-type")?.includes("application/json") ?? false;
  let token = "";
  let next = "/";
  try {
    if (json) {
      const body = (await request.json()) as { token?: unknown; next?: unknown };
      token = typeof body.token === "string" ? body.token : "";
      next = safeNext(typeof body.next === "string" ? body.next : "/");
    } else {
      const form = await request.formData();
      token = String(form.get("token") ?? "");
      next = safeNext(String(form.get("next") ?? "/"));
    }
  } catch {
    return json ? NextResponse.json({ ok: false, error: "Couldn't read that request." }, { status: 400 }) : redirect("/login?error=bad");
  }

  const settings = authSettings();
  const back = (error: string) => redirect(`/login?error=${error}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`);
  if (settings.mode === "none") return json ? NextResponse.json({ ok: true, next }) : redirect(next);
  if (!settings.token) {
    return json ? NextResponse.json({ ok: false, error: "Studio has no access key set." }, { status: 503 }) : back("unset");
  }

  const key = clientKey(request.headers);
  const client = loginLimits.perClient.hit(key);
  const overall = loginLimits.overall.hit("all");
  if (!client.allowed || !overall.allowed) {
    const retryAfter = Math.max(client.retryAfterS, overall.retryAfterS);
    return json
      ? NextResponse.json({ ok: false, error: "Too many tries. Wait a few minutes and try again." }, { status: 429, headers: { "Retry-After": String(retryAfter) } })
      : back("limited");
  }
  if (!checkToken(token, settings.token)) {
    return json ? NextResponse.json({ ok: false, error: "That key doesn't match." }, { status: 401 }) : back("wrong");
  }

  loginLimits.perClient.reset(key);
  const res = json ? NextResponse.json({ ok: true, next }) : redirect(next);
  res.cookies.set(SESSION_COOKIE, signSession(settings.token), {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(request),
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  return res;
}
