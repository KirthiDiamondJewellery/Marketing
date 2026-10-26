import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Signs this browser out. POST only, so a link elsewhere can't sign you out. */
export async function POST(request: Request) {
  const json = request.headers.get("accept")?.includes("application/json") ?? false;
  const res = json ? NextResponse.json({ ok: true }) : new NextResponse(null, { status: 303, headers: { Location: "/login?signedOut=1" } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
