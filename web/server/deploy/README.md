# Deploying the server

One EU box (Hetzner or the like) runs `thia-server` behind Caddy, for two domains: the app (accounts, `/api`)
and the lesson domain (students). `scripts/deploy-server.sh` ships a release; this is the box's one-time setup.

On the box (Debian/Ubuntu), as root:

1. Caddy, Node 26 with pnpm (`corepack enable`), `sqlite3` and `restic`.
2. A user and folders: `useradd --system --home /var/lib/thia-server thia`, `mkdir -p /opt/thia-server/releases /var/lib/thia-server`, `chown -R thia: /opt/thia-server /var/lib/thia-server`.
3. `/etc/thia-server.env` (mode 600): `THIA_LESSON_ORIGIN=https://<lesson domain>` and `THIA_BETA_CODE=<random shared secret>`.
4. `Caddyfile` here to `/etc/caddy/Caddyfile`, with the two domains, and both domains' DNS at the box.
5. `thia-server.service` to `/etc/systemd/system/`, then `systemctl enable thia-server`.
6. Backups: `backup.sh` to `/usr/local/bin/`, `/etc/thia-server-backup.env` with the restic repository, and a
   nightly cron entry for it.

Then, from a committed tree here: `THIA_HOST=root@box THIA_PUBLIC_URL=https://<app domain> mise run server:deploy`
(the URL gives the site's pages their canonical links and a sitemap). The app's domain serves both apps from one
folder, `/opt/thia-server/current/web`: the use app (`web/site`, a prerendered page per path, `404.html` else) at the
root and the make app (`web/app`) under `/make/`, whose page answers `/workshop` and `/workshop/connect`; one origin,
so the user's store in the browser is the same for both. Its one service worker is the use app's `sw.js`.
Testers sign up in the browser with the beta code. To rotate it, update the environment file and restart
`thia-server`. Existing sessions keep working. The server listens on loopback behind Caddy, which supplies the
client address for auth rate limits. Use `admin grant-admin <email>` or `admin grant-maintainer <email>` after signup
for operators who need those privileges.

Personal sync backups live in SQLite and are included in the daily backup. Each account can store one encrypted
snapshot up to 16 MiB including its envelope. Thia cannot recover a forgotten sync passphrase.
Set up the [local CMS SSH command](../../../doc/operations/cms.md#ssh-setup) for production run inspection and submission decisions.

Every player a deploy installs stays (`/var/lib/thia-server/runtime/`), so lessons published against an older
runtime keep opening.

## Moving from gestalts-teacher

A box set up before the server was renamed has it as `gestalts-teacher`; `deploy-server.sh` refuses to deploy until
it's moved. Once, as root:

```sh
systemctl disable --now gestalts-teacher
mv /var/lib/gestalts-teacher /var/lib/thia-server && mv /var/lib/thia-server/teacher.db /var/lib/thia-server/thia.db
mv /opt/gestalts-teacher /opt/thia-server
usermod -l thia -d /var/lib/thia-server teacher && groupmod -n thia teacher
mv /etc/gestalts-teacher.env /etc/thia-server.env && sed -i 's/^TEACHER_/THIA_/' /etc/thia-server.env
mv /etc/gestalts-teacher-backup.env /etc/thia-server-backup.env
rm /etc/systemd/system/gestalts-teacher.service
```

If the database has WAL files beside it (`teacher.db-wal`, `-shm`), stop the server first (above) and they're folded
in; else rename them with it. Then steps 4–6 above with this folder's files (Caddyfile, `thia-server.service`,
`backup.sh`), and deploy.
