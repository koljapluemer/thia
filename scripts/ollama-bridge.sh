#!/usr/bin/env bash
# The Ollama bridge for development (`mise run ollama-bridge`, installables/ollama-bridge, experimental): headless,
# with the dev profile (its own allowed sites), and pages on localhost may use it without asking.
#   GESTALTS_OLLAMA_BRIDGE_PORT   default 7738
#   GESTALTS_OLLAMA_HOST, GESTALTS_OLLAMA_MODEL, GESTALTS_OLLAMA_CTX: see installables/ollama-bridge/README.md
# It needs Ollama running, with the model pulled; the web app's pages bring everything else.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${GESTALTS_OLLAMA_BRIDGE_PORT:-7738}"
# from the repo root, so rustup picks up its rust-toolchain.toml
cd "$root"
exec cargo run -q -p gestalts-ollama-bridge -- serve --dev --profile dev --port "$port"
