import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { WorkspaceContext } from "@attentionos/core";
import { claimEntrySchema, preflight, type ClaimEntry, type PreflightContext, type PreflightStage, type Signoff, type SignoffKind, type ValidationResult } from "@attentionos/guardrails";
import { planOutputDuration, type EditPlan, type FormatTemplate } from "@attentionos/media";
import { getAssets } from "./repo.ts";

/**
 * Wiring to the deterministic preflight gates in @attentionos/guardrails (`plan | render | final`). The gate checks
 * structure, that assets exist, that every claim on screen has PASS evidence in the script's claim ledger, layout
 * ratios for the format, and human sign-offs. This module only adapts the EditPlan and gathers the context.
 */

/** Every asset id an EditPlan references. */
export function planAssetIds(plan: EditPlan): string[] {
  const ids: string[] = [];
  for (const s of plan.layout.segments) {
    if (s.visual) ids.push(s.visual.assetId);
    if (s.inset?.matteAssetId) ids.push(s.inset.matteAssetId);
  }
  for (const o of plan.overlays) if (o.assetId) ids.push(o.assetId);
  for (const b of plan.broll) ids.push(b.assetId);
  if (plan.audio.music) ids.push(plan.audio.music.assetId);
  return [...new Set(ids)];
}

/**
 * assetId → local file. Ids are `media_assets` uuids or, for files the user dropped into the workspace, paths relative
 * to the workspace root. Paths may never point outside the workspace.
 */
export async function resolvePlanAssets(ws: WorkspaceContext, plan: EditPlan): Promise<{ assets: Record<string, { path: string; kind?: string }>; problems: string[] }> {
  const ids = planAssetIds(plan);
  const rows = await getAssets(ws, ids);
  const assets: Record<string, { path: string; kind?: string }> = {};
  const problems: string[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (row) {
      assets[id] = { path: row.uri, kind: row.kind };
      continue;
    }
    if (/^[0-9a-f-]{36}$/i.test(id)) {
      problems.push(`Asset ${id} is not in this workspace's media library.`);
      continue;
    }
    const p = isAbsolute(id) ? id : resolve(ws.paths.root, id);
    const rel = relative(ws.paths.root, p);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      problems.push(`"${id}" is outside the workspace; copy it into media/assets first.`);
      continue;
    }
    assets[id] = { path: p };
  }
  return { assets, problems };
}

/** The claim ledger of the content's approved (else latest) script: overlay evidenceIds must point at PASS entries. */
export async function claimLedgerFor(ws: WorkspaceContext, contentId: string | null): Promise<ClaimEntry[]> {
  if (!contentId) return [];
  const rows = await ws.sql<{ claim_ledger: unknown }[]>`
    select claim_ledger from scripts where workspace_id = ${ws.id} and content_id = ${contentId}
     order by (status = 'approved') desc, version desc limit 1`;
  const raw = rows[0]?.claim_ledger;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const r = claimEntrySchema.safeParse(e);
    return r.success ? [r.data] : [];
  });
}

export function toPreflightPlan(plan: EditPlan) {
  return { ...plan, source: { ...plan.source, media: plan.source.media.path }, durationS: planOutputDuration(plan) };
}

export type GateInput = {
  ws: WorkspaceContext;
  stage: PreflightStage;
  plan: EditPlan;
  format?: FormatTemplate | null;
  assets: Record<string, { path: string }>;
  claimLedger: ClaimEntry[];
  signoffs: Signoff[];
  /** Sign-offs required at this stage; defaults to the guardrails defaults. */
  required?: SignoffKind[];
  exportPath?: string;
  exportProbe?: PreflightContext["exportProbe"];
};

export function runGate(g: GateInput): ValidationResult {
  const ctx: PreflightContext = {
    baseDir: g.ws.paths.root,
    assets: Object.fromEntries(Object.entries(g.assets).map(([k, v]) => [k, { uri: v.path }])),
    fileExists: existsSync,
    claimLedger: g.claimLedger,
    signoffs: g.signoffs,
    ...(g.required ? { requiredSignoffs: { [g.stage]: g.required } } : {}),
    ...(g.format?.layout.fullVisualShare ? { fullVisualShare: g.format.layout.fullVisualShare } : {}),
    ...(g.exportPath ? { exportPath: g.exportPath } : {}),
    ...(g.exportProbe ? { exportProbe: g.exportProbe } : {}),
  };
  return preflight(g.stage, toPreflightPlan(g.plan), ctx);
}

export function addSignoff(list: readonly Signoff[], kind: SignoffKind, by: string, at: Date): Signoff[] {
  return [...list.filter((s) => s.kind !== kind), { kind, by, at: at.toISOString() }];
}

export function describeIssues(r: ValidationResult, max = 6): string {
  const lines = r.errors.slice(0, max).map((e) => `- ${e.message}${e.fix ? ` Fix: ${e.fix}` : ""}`);
  if (r.errors.length > max) lines.push(`- and ${r.errors.length - max} more`);
  return lines.join("\n");
}
