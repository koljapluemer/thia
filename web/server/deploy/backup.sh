#!/usr/bin/env bash
# Nightly (cron, as root): the database as a consistent copy, and the data folder, to EU object storage with restic.
# Needs RESTIC_REPOSITORY, RESTIC_PASSWORD and the storage's credentials in /etc/thia-server-backup.env.
set -euo pipefail
set -a; . /etc/thia-server-backup.env; set +a
data=/var/lib/thia-server
sqlite3 "$data/thia.db" ".backup '$data/thia.db.backup'"
# The OPAQUE setup belongs in a separate restricted backup.
restic backup \
  --exclude "$data/thia.db" \
  --exclude "$data/thia.db-wal" \
  --exclude "$data/thia.db-shm" \
  --exclude "$data/npm-cache" \
  --exclude "$data/opaque-setup-v1" \
  "$data"
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
