import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { jsonb, nextRef, type Sql, type WorkspaceContext } from "@attentionos/core";
import type { Signoff, ValidationResult } from "@attentionos/guardrails";

/** SQL for edit_jobs and media_assets. Every query filters by workspace_id. */

export const EDIT_STATUSES = ["queued", "prepping", "planning", "rendering", "qc", "review", "approved", "failed", "cancelled"] as const;
export type EditStatus = (typeof EDIT_STATUSES)[number];

export type EditNote = { at: string; by: string; version: number; text: string; source?: Record<string, unknown> };

/** What edit_jobs.preflight holds: sign-offs plus the last gate results and the render history. */
export type EditPreflightState = {
  signoffs: Signoff[];
  plan?: ValidationResult;
  render?: ValidationResult;
  final?: ValidationResult;
  renders?: { version: number; output: string; videoDigest: string; audioDigest: string; at: string; qcPassed: boolean }[];
};

export type EditJobRow = {
  id: string;
  workspace_id: string;
  content_id: string | null;
  ref: string;
  engine: "cut" | "motion";
  format: string | null;
  version: number;
  status: EditStatus;
  source_asset_id: string | null;
  edit_map: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  preflight: EditPreflightState | null;
  qc_report: Record<string, unknown> | null;
  output_asset_id: string | null;
  session_id: string | null;
  notes: EditNote[];
  cost_micro: string | number;
  created_at: Date;
  updated_at: Date;
};

export type AssetRow = {
  id: string;
  workspace_id: string;
  content_id: string | null;
  kind: string;
  uri: string;
  duration_s: string | number | null;
  width: number | null;
  height: number | null;
  bytes: string | number | null;
  sha256: string | null;
  provenance: Record<string, unknown> | null;
  license: string | null;
};

export async function createEditJob(ws: WorkspaceContext, input: { sourceAssetId: string; contentId?: string | null; format: string }): Promise<EditJobRow> {
  return ws.sql.begin(async (tx) => {
    const ref = await nextRef(tx as unknown as Sql, ws.id, "rf");
    const [row] = await tx<EditJobRow[]>`
      insert into edit_jobs (workspace_id, content_id, ref, engine, format, version, status, source_asset_id, preflight)
      values (${ws.id}, ${input.contentId ?? null}, ${ref}, 'cut', ${input.format}, 1, 'queued', ${input.sourceAssetId},
              ${jsonb(tx as unknown as Sql, { signoffs: [] })})
      returning *`;
    return row!;
  });
}

export async function getEditJob(ws: WorkspaceContext, ref: string): Promise<EditJobRow | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  const [row] = await ws.sql<EditJobRow[]>`
    select * from edit_jobs where workspace_id = ${ws.id} and ${byId ? ws.sql`id = ${ref}` : ws.sql`ref = ${ref.toLowerCase()}`}`;
  return row ?? null;
}

export type EditJobPatch = Partial<{
  status: EditStatus;
  format: string;
  version: number;
  edit_map: unknown;
  plan: unknown;
  preflight: EditPreflightState;
  qc_report: unknown;
  output_asset_id: string | null;
  session_id: string | null;
  notes: EditNote[];
  cost_micro: number;
}>;

export async function updateEditJob(ws: WorkspaceContext, id: string, patch: EditJobPatch): Promise<EditJobRow> {
  const sql = ws.sql;
  const cols: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols[k] = ["edit_map", "plan", "preflight", "qc_report", "notes"].includes(k) && v !== null ? jsonb(sql, v) : v;
  }
  const [row] = await sql<EditJobRow[]>`
    update edit_jobs set ${sql(cols)}, updated_at = now() where workspace_id = ${ws.id} and id = ${id} returning *`;
  if (!row) throw new Error(`edit job ${id} not found`);
  return row;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve()).on("error", reject);
  });
  return h.digest("hex");
}

export async function insertAsset(
  ws: WorkspaceContext,
  a: { kind: string; uri: string; contentId?: string | null; durationS?: number | null; width?: number | null; height?: number | null; provenance?: Record<string, unknown>; license?: string | null; hash?: boolean },
): Promise<AssetRow> {
  let bytes: number | null = null;
  let sha: string | null = null;
  try {
    bytes = statSync(a.uri).size;
    if (a.hash) sha = await sha256File(a.uri);
  } catch {
    // remote uri or missing file: leave size and hash empty
  }
  const [row] = await ws.sql<AssetRow[]>`
    insert into media_assets (workspace_id, content_id, kind, uri, duration_s, width, height, bytes, sha256, provenance, license)
    values (${ws.id}, ${a.contentId ?? null}, ${a.kind}, ${a.uri}, ${a.durationS ?? null}, ${a.width ?? null}, ${a.height ?? null}, ${bytes}, ${sha},
            ${a.provenance ? jsonb(ws.sql, a.provenance) : null}, ${a.license ?? null})
    returning *`;
  return row!;
}

export async function getAssets(ws: WorkspaceContext, ids: string[]): Promise<Map<string, AssetRow>> {
  const uuids = [...new Set(ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i)))];
  if (!uuids.length) return new Map();
  const rows = await ws.sql<AssetRow[]>`select * from media_assets where workspace_id = ${ws.id} and id = any(${uuids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

export async function getAsset(ws: WorkspaceContext, id: string | null): Promise<AssetRow | null> {
  if (!id) return null;
  return (await getAssets(ws, [id])).get(id) ?? null;
}

export async function setContentStatus(ws: WorkspaceContext, contentId: string | null, status: string, template?: string): Promise<void> {
  if (!contentId) return;
  await ws.sql`
    update content set status = ${status}, ${template ? ws.sql`template = ${template},` : ws.sql``} updated_at = now()
     where workspace_id = ${ws.id} and id = ${contentId}`;
}

/** Latest agent session for this edit (plan or revise run), so revisions can resume it. */
export async function latestSessionFor(ws: WorkspaceContext, ref: string): Promise<{ sessionId: string | null; costMicro: number }> {
  const rows = await ws.sql<{ session_id: string | null; cost: string | null }[]>`
    select (array_agg(session_id order by created_at desc) filter (where session_id is not null))[1] as session_id,
           sum(cost_micro)::text as cost
      from agent_runs
     where workspace_id = ${ws.id} and job_id in ('editing.plan', 'editing.revise') and input->>'ref' = ${ref}`;
  return { sessionId: rows[0]?.session_id ?? null, costMicro: Number(rows[0]?.cost ?? 0) };
}
