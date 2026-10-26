#!/usr/bin/env node
// Copy guard CLI. Runs the TypeScript source directly (Node 22.18+ strips types natively;
// on older Node it falls back to tsx when available). See src/cli/guard.ts for usage.
let mod;
try {
  mod = await import("../src/cli/guard.ts");
} catch (err) {
  try {
    await import("tsx/esm");
    mod = await import("../src/cli/guard.ts");
  } catch {
    process.stderr.write(`attentionos-guard: can't load the TypeScript source (${err?.message ?? err}). Use Node 22.18 or newer.\n`);
    process.exit(0); // never block a write because the guard itself failed to start
  }
}
process.exitCode = await mod.runGuard(process.argv.slice(2));
