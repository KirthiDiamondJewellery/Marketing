#!/usr/bin/env bash
# Serialises pnpm installs when several contributors/agents work in this monorepo at once.
# Usage: scripts/pnpm-locked.sh add zod --filter @attentionos/core
set -euo pipefail
LOCK="${TMPDIR:-/tmp}/attentionos-pnpm.lock"
for _ in $(seq 1 600); do
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK"' EXIT
    pnpm "$@"
    exit $?
  fi
  sleep 1
done
echo "timed out waiting for $LOCK" >&2
exit 1
