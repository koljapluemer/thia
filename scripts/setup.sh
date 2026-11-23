#!/usr/bin/env bash
# `mise run just setup`: a new dev machine ready for `mise run just dev`, and again whenever things moved (pulled
# changes, a new tool version). Safe to run any time.
#   - the tools mise pins (Node, pnpm, uv, wasm-pack, packaging tools) and the Rust toolchain rust-toolchain.toml pins
#   - JS dependencies, the core compiled to wasm, the agent template (mise run setup)
#   - the Rust binaries `just dev` runs, built once so its first start isn't a long wait
#   - a local account, the first time (server-data/, kept out of git), which is an admin (reviews submissions)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

step() { printf '\n== %s\n' "$*"; }

missing=()
command -v rustup > /dev/null || missing+=("rustup (https://rustup.rs)")
command -v python3 > /dev/null || missing+=("python3")
if ((${#missing[@]})); then
  printf 'Install first: %s\n' "${missing[@]}" >&2
  exit 1
fi

step "tools (mise.toml)"
mise install

step "Rust (rust-toolchain.toml)"
# rustup ≥ 1.28 installs the pinned toolchain on request; older ones on first use
rustup toolchain install 2> /dev/null || rustup show active-toolchain

step "dependencies, the core in wasm, the agent template"
# a fresh mise, so it has the tools just installed
mise run setup

step "the Rust binaries"
cargo build -q -p gestalts-node-desktop -p gestalts-claude-bridge -p thia-server

admin() { cargo run -q -p thia-server -- --data server-data admin "$@"; }
if [[ ! -e server-data/dev-login.txt ]]; then
  # the workshop is behind a login: on a dev machine, this account's
  step "the local account (dev@localhost)"
  if ! password="$(admin reset-password --email dev@localhost 2> /dev/null)"; then
    school="$(admin add-school "Dev school")"
    password="$(admin add-account --school "$school" --email dev@localhost --admin --maintainer)"
  fi
  printf 'email: dev@localhost\npassword: %s\n' "$password" > server-data/dev-login.txt
  echo "sign in to the workshop with dev@localhost, password in server-data/dev-login.txt"
fi
# the local account reviews submissions for the public site (/review) and makes what it ships, also one made before
if [[ -e server-data/dev-login.txt ]]; then admin grant-admin dev@localhost && admin grant-maintainer dev@localhost; fi

step "optional"
command -v claude > /dev/null || echo "no claude CLI: the workshop's local agent needs it, and it's the only one that builds visualizations (https://claude.com/claude-code)"
[[ -n "${ANTHROPIC_API_KEY:-}" ]] || echo "no ANTHROPIC_API_KEY: the server's own agent stays off in just dev (the local CLI agent works without it)"

printf '\nReady: mise run just dev\n'
