/**
 * Writes the JSON Schemas generated from the zod sources:
 * - media-py/src/attentionos_media/schemas/edit-plan.schema.json (the Python sidecar validates plans against it)
 * - templates/formats/format.schema.json
 * Run: pnpm --filter @attentionos/media export-schema   (a test fails when the committed files are stale).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { editPlanJsonSchema, formatJsonSchema } from "../src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
export const SCHEMA_TARGETS = {
  editPlan: resolve(root, "media-py/src/attentionos_media/schemas/edit-plan.schema.json"),
  format: resolve(root, "templates/formats/format.schema.json"),
};

export function renderSchemas(): Record<keyof typeof SCHEMA_TARGETS, string> {
  return {
    editPlan: JSON.stringify(editPlanJsonSchema(), null, 2) + "\n",
    format: JSON.stringify(formatJsonSchema(), null, 2) + "\n",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const out = renderSchemas();
  for (const [k, path] of Object.entries(SCHEMA_TARGETS)) {
    writeFileSync(path, out[k as keyof typeof SCHEMA_TARGETS]);
    console.log(`wrote ${path.slice(root.length + 1)}`);
  }
}
