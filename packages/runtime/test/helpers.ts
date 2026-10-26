import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "aos-ws-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

export const CONFIG_TS = `import { defineConfig } from "attentionos/config";
import type { AttentionOSConfigInput } from "attentionos/config";

const timezone: string = "America/Chicago";

export default defineConfig({
  workspace: { name: "Examplebrand Studio", preset: "agency-founder", timezone },
  mode: "copilot",
  providers: { notifier: "console", publisher: "manual", inbox: "none", ownAnalytics: "csv", scraper: "none" },
  modules: { carousels: { enabled: false } },
} satisfies AttentionOSConfigInput);
`;

export const BRAND_YAML = `name: Examplebrand Studio
oneLiner: Design-build consulting for small studios
timezone: America/Chicago
`;
