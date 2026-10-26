// Points the workspace's .mcp.json at the AttentionOS MCP server inside the Docker stack (run by the entrypoint).
//
// The database is private to the stack, so Claude Code reaches your data through the MCP server in the container:
// directly when Claude Code runs in the container (`./aos claude`), through `docker compose exec` when you open the
// workspace in Claude Code on your computer. Other servers in .mcp.json are kept; the file is only rewritten when
// something changed.
//
// Env: ATTENTIONOS_HOST_STACK_DIR (the stack folder on the host), ATTENTIONOS_SERVICE (compose service name),
// ATTENTIONOS_MCP_FILE (default /workspace/.mcp.json).
const fs = require("node:fs");

const file = process.env.ATTENTIONOS_MCP_FILE || "/workspace/.mcp.json";
const stackDir = (process.env.ATTENTIONOS_HOST_STACK_DIR || "").replace(/\/+$/, "");
const service = process.env.ATTENTIONOS_SERVICE || "attentionos";
if (!stackDir) process.exit(0);

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const script = [
  'if [ "$ATTENTIONOS_CONTAINER" = 1 ]; then exec attentionos mcp; fi',
  'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin:/Applications/Docker.app/Contents/Resources/bin"',
  `exec docker compose -f ${shQuote(`${stackDir}/docker-compose.yml`)} exec -T ${service} attentionos mcp`,
].join("; ");

let before = "";
let cfg = {};
try {
  before = fs.readFileSync(file, "utf8");
  cfg = JSON.parse(before);
} catch {
  // missing or not JSON: start fresh
}
if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};
cfg.mcpServers = { ...(cfg.mcpServers || {}), attentionos: { command: "sh", args: ["-c", script], env: {} } };
const after = `${JSON.stringify(cfg, null, 2)}\n`;
if (after !== before) fs.writeFileSync(file, after);
