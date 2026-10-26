/**
 * `import { defineConfig } from "attentionos/config"` in a workspace's `config/attentionos.config.ts`.
 * When the CLI loads a config it aliases this specifier to a tiny shim, so this module only matters for editors
 * and type checking in the workspace.
 */
export { defineConfig, configSchema, parseConfig } from "@attentionos/core";
export type { AttentionOSConfig, AttentionOSConfigInput } from "@attentionos/core";
