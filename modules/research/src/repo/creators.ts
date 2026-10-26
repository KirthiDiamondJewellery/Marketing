import type { Platform, WorkspaceContext } from "@attentionos/core";
import { jsonb } from "@attentionos/core";
import { normaliseHandle } from "../lib/brandFiles.ts";
import { iso, num } from "../lib/db.ts";
import type { Baseline } from "@attentionos/scoring";

export type TrackedCreator = {
  id: string;
  platform: Platform;
  handle: string;
  tier: string;
  active: boolean;
  baseline: Baseline | null;
  lastScannedAt: string | null;
  notes: string | null;
};

const toCreator = (r: Record<string, unknown>): TrackedCreator => ({
  id: r.id as string,
  platform: r.platform as Platform,
  handle: r.handle as string,
  tier: r.tier as string,
  active: r.active as boolean,
  baseline: (r.baseline as Baseline | null) ?? null,
  lastScannedAt: iso(r.last_scanned_at),
  notes: (r.notes as string | null) ?? null,
});

/**
 * Mirrors `brand/competitors.yaml` into `tracked_creators`: listed creators are upserted and active, creators
 * no longer listed are deactivated (history is kept). The `own` tier is never touched.
 */
export async function syncTrackedCreators(ws: WorkspaceContext): Promise<{ active: number; added: number; deactivated: number }> {
  const listed = ws.reloadBrand().competitors.creators.map((c) => ({ ...c, handle: normaliseHandle(c.handle) }));
  let added = 0;
  for (const c of listed) {
    const [row] = await ws.sql`
      insert into tracked_creators (workspace_id, platform, handle, tier, active, notes)
      values (${ws.id}, ${c.platform}, ${c.handle}, ${c.tier}, true, ${c.notes ?? null})
      on conflict (workspace_id, platform, handle) do update
        set tier = excluded.tier, active = true, notes = coalesce(excluded.notes, tracked_creators.notes)
      returning (xmax = 0) as inserted`;
    if (row?.inserted) added++;
  }
  const keep = listed.map((c) => `${c.platform}:${c.handle}`);
  const gone = await ws.sql`
    update tracked_creators set active = false
     where workspace_id = ${ws.id} and active and tier <> 'own'
       and not ((platform || ':' || handle) = any(${keep}::text[]))
    returning id`;
  return { active: listed.length, added, deactivated: gone.length };
}

export async function listTrackedCreators(ws: WorkspaceContext, opts: { platform?: Platform; includeInactive?: boolean } = {}): Promise<TrackedCreator[]> {
  const rows = await ws.sql`
    select * from tracked_creators
     where workspace_id = ${ws.id} and tier <> 'own'
       ${opts.includeInactive ? ws.sql`` : ws.sql`and active`}
       ${opts.platform ? ws.sql`and platform = ${opts.platform}` : ws.sql``}
     order by platform, handle`;
  return rows.map(toCreator);
}

export async function setCreatorBaseline(ws: WorkspaceContext, creatorId: string, baseline: Baseline): Promise<void> {
  await ws.sql`update tracked_creators set baseline = ${jsonb(ws.sql, baseline)} where workspace_id = ${ws.id} and id = ${creatorId}`;
}

export async function markScanned(ws: WorkspaceContext, creatorId: string): Promise<void> {
  await ws.sql`update tracked_creators set last_scanned_at = ${ws.now()} where workspace_id = ${ws.id} and id = ${creatorId}`;
}

export async function creatorStats(ws: WorkspaceContext): Promise<{ active: number; lastScanAt: string | null }> {
  const [r] = await ws.sql`
    select count(*) filter (where active)::int as active, max(last_scanned_at) as last
      from tracked_creators where workspace_id = ${ws.id} and tier <> 'own'`;
  return { active: num(r?.active) ?? 0, lastScanAt: iso(r?.last) };
}
