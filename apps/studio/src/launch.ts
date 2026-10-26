/**
 * Shared by the dev launcher and `attentionos studio`: the env Studio's server needs (see src/server/workspace.ts).
 * Kept free of Next and server-only imports so the CLI can import it.
 */
export type StudioLaunchInput = {
  id: string;
  paths: { root: string };
  config: unknown;
  secret(name: string): string | undefined;
};

/**
 * Set to "1" when Studio runs under `attentionos up` / `attentionos studio`, which watch the settings file and .env
 * and restart Studio and the worker with them, so a save applies on its own.
 */
export const LIVE_SETTINGS_ENV = "ATTENTIONOS_LIVE_SETTINGS";
/** In the workspace's .attentionos/ folder: written when saved settings couldn't be applied, removed once they are. */
export const SETTINGS_STATUS_FILE = "settings-status.json";
export type SettingsStatus = { state: "failed"; message: string; fix?: string; at: string };

export function studioEnv(ws: StudioLaunchInput, opts: { databaseUrl?: string } = {}): Record<string, string> {
  const databaseUrl = opts.databaseUrl ?? ws.secret("DATABASE_URL") ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set in this workspace's .env.");
  return {
    ATTENTIONOS_DATABASE_URL: databaseUrl,
    ATTENTIONOS_WORKSPACE_ID: ws.id,
    ATTENTIONOS_WORKSPACE_ROOT: ws.paths.root,
    ATTENTIONOS_CONFIG_JSON: JSON.stringify(ws.config),
  };
}
