#!/usr/bin/env bash
# The Codex bridge for development: headless, with localhost pages allowed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
port="${GESTALTS_CODEX_BRIDGE_PORT:-7739}"
exec cargo run -q -p gestalts-codex-bridge -- serve --dev --profile dev --port "$port"
