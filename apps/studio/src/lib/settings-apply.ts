/**
 * Live settings on the client: a save that AttentionOS applies by restarting Studio marks itself here, and the shell
 * says "Your new settings are live" when the live stream comes back. Session storage keeps the mark across a reload.
 */
const KEY = "aos.settings.applying";
const WINDOW_MS = 90_000;
let markedAt = 0;

export function noteSettingsApplying(): void {
  markedAt = Date.now();
  try {
    sessionStorage.setItem(KEY, String(markedAt));
  } catch {
    // private mode: the in-memory mark is enough
  }
}

/** True (once) when a save asked for its settings to be applied within the last 90 seconds. */
export function takeSettingsApplying(): boolean {
  let at = markedAt;
  try {
    at = Math.max(at, Number(sessionStorage.getItem(KEY)) || 0);
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  markedAt = 0;
  return at > 0 && Date.now() - at < WINDOW_MS;
}
