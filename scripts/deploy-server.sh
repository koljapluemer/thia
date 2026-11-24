#!/usr/bin/env bash
# Ships the server and the apps to the box at $THIA_HOST (ssh, as root), from a clean, committed tree, so what runs is
# a commit: the server built here, the use app (web/site, also the lessons' player) and the make app (web/app, under
# /make/ beside it) built here, and the parts of the checkout the worker and the
# agent read (web/server/worker, packages/), whose npm dependencies are installed there. The box's setup is in
# web/server/deploy/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${THIA_HOST:?set THIA_HOST to the box, e.g. root@lehrer.example.de}"
# the app's URL, for the site's canonical links and sitemap; without it the pages have neither
: "${THIA_PUBLIC_URL:=}"

if [ -n "$(git status --porcelain)" ]; then
  echo "uncommitted changes: commit first, so the deploy is a commit" >&2; exit 1
fi
if ssh "$THIA_HOST" test -e /var/lib/gestalts-teacher; then
  echo "the box still has the server under its old name (gestalts-teacher): move it first (web/server/deploy/README.md, Moving from gestalts-teacher)" >&2; exit 1
fi
sha="$(git rev-parse --short HEAD)"
release="/opt/thia-server/releases/$sha"
export GESTALTS_GIT_COMMIT="$(git rev-parse HEAD)" GESTALTS_GIT_DIRTY=false GESTALTS_BUILD="$sha"

cargo build --release -q -p thia-server
pnpm --dir web/app build
VITE_PUBLIC_URL="$THIA_PUBLIC_URL" pnpm --dir web/site build

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar HEAD web/server/worker web/server/package.json packages gestalts package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json | tar -x -C "$tmp"
# what the check records about the runtime's types (packages/check/pack, made by `mise run setup`), not in git
cp -r packages/check/pack "$tmp/packages/check/"
mkdir -p "$tmp/bin" "$tmp/player"
cp target/release/thia-server "$tmp/bin/"
# what the app's domain serves: the use app, and the make app under /make/
mkdir -p "$tmp/web"
cp -r web/site/dist/. "$tmp/web/"
cp -r web/app/dist "$tmp/web/make"
cp -r web/site/dist/. "$tmp/player/"

ssh "$THIA_HOST" "mkdir -p $release"
tar -C "$tmp" -c . | ssh "$THIA_HOST" "tar -x -C $release"
ssh "$THIA_HOST" bash -s <<REMOTE
set -euo pipefail
cd $release
# only what the worker needs, from the lockfile
pnpm install --frozen-lockfile --filter server... >/dev/null
pnpm -C packages/workshop/agent-template install --ignore-workspace --frozen-lockfile >/dev/null
chown -R thia: $release
sudo -u thia bin/thia-server --data /var/lib/thia-server admin install-player --dist player
ln -sfn $release /opt/thia-server/current
systemctl restart thia-server
systemctl reload caddy
REMOTE
echo "deployed $sha to $THIA_HOST"
