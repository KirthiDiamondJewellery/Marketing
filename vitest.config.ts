import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages,modules}/**/test/**/*.test.ts", "packages/providers/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    testTimeout: 20_000,
    // Integration suites create and migrate their own databases in beforeAll; give that room on a busy machine.
    hookTimeout: 60_000,
  },
});
