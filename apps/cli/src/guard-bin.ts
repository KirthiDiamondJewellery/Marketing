#!/usr/bin/env node
import { runGuard } from "@attentionos/guardrails";

// The copy guard runs inside a Claude Code hook: if the guard itself breaks, never block the write.
try {
  process.exitCode = await runGuard(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`attentionos-guard: ${(err as Error).message}\n`);
  process.exitCode = 0;
}
