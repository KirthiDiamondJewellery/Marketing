import { studioHealth } from "@/server/doctor";

export const dynamic = "force-dynamic";

/** `{ ok, workspace, worker, version }` for `attentionos studio`, Docker health checks and uptime monitors. No secrets. */
export async function GET() {
  const health = await studioHealth();
  return Response.json(health, { status: health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
