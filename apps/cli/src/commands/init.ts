import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAND_FILES, loadBrandKit } from "@attentionos/core";
import { findWorkspaceRoot, loadConfigFile, WorkspaceError, workspacePaths } from "@attentionos/runtime";
import { parseCommand } from "../args.ts";
import { findAsset } from "../assets.ts";
import { ui } from "../ui.ts";
import { workspaceDir, type CliContext } from "../workspace.ts";

/**
 * Non-interactive fallback for `/attention:init`: restores missing Brand Kit files from the template and the
 * workspace's preset, then validates the kit. The interview itself runs in Claude Code.
 */
export async function runInit(argv: string[], ctx: CliContext): Promise<number> {
  const { values } = parseCommand("init", argv, {});
  if (values.help) {
    ui.out("Check the Brand Kit and restore missing files from your preset.\n\nUsage\n  attentionos init\n\nThe Brand Kit interview runs in Claude Code: /attention:init\n");
    return 0;
  }
  const root = findWorkspaceRoot(workspaceDir(ctx));
  if (!root) throw new WorkspaceError("No AttentionOS workspace found here.", "cd into your workspace folder (the stack's workspace/), or start AttentionOS with ./aos start to create one", "no_workspace");
  const paths = workspacePaths(root);
  const config = await loadConfigFile(paths.config);
  const template = findAsset("templates/workspace");
  const presetDir = findAsset(`presets/${config.workspace.preset}`);
  const presetFiles = presetDir && existsSync(join(presetDir, "preset.json"))
    ? (JSON.parse(readFileSync(join(presetDir, "preset.json"), "utf8")) as { files?: Record<string, string> }).files ?? {}
    : {};
  const fromPreset = new Map(Object.entries(presetFiles).map(([src, dest]) => [dest, join(presetDir!, src)]));

  ui.title("Brand Kit");
  let restored = 0;
  for (const file of Object.values(BRAND_FILES)) {
    const dest = join(paths.brand, file);
    if (existsSync(dest)) continue;
    const source = fromPreset.get(`brand/${file}`) ?? (template ? join(template, "brand", file) : null);
    if (source && existsSync(source)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
      ui.ok(`Restored brand/${file}`, fromPreset.has(`brand/${file}`) ? `from the ${config.workspace.preset} preset` : "from the template");
      restored++;
    } else {
      ui.warn(`brand/${file} is missing`);
    }
  }
  try {
    const kit = loadBrandKit(paths.brand);
    ui.ok(restored ? "Brand Kit files are valid" : "All Brand Kit files are present and valid", kit.brand.name);
  } catch (err) {
    ui.fail("Brand Kit has a problem", (err as Error).message);
    return 1;
  }
  ui.out();
  ui.out(`Next: open Claude Code here (${ui.code("claude")}) and run ${ui.code("/attention:init")}. It interviews you and writes your voice, audience and offers.`);
  ui.out();
  return 0;
}
