#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DB="${RUNTIME_DB_PATH:-$REPO_ROOT/data/runtime_db.json}"
SOURCE_PATH="${1:-}"

if [[ -z "$SOURCE_PATH" ]]; then
  echo "usage: bash scripts/restore.sh <backup_db_path>" >&2
  exit 2
fi

if [[ ! -f "$SOURCE_PATH" ]]; then
  echo "[restore] backup file not found: $SOURCE_PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET_DB")"
cp "$SOURCE_PATH" "$TARGET_DB"

echo "[restore] restored=$TARGET_DB from=$SOURCE_PATH"
