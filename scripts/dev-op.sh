#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v op >/dev/null 2>&1; then
  echo "1Password CLI (op) not found in PATH." >&2
  exit 1
fi

exec op run --env-file=.env -- npm run dev
