import type { LlmJob, WorkspaceContext } from "@attentionos/core";

export const MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/**
 * Fallback model ids per alias. The workspace config's `models` map normally supplies them; ATTENTIONOS_MODEL_OPUS /
 * _SONNET / _HAIKU in .env (or the environment) override both.
 */
export const DEFAULT_MODEL_IDS: Record<ModelAlias, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

const isAlias = (v: string): v is ModelAlias => (MODEL_ALIASES as readonly string[]).includes(v);

export function modelIdFor(
  value: string,
  secret: (name: string) => string | undefined = () => undefined,
  models: Partial<Record<ModelAlias, string>> = {},
): string {
  if (!isAlias(value)) return value;
  return secret(`ATTENTIONOS_MODEL_${value.toUpperCase()}`) ?? models[value] ?? DEFAULT_MODEL_IDS[value];
}

/** Agent config (alias or full id) wins over the job's default; Sonnet-class is the fallback for bulk work. */
export function resolveModel(ws: Pick<WorkspaceContext, "config" | "secret">, job: Pick<LlmJob, "agent" | "defaultModel">): string {
  const chosen = ws.config.agents[job.agent]?.model ?? job.defaultModel ?? "sonnet";
  return modelIdFor(chosen, ws.secret, ws.config.models);
}
