import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  // Standalone output is what `attentionos studio` ships and serves (the CLI build copies it into dist/assets/studio).
  output: "standalone",
  // Trace from the monorepo root so the workspace packages Studio imports land in the standalone output.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // Lets several dev servers run side by side (NEXT_DIST_DIR=.next-s1 PORT=4751 pnpm dev).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@attentionos/core", "@attentionos/db", "@attentionos/module-onboarding", "@attentionos/module-production", "@attentionos/module-publishing", "@attentionos/module-trial-reels", "@attentionos/module-learn", "@attentionos/scoring"],
  // Loaded at runtime from node_modules (jiti reads the workspace's TypeScript config for Settings).
  serverExternalPackages: ["postgres", "jiti"],
  // The published package runs on any OS, so don't ship sharp's platform binaries; Studio's images are served as is.
  images: { unoptimized: true },
  outputFileTracingExcludes: { "/*": ["**/node_modules/sharp/**", "**/node_modules/@img/**", "**/*.tsbuildinfo"] },
  // `pnpm check` typechecks Studio; the packaging build may skip it to save time (ATTENTIONOS_STUDIO_SKIP_TYPECHECK=1).
  typescript: { ignoreBuildErrors: process.env.ATTENTIONOS_STUDIO_SKIP_TYPECHECK === "1" },
};

export default config;
