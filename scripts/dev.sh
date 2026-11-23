#!/usr/bin/env bash
# `mise run just dev`: everything for development at once, with hot reload, stopped together (Ctrl-C, or when any of
# it exits):
#   - the web app (web/app): notes on the home store in the browser, the workshop, the review
#   - the public site (web/site): the learning views, visualizations and accepted workshop results
#   - the Claude bridge (scripts/claude-bridge.sh): runs the agents (the claude CLI), with the pages' tools: the
#     workshop's
#   - the Ollama bridge (scripts/ollama-bridge.sh, experimental): the same, with a local Ollama model
#   - folder-sync, headless (scripts/node.sh): the plugin backends, /net and /llm for the home areas
#   - the server (server-data/; its agent with ANTHROPIC_API_KEY), with the site's build to play lessons, and
#     accepting reviewed submissions into this checkout
# Each server gets the first free port from its usual one (scripts/free-port.sh), so it runs beside an installed node
# (7717/7718) and whatever else listens here. What they print goes to target/dev/<name>.log; this shows one overview,
# updated as they come up, and the end of the log of one that stops.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
logs="target/dev"
mkdir -p "$logs"

tty=false
[[ -t 1 ]] && tty=true
if $tty && [[ -z "${NO_COLOR:-}" ]]; then
  B=$'\e[1m' D=$'\e[2m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' C=$'\e[36m' N=$'\e[0m'
else
  B='' D='' G='' Y='' R='' C='' N=''
fi
# clears the rest of a line, where lines are redrawn
K=''
$tty && K=$'\e[K'

taken=()
# take VAR START [COUNT]: a free port (COUNT in a row) not handed out yet
take() {
  local p i
  p="$(scripts/free-port.sh "$2" "${3:-1}" ${taken[@]+"${taken[@]}"})"
  for ((i = 0; i < ${3:-1}; i++)); do taken+=($((p + i))); done
  printf -v "$1" '%s' "$p"
}
take bridge 7737
take ollamabridge 7738
# the node in a step of two: the port after it is its home-network port. Clear of an installed node on 7717
take node 7727 2
take serverapi 7740 2
take web 5173
take site 5177
serverlessons=$((serverapi + 1))

# prepare LABEL CMD...: CMD with its output in target/dev/prepare.log; on failure, the end of it
: > "$logs/prepare.log"
prepare() {
  local label="$1"; shift
  $tty && printf '  %s%s…%s\r' "$D" "$label" "$N"
  if ! "$@" >> "$logs/prepare.log" 2>&1; then
    printf '  %s✗ %s%s%s\n\n' "$R" "$label" "$N" "$K"
    tail -n 30 "$logs/prepare.log" | sed 's/^/    /'
    printf '\n  %sall of it: %s%s\n' "$D" "$logs/prepare.log" "$N"
    exit 1
  fi
  $tty && printf '%s' "$K"
  return 0
}
# dependencies, the wasm core and the agent template up to date (after a pull)
prepare "dependencies" mise run setup
# the binaries once, so the node and the server don't wait on each other's cargo
prepare "Rust binaries" cargo build -q -p gestalts-node-desktop -p gestalts-claude-bridge -p gestalts-ollama-bridge -p thia-server
# the server plays lessons with the site built from here
prepare "the site" pnpm --dir web/site build
prepare "the site, installed as the lessons' player" cargo run -q -p thia-server -- --data server-data admin install-player --dist web/site/dist

trap 'kill 0' EXIT

ids=() names=() urls=() ports=() notes=() pids=() groups=()
# serve GROUP ID NAME URL PORT NOTE CMD...: CMD in the background, its output in target/dev/ID.log; it's up once
# something listens on PORT
serve() {
  groups+=("$1") ids+=("$2") names+=("$3") urls+=("$4") ports+=("$5") notes+=("$6")
  local log="$logs/$2.log"
  shift 6
  "$@" > "$log" 2>&1 &
  pids+=($!)
}

serve servers bridge "Claude bridge" "http://127.0.0.1:$bridge" "$bridge" "the agents: claude, with the pages' tools" \
  env GESTALTS_BRIDGE_PORT="$bridge" scripts/claude-bridge.sh
serve servers ollamabridge "Ollama bridge" "http://127.0.0.1:$ollamabridge" "$ollamabridge" "experimental: a local model, with the pages' tools" \
  env GESTALTS_OLLAMA_BRIDGE_PORT="$ollamabridge" scripts/ollama-bridge.sh
serve servers node "folder-sync" "http://127.0.0.1:$node" "$node" "plugin backends, /net, /llm · dev profile" \
  env GESTALTS_NODE_PORT="$node" scripts/node.sh
servernote="API · lessons on :$serverlessons"
[[ -n "${ANTHROPIC_API_KEY:-}" ]] || servernote+=" · $N${Y}its agent is off without ANTHROPIC_API_KEY"
serve servers serverapi "server" "http://127.0.0.1:$serverapi" "$serverapi" "$servernote" \
  env THIA_LESSON_ORIGIN="http://127.0.0.1:$serverlessons" cargo run -q -p thia-server -- --data server-data \
  serve --insecure-cookies --app "127.0.0.1:$serverapi" --lessons "127.0.0.1:$serverlessons" --promote-into .

if [[ -e server-data/dev-login.txt ]]; then login="lessons sign-in: server-data/dev-login.txt"
else login="lessons sign-in: your account, or mise run server:admin add-account / reset-password"; fi
serve apps web "web app" "http://localhost:$web/" "$web" "$login" \
  env VITE_GESTALTS_NODE="http://127.0.0.1:$node" VITE_AGENT_NODE="http://127.0.0.1:$bridge" \
  VITE_OLLAMA_NODE="http://127.0.0.1:$ollamabridge" \
  VITE_THIA_API="http://127.0.0.1:$serverapi" VITE_SITE="http://localhost:$site/" pnpm --dir web/app dev --port "$web" --strictPort
serve apps site "public site" "http://localhost:$site/" "$site" "what's accepted shows here once it's in plugins/" \
  env VITE_LESSONS="http://127.0.0.1:$serverlessons" pnpm --dir web/site dev --port "$site" --strictPort

listening() { (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null || (exec 3<> "/dev/tcp/::1/$1") 2> /dev/null; }

# the overview into `out`; `waiting`: how many aren't up yet, `stopped`: the index of one that stopped, or -1
overview() {
  local i group mark
  waiting=0 stopped=-1 out=''
  for group in apps servers; do
    if [[ $group == apps ]]; then out+="  ${B}App${N}$K"$'\n'; else out+="$K"$'\n'"  ${B}Servers${N}$K"$'\n'; fi
    for i in "${!ids[@]}"; do
      [[ ${groups[$i]} == "$group" ]] || continue
      if ! kill -0 "${pids[$i]}" 2> /dev/null; then mark="$R✗$N"; stopped=$i
      elif listening "${ports[$i]}"; then mark="$G✓$N"
      else mark="$Y…$N"; waiting=$((waiting + 1)); fi
      out+="$(printf '  %s %s%-19s%s %s%-24s%s %s%s%s' "$mark" "$B" "${names[$i]}" "$N" "$C" "${urls[$i]}" "$N" "$D" "${notes[$i]}" "$N")$K"$'\n'
    done
  done
  out+="$K"$'\n'
}

stopped_report() {
  printf '  %s%s stopped%s, so everything stops. The end of %s:\n\n' "$R" "${names[$1]}" "$N" "$logs/${ids[$1]}.log"
  tail -n 30 "$logs/${ids[$1]}.log" | sed 's/^/    /'
  echo
}

printf '\n  %sgestalts dev%s  %slogs in %s/<name>.log · Ctrl-C stops everything%s\n\n' "$B" "$N" "$D" "$logs" "$N"
# redrawn in place while they start; without a terminal, printed once they're up
lines=0
started=$SECONDS
while :; do
  overview
  if $tty; then
    ((lines)) && printf '\e[%dA' "$lines"
    printf '%s' "$out"
    lines=$(printf '%s' "$out" | wc -l)
  fi
  ((stopped < 0 && waiting > 0 && SECONDS - started < 180)) || break
  sleep 1
done
$tty || printf '%s' "$out"
if ((stopped >= 0)); then stopped_report "$stopped"; exit 1; fi
if ((waiting)); then printf '  %s%d not answering after 3 minutes: see their logs%s\n\n' "$Y" "$waiting" "$N"; fi

# stop all when one stops (macOS' bash 3.2 has no `wait -n`: there, when all have)
if ((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 403)); then wait -n || true; else wait || true; fi
for i in "${!ids[@]}"; do
  if ! kill -0 "${pids[$i]}" 2> /dev/null; then stopped_report "$i"; break; fi
done
exit 1
