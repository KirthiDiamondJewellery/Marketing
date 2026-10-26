#!/usr/bin/env bash
# AttentionOS backup: a pg_dump of the database and a tarball of the workspace into <stack dir>/backups/.
#
#   ./aos backup                     run it now, from the stack dir
#   AOS_BACKUP_KEEP_DAYS=14          days of backups to keep (default 14)
#   AOS_BACKUP_MEDIA=1               include the workspace's media/ folder (large; off by default)
#
# Schedule it with cron or launchd: docs/install.md#backups. Restore: docs/deploy/server.md (Backups).
set -euo pipefail
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin:/Applications/Docker.app/Contents/Resources/bin"
cd "${AOS_STACK_DIR:-$PWD}"
[ -f .env ] && [ -f docker-compose.yml ] || { echo "backup: run this from the stack dir (where .env is)" >&2; exit 1; }
umask 077
mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
keep="${AOS_BACKUP_KEEP_DAYS:-14}"

DOCKER=(docker)
if ! docker info >/dev/null 2>&1 && [ "$(id -u)" != "0" ] && sudo -n docker info >/dev/null 2>&1; then DOCKER=(sudo -n docker); fi

ws="$(sed -n 's/^WORKSPACE_DIR=//p' .env | tail -1 | tr -d '"')"
ws="${ws:-./workspace}"
case "$ws" in /*) ;; *) ws="$PWD/${ws#./}" ;; esac

# 1. The database, in pg_dump's custom format (restore with pg_restore).
"${DOCKER[@]}" compose exec -T postgres pg_dump -U attentionos -d attentionos -Fc > "backups/db-$stamp.dump.partial"
mv "backups/db-$stamp.dump.partial" "backups/db-$stamp.dump"

# 2. The workspace.
excludes=(--exclude='./media' --exclude='media/*')
[ "${AOS_BACKUP_MEDIA:-}" = "1" ] && excludes=()
tar -czf "backups/workspace-$stamp.tar.gz.partial" ${excludes[@]+"${excludes[@]}"} -C "$ws" .
mv "backups/workspace-$stamp.tar.gz.partial" "backups/workspace-$stamp.tar.gz"

# 3. Prune.
find backups -maxdepth 1 \( -name 'db-*.dump' -o -name 'workspace-*.tar.gz' -o -name '*.partial' \) -mtime +"$((keep - 1))" -delete

echo "$(date '+%Y-%m-%d %H:%M') Backed up to $PWD/backups: db-$stamp.dump, workspace-$stamp.tar.gz"
