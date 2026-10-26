import { isActor, type Actor } from "@attentionos/core";

export const DEFAULT_ACTOR: Actor = "user:local";

/** Actor for this MCP process: ATTENTIONOS_ACTOR, else the local user. Invalid values fall back with no error. */
export function envActor(env: NodeJS.ProcessEnv = process.env): Actor {
  const value = env.ATTENTIONOS_ACTOR?.trim();
  return value && isActor(value) ? value : DEFAULT_ACTOR;
}

/**
 * Picks the actor for one call: a per-call claim (`_actor` argument or `_meta.actor`) unless the server is locked
 * (Autopilot runs pin the actor to the running agent). Returns null for an invalid claim.
 */
export function callActor(base: Actor, locked: boolean, claim: unknown): Actor | null {
  if (locked || claim === undefined || claim === null || claim === "") return base;
  return typeof claim === "string" && isActor(claim) ? claim : null;
}
