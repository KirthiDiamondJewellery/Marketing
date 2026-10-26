/**
 * Short human refs used in chat: approvals are `ap-<n>`, edit jobs are `rf-<n>` with an optional version
 * (`rf-123 v2`). Users type them loosely ("AP7", "ap 7", "rf123 V2"), so parsing is forgiving.
 */

export type ApprovalRef = { kind: "ap"; ref: string; n: number };
export type EditRef = { kind: "rf"; ref: string; n: number; version?: number };
export type Ref = ApprovalRef | EditRef;

const REF_RE = /^\s*(ap|rf)[\s-]?(\d{1,9})(?:\s*v(\d{1,4}))?\s*$/i;

export function parseRef(input: string | undefined): Ref | undefined {
  if (!input) return undefined;
  const m = REF_RE.exec(input);
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as "ap" | "rf";
  const n = Number(m[2]);
  const ref = `${kind}-${n}`;
  if (kind === "ap") return { kind, ref, n };
  return m[3] ? { kind, ref, n, version: Number(m[3]) } : { kind, ref, n };
}

/** Accepts "ap-7", "AP7", "ap 7" or just "7". */
export function normalizeApprovalRef(input: string): string | undefined {
  const s = input.trim();
  if (/^\d{1,9}$/.test(s)) return `ap-${Number(s)}`;
  const r = parseRef(s);
  return r?.kind === "ap" ? r.ref : undefined;
}

export function formatEditRef(ref: EditRef): string {
  return ref.version ? `${ref.ref} v${ref.version}` : ref.ref;
}

/** Button ids: `approve:ap-7`, `reject:ap-7`, `revise:ap-7`. Fits Telegram's 64 bytes and Discord's 100. */
export type Decision = "approve" | "reject" | "revise";

export function actionId(decision: Decision, ref: string): string {
  return `${decision}:${ref}`;
}

export function parseActionId(id: string): { decision: Decision; ref: string } | undefined {
  const m = /^(approve|reject|revise):(ap-\d{1,9})$/i.exec(id.trim());
  if (!m) return undefined;
  return { decision: m[1]!.toLowerCase() as Decision, ref: m[2]!.toLowerCase() };
}
