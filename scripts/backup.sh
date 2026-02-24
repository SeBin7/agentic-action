#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DB="${RUNTIME_DB_PATH:-$REPO_ROOT/data/runtime_db.json}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/data/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$SRC_DB" ]]; then
  echo "[backup] source db not found: $SRC_DB" >&2
  exit 1
fi

DEST_DB="$BACKUP_DIR/runtime_db_${STAMP}.json"
cp "$SRC_DB" "$DEST_DB"

echo "[backup] created=$DEST_DB"
