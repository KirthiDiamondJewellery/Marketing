/**
 * What `import { defineConfig } from "attentionos/config"` resolves to while the runtime loads a workspace config.
 * Self-contained on purpose: it is aliased in by path, so the config loads even when the workspace has no
 * node_modules. Type-only imports from the same specifier are erased before this runs.
 */
export function defineConfig<T>(config: T): T {
  return config;
}

export default defineConfig;
