#!/usr/bin/env bash
# Removes AttentionOS from this computer or server. Run it from the AttentionOS folder: ./uninstall.sh
#
# By default it stops and removes the containers, the image and the nightly backup job, and KEEPS your data:
# the workspace folder, the database volume and backups/. It asks before deleting any of those.
#
#   ./uninstall.sh            stop and remove AttentionOS, keep your data
#   ./uninstall.sh --purge    also delete the database, caches and this folder (asks; your workspace is kept
#                             unless you say so too)
#   ASSUME_YES=1              answer yes to every question (careful)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin:/Applications/Docker.app/Contents/Resources/bin"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

say() { printf '%s\n' "$*"; }
ask() { # ask "question" -> 0 for yes
  [ "${ASSUME_YES:-}" = "1" ] && return 0
  local a; read -r -p "$1 [y/N] " a </dev/tty || a=""
  [ "$a" = "y" ] || [ "$a" = "Y" ] || [ "$a" = "yes" ]
}
env_get() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -1 | sed 's/^"\(.*\)"$/\1/'; }

[ -f docker-compose.yml ] || { say "No AttentionOS install in $DIR."; exit 1; }
DOCKER=(docker)
if ! docker info >/dev/null 2>&1 && [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" != "0" ]; then DOCKER=(sudo docker); fi

project="$(env_get AOS_PROJECT)"; project="${project:-attentionos}"
image="$(env_get AOS_IMAGE)"; image="${image:-attentionos:local}"
ws="$(env_get WORKSPACE_DIR)"; ws="${ws:-./workspace}"
case "$ws" in /*) ;; *) ws="$DIR/${ws#./}" ;; esac

say "Removing AttentionOS from $DIR"
if [ "$PURGE" = "1" ] && ask "Delete the database (posts, metrics, approvals) and caches? A backup is in $DIR/backups if you made one."; then
  "${DOCKER[@]}" compose down --volumes --remove-orphans
  say "  Containers, database and caches removed."
else
  "${DOCKER[@]}" compose down --remove-orphans
  say "  Containers removed. The database is kept (Docker volume ${project}_postgres-data)."
fi
"${DOCKER[@]}" image rm "$image" >/dev/null 2>&1 && say "  Image $image removed." || true

# The nightly backup job.
if [ "$(uname -s)" = "Darwin" ]; then
  plist="$HOME/Library/LaunchAgents/ai.attentionos.backup.$project.plist"
  if [ -f "$plist" ]; then
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    rm -f "$plist"
    say "  Nightly backup job removed."
  fi
elif crontab -l 2>/dev/null | grep -q "AttentionOS backup ($DIR)"; then
  # The tagged job (installed by Ansible: a "#Ansible:" comment line, then the job) or a hand-added line carrying the tag.
  crontab -l 2>/dev/null | awk -v tag="AttentionOS backup ($DIR)" '$0 == "#Ansible: " tag { skip = 1; next } skip { skip = 0; next } index($0, tag) { next } { print }' | crontab -
  say "  Nightly backup job removed."
fi

if [ "$PURGE" = "1" ]; then
  if ask "Delete your workspace folder $ws (Brand Kit, settings, lessons, media)? This can't be undone."; then
    rm -rf "$ws"
    say "  Workspace deleted."
  else
    say "  Workspace kept: $ws"
  fi
  if ask "Delete $DIR (settings, source and backups)?"; then
    case "$ws" in "$DIR"/*) [ -d "$ws" ] && { say "  Keeping $DIR because your workspace is inside it."; exit 0; } ;; esac
    cd / && rm -rf "$DIR"
    say "  $DIR deleted."
  fi
else
  say ""
  say "Kept: your workspace ($ws), backups ($DIR/backups), settings ($DIR/.env) and the database volume."
  say "To delete those too: ./uninstall.sh --purge"
fi
say "Done."
