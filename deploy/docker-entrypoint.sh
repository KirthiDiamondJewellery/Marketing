#!/bin/sh
# Starts AttentionOS inside the container:
#   1. waits for the database,
#   2. creates your workspace in /workspace on the first run (from the preset in PRESET),
#   3. applies database updates (`attentionos db push`),
#   4. runs Studio + the Autopilot worker (`attentionos up`).
#
# Any other command runs as is: `docker compose run --rm attentionos attentionos doctor`, `... bash`.
set -eu

if [ "${1:-up}" != "up" ]; then
  exec "$@"
fi

say() { printf '[attentionos] %s\n' "$*"; }
die() { printf '[attentionos] %s\n' "$*" >&2; exit 1; }

WORKSPACE=/workspace
HOST="${ATTENTIONOS_HOST:-0.0.0.0}"
PORT="${ATTENTIONOS_PORT:-4747}"

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL isn't set. Start AttentionOS with docker compose (deploy/docker-compose.yml), which sets it."
[ -w "$WORKSPACE" ] || die "Can't write to the workspace folder (mounted at $WORKSPACE). On Linux, give it to user 1000: sudo chown -R 1000:1000 <your workspace folder>"

# 1. Database: wait until Postgres accepts connections (compose also waits for its health check).
say "Waiting for the database…"
node -e '
const net = require("node:net");
const u = new URL(process.env.DATABASE_URL);
const host = u.hostname, port = Number(u.port || 5432), until = Date.now() + 180000;
(function attempt() {
  const s = net.connect(port, host);
  s.once("connect", () => { s.end(); process.exit(0); });
  s.once("error", () => {
    s.destroy();
    if (Date.now() > until) { console.error("[attentionos] The database at " + host + ":" + port + " did not answer within 3 minutes."); process.exit(1); }
    setTimeout(attempt, 1000);
  });
})();
'

# 2. Workspace: create it on the first run. Your files live on the host, so they're editable and git-able.
cd "$WORKSPACE"
if [ ! -f "$WORKSPACE/config/attentionos.config.ts" ]; then
  preset="${ATTENTIONOS_PRESET:-coach-consultant}"
  say "First run: creating your workspace (preset $preset)…"
  tmp="$(mktemp -d)/workspace"
  set -- create "$tmp" --preset "$preset" --name "${ATTENTIONOS_BRAND_NAME:-My Brand}"
  if [ -n "${TZ:-}" ]; then set -- "$@" --timezone "$TZ"; fi
  attentionos "$@" >/dev/null
  # Copy without overwriting anything already in the folder (a stray .DS_Store, files you put there first).
  cp -Rn "$tmp"/. "$WORKSPACE"/
  rm -rf "$(dirname "$tmp")"
  say "Workspace created. Studio walks you through the rest of setup."
fi
# The workspace .env holds your service keys: keep it private.
if [ -f "$WORKSPACE/.env" ]; then chmod 600 "$WORKSPACE/.env" 2>/dev/null || true; fi

# Claude Code reaches your data through the AttentionOS MCP server. The database is private to this stack, so the
# workspace's .mcp.json starts that server in here: directly when Claude Code runs in this container (./aos claude),
# through `docker compose exec` when you open the workspace in Claude Code on your computer. Other servers you added
# to .mcp.json are kept. Needs the stack folder's path on the host (AOS_STACK_DIR in its .env).
if [ -n "${ATTENTIONOS_HOST_STACK_DIR:-}" ]; then
  node /usr/local/lib/attentionos/write-mcp-config.cjs \
    || say "Couldn't update .mcp.json in your workspace, so Claude Code on your computer may not reach your data."
fi

# 3. Database updates (safe to run every start). Retry briefly while Postgres finishes starting.
i=0
until attentionos db push; do
  i=$((i + 1))
  [ "$i" -lt 10 ] || die "Couldn't apply the database updates. See the messages above."
  say "Database not ready yet, retrying in 3 seconds…"
  sleep 3
done

# Say plainly whether Claude is signed in: your agents need it for AI work.
if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  say "Claude is signed in: your agents run on your own Claude plan."
else
  say "Claude isn't signed in yet, so AI work (chat, Run now, Autopilot) won't run."
  say "Fix: on your computer run ./aos claude-login (or put CLAUDE_CODE_OAUTH_TOKEN in the stack's .env), then ./aos restart."
fi

# Models: download the speech, face and embedding models in the background the first time (they land in the
# cache volume, so this happens once). Editing and search also fetch them on first use if this hasn't finished.
media() { uv run --no-sync --project "${ATTENTIONOS_MEDIA_PY_DIR}" attentionos-media "$@"; }
( for m in default embed; do
    echo "{\"name\": \"$m\"}" | media models download >/dev/null 2>&1 || true
  done
  say "Speech and search models are ready."
) &

# 4. Studio + worker. Inside the container 0.0.0.0 is the container's own network: compose publishes it to
# 127.0.0.1 on your computer only; a compose override may bind it to 127.0.0.1 here behind a proxy instead.
# ATTENTIONOS_STUDIO_AUTH (local | tailscale | token) decides whether Studio asks for a sign-in.
exec attentionos up --host "$HOST" --port "$PORT" --allow-public
