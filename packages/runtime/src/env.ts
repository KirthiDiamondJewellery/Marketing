import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Reads `<root>/.env` (workspace-local, never committed). Missing file = no values. */
export function readDotenv(root: string): Record<string, string> {
  const path = join(root, ".env");
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, "utf8"));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Secret lookup: the real environment wins over `.env`, so a VPS or CI can inject values without editing files.
 * Empty strings count as unset.
 */
export function createSecrets(dotenv: Record<string, string>, env: NodeJS.ProcessEnv = process.env): (name: string) => string | undefined {
  return (name) => {
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromFile = dotenv[name];
    return fromFile !== undefined && fromFile !== "" ? fromFile : undefined;
  };
}
