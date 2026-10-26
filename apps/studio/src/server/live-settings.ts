import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_SETTINGS_ENV, SETTINGS_STATUS_FILE, type SettingsStatus } from "@/launch";

/** True when Studio runs under `attentionos up` / `attentionos studio`, which apply saved settings on their own. */
export function settingsApplyLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_SETTINGS_ENV] === "1";
}

/** What a save says about when it takes effect. */
export function appliedNote(): string {
  return settingsApplyLive() ? "Applying your settings…" : "Restart Studio and the worker to apply it everywhere.";
}

/** Why the last saved settings couldn't be applied (written by the CLI), or null. */
export function settingsProblem(root: string): SettingsStatus | null {
  if (!settingsApplyLive()) return null;
  try {
    const status = JSON.parse(readFileSync(join(root, ".attentionos", SETTINGS_STATUS_FILE), "utf8")) as SettingsStatus;
    return status?.state === "failed" && typeof status.message === "string" ? status : null;
  } catch {
    return null;
  }
}
