/**
 * Development launcher: loads a workspace the same way `attentionos studio` does, then runs `next dev` with it.
 *   pnpm --filter @attentionos/studio dev -- --workspace ../../../attentionos-demo
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadWorkspace } from "@attentionos/runtime";
import { studioEnv } from "../src/launch.ts";

const args = process.argv.slice(2);
const wsArg = args[args.indexOf("--workspace") + 1];
const root = resolve(args.includes("--workspace") && wsArg ? wsArg : process.env.ATTENTIONOS_WORKSPACE ?? process.cwd());
const port = process.env.PORT ?? "4747";

const ws = await loadWorkspace(root, { providers: false });
const env = { ...process.env, ...studioEnv(ws) };
await ws.close();

const child = spawn("pnpm", ["exec", "next", "dev", "-p", port], { stdio: "inherit", env, cwd: resolve(import.meta.dirname, "..") });
child.on("exit", (code) => process.exit(code ?? 0));
