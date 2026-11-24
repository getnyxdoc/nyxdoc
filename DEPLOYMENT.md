# Self-hosting Nyxdoc

The supported production path is Linux AMD64 with Docker Compose. Windows, macOS,
and native Node.js execution are useful for development but are best effort.

Nyxdoc runs three processes from one image:

- `app`: Next.js, authentication, REST, MCP, and SQLite migrations;
- `collaboration`: Yjs/Hocuspocus shared drafts; and
- `gateway`: the only public application entry point. It routes normal HTTP to
  the app and `/collaboration` WebSocket traffic to the collaboration service.

## 1. Requirements

- Docker Engine with Compose v2
- Git and Docker Buildx for local source builds
- a persistent host directory for backups
- a reverse proxy with HTTPS for an internet-facing installation
- at least 1 GB of available memory for a small installation

SQLite, uploaded media, and collaboration drafts use the `nyxdoc_data` Docker
volume. Verified backup generations are written to the host path configured by
`NYXDOC_BACKUP_HOST_PATH`.

## 2. Install

```bash
git clone https://github.com/getnyxdoc/nyxdoc.git && cd nyxdoc && ./scripts/install.sh
```

The installer:

- creates `.env.production` with mode `0600` when it is missing;
- generates two independent secrets without displaying them;
- builds the checked-out Git commit as a local Linux AMD64 image;
- applies database migrations in an isolated one-off container before any
  public writer starts;
- starts the app, collaboration server, and gateway; and
- waits until the public gateway and the internal collaboration health check respond.

Use `./scripts/update.sh` to change the revision of a running installation.

For an internet-facing installation, edit `.env.production` before exposing
the service:

Set:

```dotenv
BETTER_AUTH_URL=https://docs.example.com
BETTER_AUTH_SECRET=<first random value>
AUTH_TRUSTED_ORIGINS=https://docs.example.com
NYXDOC_COLLABORATION_SECRET=<second random value>
NYXDOC_COLLABORATION_PUBLIC_URL=wss://docs.example.com/collaboration
NYXDOC_HTTP_HOST=127.0.0.1
NYXDOC_HTTP_PORT=3191
NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS=172.16.0.0/12,192.168.0.0/16
NYXDOC_BACKUP_HOST_PATH=./data/backups
```

Keep `.env.production` readable only by the deployment account. The installer
sets this automatically; retain it after manual edits:

```bash
chmod 600 .env.production
```

The container creates the backup directory when it is missing and fixes the
ownership of only its mounted data, media, backup, and SQLite paths before
dropping permanently to the unprivileged `node` user.

### First account and registration

The first account created in the browser becomes the single site owner. No SMTP
server or custom email domain is required.

After the first account, registration defaults to invitation-only. Site
administrators can create one-time links and copy them directly to invitees.
Set `REGISTRATION_MODE=open` only if anyone should be able to register.

For domain-restricted registration:

```dotenv
EMAIL_DOMAIN_POLICY=restricted
ALLOWED_EMAIL_DOMAINS=example.com,subsidiary.example.com
```

### Optional SMTP

Leave SMTP variables empty for a no-mail installation. Invitation links and
owner-created recovery links continue to work.

To enable email verification and password-reset email:

```dotenv
EMAIL_VERIFICATION_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@example.com
SMTP_PASSWORD=<secret>
EMAIL_FROM=Nyxdoc <no-reply@example.com>
```

SMTP passwords and TLS private keys are never stored in the Nyxdoc database.

## 3. Verify and start again

Check the running installation:

```bash
docker compose --env-file .env.production ps
curl --fail http://127.0.0.1:3191/api/health
docker compose --env-file .env.production exec -T collaboration node -e \
  'fetch("http://127.0.0.1:3101/health").then(r => process.exit(r.ok ? 0 : 1))'
```

After a normal uninstall or host reboot, run `./scripts/install.sh` again. It
reuses the same configuration, data volume, media, and backups.

For a local HTTP-only trial, keep the example URLs at
`http://localhost:3191` and `ws://localhost:3191/collaboration`, then open
`http://localhost:3191`.

## 4. Reverse proxy and HTTPS

The gateway binds to host loopback port `3191` by default. Keep that port
private and proxy a public HTTPS hostname to it. Change `NYXDOC_HTTP_HOST` and
`NYXDOC_HTTP_PORT` only when the host binding needs to differ. Images are
limited to 15 MB, so allow at least 20 MB request bodies.

Example Nginx location:

```nginx
client_max_body_size 20m;

location / {
    proxy_pass http://127.0.0.1:3191;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

The collaboration service has no host port: all browser WebSocket traffic goes
through the gateway. The gateway removes caller-supplied client-IP headers,
rebuilds the client IP from its reverse-proxy boundary, and proves that value to
the collaboration service with the collaboration secret. Linux Docker may show
host Nginx as a bridge peer rather than `127.0.0.1`, so the fresh-install config
explicitly trusts the standard Docker local address pools while the published
gateway port remains bound to host loopback.

`NYXDOC_GATEWAY_TRUSTED_PROXY_CIDRS` is a comma- or whitespace-separated CIDR
list. Set it to the actual local Docker address pool when the daemon uses a
custom pool. Invalid entries stop the gateway at startup. To expose the gateway
directly on a non-loopback host address, first set this variable to an empty
value; otherwise startup is refused because Docker userland proxying can make a
direct caller indistinguishable from the host proxy. With an empty value, only
socket loopback peers may supply `X-Real-IP`, so direct requests remain
fail-closed and use their normalized immediate peer address.

## 5. One-command updates and migrations

### Deploy a tested source commit

GitHub hosts the source. Build the production image locally on the Linux AMD64
server. Run from the deployment checkout with the full commit that passed CI:

```bash
./scripts/update.sh --revision <tested-main-commit>
```

Without a revision, the updater selects the latest commit on `origin/main`.
It verifies the running image and takes a verified backup before checkout.
It builds `nyxdoc-app:<commit>` while the old services are still serving,
checks the embedded revision, stops the writers, rehearses migrations on a
copy, then updates the live database, starts the services and checks health.
A repeat deployment of the same healthy revision reuses its running image.

### Switching an existing release installation

For installations still on 0.25.17 or 0.25.18, first complete the historical
[0.25.19 backup bridge](https://github.com/getnyxdoc/nyxdoc/blob/v0.25.19/DEPLOYMENT.md).
For a release installation on 0.25.19 through 0.25.28, finish any interrupted
update using its original updater. Confirm the checkout is clean, its origin
is your intended repository and the running services are healthy. Then load
the tested updater beside the live checkout so it can back up the old revision
before changing it. Run the following in Bash from the installation directory:

```bash
(
  set -euo pipefail
  revision='REPLACE_WITH_TESTED_FULL_SHA'
  git fetch --no-tags origin main
  git merge-base --is-ancestor HEAD "$revision"
  git merge-base --is-ancestor "$revision" FETCH_HEAD
  test ! -e .nyxdoc-update-state
  staging=$(mktemp -d)
  trap 'rm -rf -- "$staging"' EXIT
  git archive "$revision" scripts/update.sh scripts/compose-common.sh | tar -x -C "$staging"
  source scripts/compose-common.sh
  nyxdoc_env_set NYXDOC_UPDATE_AUTHORITY origin
  NYXDOC_UPDATE_ROOT="$PWD" bash "$staging/scripts/update.sh" --revision "$revision"
)
```

If interrupted after a receipt is created, retry the staged updater for the
same commit with the existing receipt. Subsequent source deployments use
`./scripts/update.sh --revision <tested-main-commit>` directly.

During an offline install or update migration, Nyxdoc:

1. creates and verifies a database/media backup generation;
2. applies pending migrations to a copied database first;
3. checks row counts, existing-column fingerprints, foreign keys, and SQLite
   integrity; and
4. applies the migration to the live database only after the rehearsal passes.

Never edit an already published migration. Add a new forward migration.

If an update fails after a migration, the updater prints the previous source
revision and verified backup path. It does not attempt an unsafe automatic
database rollback. Diagnose the failure, preserve the failed state, and use the
verified restore procedure below when rollback is necessary. The durable
receipt records the previous checkout revision, previous configured image, the
actual common Docker image ID (and repository digest when available), the
verified backup source revision, and the target image. A resumed update accepts
only that recorded source/authority/configuration boundary; it never silently
overwrites a later image change.

The first recovery action is always to rerun `./scripts/update.sh`: the receipt
pins its target and verified backup, so this is deterministic even if a mutable
tag has changed since the interruption. If an operator instead decides to roll
back after a failed migration, retain `.nyxdoc-update-state`, restore its named
generation into the live volume using the verified procedure below, then use
only the receipt's `previousRevision` and `previousConfiguredImage`. Confirm
that Docker still has `previousRunningImageId` (and, when present, its recorded
repository digest) before starting services. Nyxdoc deliberately does not
automate that final reversal because it would otherwise combine a source/image
rollback with an unsafe database rollback.

For an interrupted update, the resumable receipt is stored as
`.nyxdoc-update-state` in the repository checkout beside `.env.production`.
It deliberately does not live in the backup directory: verified backup payloads
are created by the container runtime user and their host directory may not be
writable by the person running the lifecycle commands.

If an offline migration process is terminated abruptly, it can leave
`nyxdoc.db.offline-operation.lock`. Never delete that file manually. Stop all
three services, wait at least 15 minutes, and use the verified backup generation
named by the failed migration's output:

```bash
docker compose --env-file .env.production stop app collaboration gateway
docker compose --env-file .env.production run --rm --no-deps --user node \
  -e NYXDOC_RECOVER_STALE_OFFLINE_LOCK=/backups/<generation-id> \
  -e NYXDOC_RECOVER_STALE_OFFLINE_LOCK_CONFIRM=<generation-id> \
  app npm run db:migrate
```

This explicit recovery path removes the lock only when its file owner matches
the operator, its recorded PID is dead, its age is stale, collaboration is
provably offline, the live SQLite database passes integrity checks, and the
generation's verified backup plus `offline-operation-recovery.json` receipt
match the lock. Any mismatch leaves the lock untouched for investigation.

## 6. Backups and restore rehearsal

Create and verify a generation:

```bash
docker compose --env-file .env.production exec --user node app npm run backup:create
docker compose --env-file .env.production exec --user node app \
  npm run backup:verify -- /backups/<generation-id>
```

Restore into empty isolated paths:

```bash
docker compose --env-file .env.production exec --user node app npm run backup:restore -- \
  /backups/<generation-id> \
  --database /tmp/nyxdoc-restore/nyxdoc.db \
  --media /tmp/nyxdoc-restore/media \
  --confirm-generation <generation-id>
```

The restore command refuses to overwrite existing targets and rechecks hashes,
database fingerprints, foreign keys, and SQLite integrity. A restore into
`/tmp` verifies the payload, but it does not prove that the restored copy boots.
For a full rehearsal, use a disposable checkout, port, Compose project, and data
volume while reusing only the verified backup directory:

```bash
generation=<generation-id>
source_root="$(pwd)"
rehearsal_root="/tmp/nyxdoc-restore-${generation}"
source "$source_root/scripts/compose-common.sh"
backup_root="$(nyxdoc_backup_host_path)"
rm -rf -- "$rehearsal_root"
mkdir -p -- "$rehearsal_root"
git archive HEAD | tar -x -C "$rehearsal_root"
cp .env.production "$rehearsal_root/.env.production"
cd "$rehearsal_root"
sed -i \
  -e "s#^NYXDOC_DATA_VOLUME=.*#NYXDOC_DATA_VOLUME=nyxdoc_restore_${generation}#" \
  -e 's#^NYXDOC_HTTP_PORT=.*#NYXDOC_HTTP_PORT=32991#' \
  -e 's#^BETTER_AUTH_URL=.*#BETTER_AUTH_URL=http://localhost:32991#' \
  -e 's#^AUTH_TRUSTED_ORIGINS=.*#AUTH_TRUSTED_ORIGINS=http://localhost:32991#' \
  -e 's#^NYXDOC_COLLABORATION_PUBLIC_URL=.*#NYXDOC_COLLABORATION_PUBLIC_URL=ws://localhost:32991/collaboration#' \
  -e "s#^NYXDOC_BACKUP_HOST_PATH=.*#NYXDOC_BACKUP_HOST_PATH=${backup_root}#" \
  .env.production
docker compose --project-name "nyxdoc-restore-${generation}" --env-file .env.production \
  run --rm --no-deps app npm run backup:restore -- \
  "/backups/${generation}" --database /data/nyxdoc.db --media /data/media \
  --confirm-generation "$generation"
docker compose --project-name "nyxdoc-restore-${generation}" --env-file .env.production up -d
curl --fail http://127.0.0.1:32991/api/health
```

Inspect the copy at `http://127.0.0.1:32991`, then stop it. Remove the explicitly
named rehearsal volume only after the copy has been verified:

```bash
docker compose --project-name "nyxdoc-restore-${generation}" --env-file .env.production down
docker volume rm "nyxdoc_restore_${generation}"
rm -rf -- "$rehearsal_root"
```

Never point a rehearsal at the live data volume or live HTTP port.

Host-local backups do not protect against host loss. Replicate verified
generations to a separate encrypted location and rehearse restores regularly.

## 7. Owner recovery without email

If the site owner cannot sign in and SMTP is unavailable, run:

```bash
docker compose --env-file .env.production exec --user node app npm run owner:recovery
```

The command prints a one-time password-reset link valid for 30 minutes. Treat
the link as a secret and do not place it in logs or tickets.

## 8. Routine retention

```bash
docker compose --env-file .env.production exec -T --user node app npm run backup:create
docker compose --env-file .env.production exec -T --user node app npm run trash:purge
docker compose --env-file .env.production exec -T --user node app npm run agents:purge
```

Schedule these commands with the host's service manager, monitor their exit
codes and backup capacity, and keep the latest verified generation off-host.

## 9. Stop, uninstall, and purge

Stop and remove containers and the Compose network while preserving documents,
media, the data volume, backups, `.env.production`, and source:

```bash
./scripts/uninstall.sh
```

For a disposable trial, permanently remove the Docker data volume as well:

```bash
./scripts/uninstall.sh --purge --confirm-purge=nyxdoc
```

When the app is running, purge creates and verifies one final external backup
before removing the volume. The backup directory, `.env.production`, and source
checkout are always preserved so removal is explicit and recoverable. Delete
those separately only after verifying they are no longer needed.

## 10. Security checks

- `GET /api/health` should return success.
- unauthenticated `/mcp` should return `401` with
  `WWW-Authenticate: Bearer`;
- the public site should be HTTPS;
- `.env.production` and backup generations must not be committed; and
- agent connection keys should be stored only in the agent's secret store.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.
