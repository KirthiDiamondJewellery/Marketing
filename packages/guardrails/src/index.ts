/**
 * @attentionos/guardrails: deterministic gates ("Code holds the gates, the LLM does the judgment").
 * Pure functions, exhaustively tested, never edited by an LLM at runtime.
 */
export * from "./issues.ts";
export * from "./text.ts";
export * from "./numbers.ts";
export * from "./banned.ts";
export * from "./keywords.ts";
export * from "./claims.ts";
export * from "./captions.ts";
export * from "./script.ts";
export * from "./payload.ts";
export * from "./preflight.ts";
export * from "./textposts.ts";
export * from "./copy-guard.ts";
export * from "./remix.ts";
export { runGuard, checkFile as guardCheckFile, detectKind as guardDetectKind, findWorkspaceRoot, loadBrandRules, type BrandRules, type GuardIO } from "./cli/guard.ts";
