#!/usr/bin/env bash
# One-command install of the AttentionOS stack on a Docker host (macOS or Linux; Windows inside WSL 2).
#
#   curl -fsSL https://raw.githubusercontent.com/KirthiDiamondJewellery/Marketing/main/deploy/bootstrap.sh | bash
#
# or, from a checkout: deploy/bootstrap.sh. It follows docs/install.md steps 2, 3 and 5:
#   - creates the stack dir ($AOS; default ~/AttentionOS on macOS, /opt/attentionos on Linux)
#   - clones the source into $AOS/src and copies docker-compose.yml, aos and uninstall.sh next to it
#   - writes $AOS/.env with generated secrets (kept as is when it already exists)
#   - on Linux, gives the workspace to uid 1000 (the user inside the container)
#   - builds the image and starts the stack, unless --no-start is given
# Re-running is safe: existing .env, workspace and database are left alone.
#
# Settings (environment variables, all optional):
#   AOS              stack dir
#   AOS_REPO_URL     source repo (default: this fork)      AOS_REPO_BRANCH  branch (default: main)
#   BRAND_NAME       seeds the workspace on first start    PRESET           coach-consultant | agency-founder
#   TZ               IANA timezone (default: the host's)   AOS_PORT         Studio port (default 4747)
#   CLAUDE_CODE_OAUTH_TOKEN  paste a token from `claude setup-token`; otherwise run ./aos claude-login after start
set -euo pipefail

REPO_URL="${AOS_REPO_URL:-https://github.com/KirthiDiamondJewellery/Marketing}"
BRANCH="${AOS_REPO_BRANCH:-main}"
START=1
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required. $2"; }

os="$(uname -s)"
case "$os" in
  Darwin) default_aos="$HOME/AttentionOS" ;;
  Linux) default_aos="/opt/attentionos" ;;
  *) die "unsupported OS: $os. On Windows, run this inside WSL 2 (see docs/install.md)." ;;
esac
AOS="${AOS:-$default_aos}"

say "Checking prerequisites"
need git "Install git first."
need openssl "Install openssl first."
need docker "Install Docker Engine (Linux) or OrbStack/Docker Desktop (macOS): https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose version). Install the compose plugin."
if [ "$START" = 1 ] && ! docker info >/dev/null 2>&1; then
  die "Docker is installed but not reachable. Start it, or add yourself to the docker group (sudo usermod -aG docker \$USER, then log out and in)."
fi
echo "git, openssl and docker compose found. Stack dir: $AOS"

say "Creating the stack dir"
if [ ! -d "$AOS" ]; then
  if mkdir -p "$AOS" 2>/dev/null; then :; else
    echo "Need sudo to create $AOS"
    sudo mkdir -p "$AOS" && sudo chown "$(id -u):$(id -g)" "$AOS"
  fi
fi
[ -w "$AOS" ] || die "$AOS is not writable by $(id -un). Fix with: sudo chown $(id -u):$(id -g) $AOS"
mkdir -p "$AOS/workspace" "$AOS/backups"
chmod 700 "$AOS/backups"
cd "$AOS"

say "Fetching the source ($REPO_URL @ $BRANCH)"
if [ -d src/.git ]; then
  echo "src/ already exists; keeping it. Use ./aos update to refresh it later."
else
  rm -rf src.new
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" src.new
  mv src.new src
fi
cp src/deploy/docker-compose.yml docker-compose.yml
cp src/deploy/aos aos && cp src/deploy/uninstall.sh uninstall.sh
chmod 755 aos uninstall.sh

say "Writing .env"
if [ -f .env ]; then
  echo ".env already exists; keeping it (secrets must not change after the first start)."
else
  host_tz="${TZ:-}"
  if [ -z "$host_tz" ]; then
    if [ -f /etc/timezone ]; then host_tz="$(cat /etc/timezone)";
    elif [ -L /etc/localtime ]; then host_tz="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"; fi
  fi
  host_tz="${host_tz:-America/New_York}"
  pg_pass="$(openssl rand -hex 20)"
  studio_token="$(openssl rand -hex 24)"
  cp src/deploy/.env.example .env
  chmod 600 .env
  # Portable in-place edits (BSD and GNU sed differ on -i): write to a temp file and move it.
  tmp="$(mktemp)"
  sed \
    -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${pg_pass}#" \
    -e "s#^ATTENTIONOS_STUDIO_TOKEN=.*#ATTENTIONOS_STUDIO_TOKEN=${studio_token}#" \
    -e "s#^CLAUDE_CODE_OAUTH_TOKEN=.*#CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}#" \
    -e "s#^PRESET=.*#PRESET=${PRESET:-coach-consultant}#" \
    -e "s#^BRAND_NAME=.*#BRAND_NAME=${BRAND_NAME:-My Brand}#" \
    -e "s#^TZ=.*#TZ=${host_tz}#" \
    -e "s#^AOS_PORT=.*#AOS_PORT=${AOS_PORT:-4747}#" \
    -e "s#^AOS_SRC_DIR=.*#AOS_SRC_DIR=./src#" \
    -e "s#^AOS_REPO_URL=.*#AOS_REPO_URL=${REPO_URL}#" \
    -e "s#^AOS_REPO_BRANCH=.*#AOS_REPO_BRANCH=${BRANCH}#" \
    -e "s#^AOS_STACK_DIR=.*#AOS_STACK_DIR=${AOS}#" \
    .env > "$tmp" && mv "$tmp" .env && chmod 600 .env
  echo "Wrote $AOS/.env (mode 600) with a new database password and Studio access key. Timezone: $host_tz"
fi

if [ "$os" = Linux ]; then
  say "Giving the workspace to uid 1000 (the user inside the container)"
  if [ "$(stat -c %u workspace)" != 1000 ]; then
    if chown -R 1000:1000 workspace 2>/dev/null; then :; else sudo chown -R 1000:1000 workspace; fi
  fi
  echo "workspace/ is owned by uid 1000."
fi

if [ "$START" = 0 ]; then
  say "Prepared without starting (--no-start)."
  echo "Next: cd $AOS && docker compose build --pull attentionos && docker compose up -d --remove-orphans --wait --wait-timeout 900"
  exit 0
fi

say "Building the image (5 to 15 minutes the first time)"
docker compose build --pull attentionos

say "Starting the stack"
docker compose up -d --remove-orphans --wait --wait-timeout 900

say "Done"
./aos status || true
cat <<EOF

Next steps
  1. Connect Claude (opens a browser, or prints a link on a headless server):   cd $AOS && ./aos claude-login
  2. Open Studio:   http://localhost:$( { grep '^AOS_PORT=' .env | cut -d= -f2; } || echo 4747 )
     On a remote server, first run on your laptop:   ssh -L 4747:127.0.0.1:4747 user@your-server
  3. Studio starts on onboarding: your website and handles, provider keys (Apify, Zernio), competitors.
  4. Check the setup any time:   ./aos doctor      Logs:   ./aos logs      Backups:   ./aos backup
EOF
