#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[deploy] start at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -f package-lock.json ]]; then
  echo "[deploy] package-lock.json missing; npm ci requires lockfile" >&2
  exit 1
fi

npm ci
npm run test:api
npm run ui:build

if [[ ! -f data/runtime_db.json ]]; then
  mkdir -p data
  node --input-type=module -e "import { RuntimeRepository } from './src/db/repository.js'; const repo = new RuntimeRepository({ dbPath: 'data/runtime_db.json', logger: null }); repo.close();"
fi

npm run smoke:api

echo "[deploy] success at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
