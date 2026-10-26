import { ui } from "../ui.ts";

declare const __ATTENTIONOS_VERSION__: string | undefined;
export const VERSION = typeof __ATTENTIONOS_VERSION__ === "string" ? __ATTENTIONOS_VERSION__ : "0.1.0";

export function runUpdate(): number {
  ui.title(`AttentionOS ${VERSION}`);
  ui.out("Your Brand Kit, settings and media are never touched by an update. To update the engine:");
  ui.out();
  ui.step(1, `From your AttentionOS folder: ${ui.code("./aos update")} (fetches the latest source, rebuilds, applies database updates and restarts)`);
  ui.step(2, `In Claude Code, update the plugin: ${ui.code("/plugin update attentionos")}`);
  ui.step(3, `Check everything: ${ui.code("./aos doctor")}`);
  ui.out();
  ui.out(ui.dim("  What changed: see CHANGELOG.md in the AttentionOS repository."));
  ui.out();
  return 0;
}
