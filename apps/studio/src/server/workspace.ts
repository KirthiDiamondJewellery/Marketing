import "server-only";
import { createSql, parseConfig, type AttentionOSConfig, type Sql } from "@attentionos/core";

/**
 * The workspace Studio serves. `attentionos studio` loads the workspace (config, .env, database) and starts this
 * server with the result in env, so Studio itself never evaluates the user's TypeScript config:
 *   ATTENTIONOS_DATABASE_URL, ATTENTIONOS_WORKSPACE_ID, ATTENTIONOS_WORKSPACE_ROOT, ATTENTIONOS_CONFIG_JSON
 */
export type StudioWorkspace = {
  id: string;
  root: string;
  config: AttentionOSConfig;
  sql: Sql;
};

let current: StudioWorkspace | undefined;

export class StudioSetupError extends Error {}

export function workspace(): StudioWorkspace {
  if (current) return current;
  const url = process.env.ATTENTIONOS_DATABASE_URL;
  const id = process.env.ATTENTIONOS_WORKSPACE_ID;
  const root = process.env.ATTENTIONOS_WORKSPACE_ROOT;
  if (!url || !id || !root) {
    throw new StudioSetupError("Studio was started without a workspace. Start AttentionOS with `./aos start` from your AttentionOS folder.");
  }
  const config = parseConfig(process.env.ATTENTIONOS_CONFIG_JSON ? JSON.parse(process.env.ATTENTIONOS_CONFIG_JSON) : {});
  current = { id, root, config, sql: createSql(url, { max: 8 }) };
  return current;
}
