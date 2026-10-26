import { requireSession } from "@/server/auth";
import { buildSnapshot } from "@/server/snapshot";
import { workspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  await requireSession();
  return Response.json(await buildSnapshot(workspace()));
}
