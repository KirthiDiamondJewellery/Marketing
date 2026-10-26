import type { AttentionOSConfig, Sql } from "@attentionos/core";

/**
 * What the analytics readers need from a workspace. A full `WorkspaceContext` satisfies it, and so does Studio's
 * lighter workspace handle, so the dashboard and the agents' MCP tools compute the same numbers with the same code.
 */
export type AnalyticsCtx = { id: string; sql: Sql; config: AttentionOSConfig; now(): Date };

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const daysAgo = (ctx: AnalyticsCtx, days: number) => new Date(ctx.now().getTime() - days * DAY_MS);

/** `{ aos: {...} }` from a metrics row's raw JSON (clicks, impressions, reposts, retention). */
export function aosOf(raw: unknown): { clicks?: number; impressions?: number; reposts?: number; retention?: { t: number; pct: number }[] } {
  const a = (raw as { aos?: unknown } | null)?.aos;
  if (!a || typeof a !== "object") return {};
  const o = a as Record<string, unknown>;
  const out: ReturnType<typeof aosOf> = {};
  for (const k of ["clicks", "impressions", "reposts"] as const) {
    const v = num(o[k]);
    if (v !== null) out[k] = v;
  }
  if (Array.isArray(o.retention)) {
    const pts = o.retention
      .map((p) => ({ t: num((p as { t?: unknown })?.t), pct: num((p as { pct?: unknown })?.pct) }))
      .filter((p): p is { t: number; pct: number } => p.t !== null && p.pct !== null);
    if (pts.length >= 2) out.retention = pts.sort((a2, b) => a2.t - b.t);
  }
  return out;
}

/** Retention at second `t`, linearly interpolated (null outside the curve). */
export function retentionAt(curve: readonly { t: number; pct: number }[] | undefined, t: number): number | null {
  if (!curve?.length) return null;
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i]!;
    if (p.t === t) return p.pct;
    if (p.t > t) {
      if (i === 0) return null;
      const a = curve[i - 1]!;
      return Math.round((a.pct + ((p.pct - a.pct) * (t - a.t)) / (p.t - a.t)) * 10) / 10;
    }
  }
  return null;
}
