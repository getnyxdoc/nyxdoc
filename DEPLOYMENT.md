# Self-hosting Nyxdoc

The supported production path is Linux with Docker Compose. Windows, macOS,
and native Node.js execution are useful for development but are best effort.

Nyxdoc runs three processes from one image:

- `app`: Next.js, authentication, REST, MCP, and SQLite migrations;
- `collaboration`: Yjs/Hocuspocus shared drafts; and
- `gateway`: the only public application entry point. It routes normal HTTP to
  the app and `/collaboration` WebSocket traffic to the collaboration service.

## 1. Requirements

- Docker Engine with Compose v2
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
- pulls the image matching the checked-out Nyxdoc version;
- starts the app, collaboration server, and gateway; and
- waits until both public health endpoints respond.

Use `./scripts/install.sh --build` to build the current checkout instead of
pulling the release image. Re-running the installer is safe and preserves the
existing data volume.

For an internet-facing installation, edit `.env.production` before exposing
the service:

Set:

```dotenv
NYXDOC_IMAGE=ghcr.io/getnyxdoc/nyxdoc:0.24.1
BETTER_AUTH_URL=https://docs.example.com
BETTER_AUTH_SECRET=<first random value>
AUTH_TRUSTED_ORIGINS=https://docs.example.com
NYXDOC_COLLABORATION_SECRET=<second random value>
NYXDOC_COLLABORATION_PUBLIC_URL=wss://docs.example.com/collaboration
NYXDOC_HTTP_HOST=127.0.0.1
NYXDOC_HTTP_PORT=3191
NYXDOC_COLLABORATION_HOST_PORT=3192
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
curl --fail http://127.0.0.1:3192/health
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

The gateway removes any client-supplied `x-nyxdoc-client-ip` header and rebuilds
it from the trusted reverse-proxy boundary. This is required for agent-key
IP/CIDR restrictions.

## 5. One-command updates and migrations

Run the stable updater from the repository checkout:

```bash
./scripts/update.sh
```

The updater refuses a dirty Git checkout, fetches versioned release references,
requires a fast-forward descendant, creates and verifies a backup before
changing source or containers, checks out the newest `v*` release, pulls its
exact image, starts the services, and verifies health. Migrations run
automatically during app startup. To follow `main` from source explicitly, use
`./scripts/update.sh --channel main --build`.

On startup, Nyxdoc:

1. creates and verifies a database/media backup generation;
2. applies pending migrations to a copied database first;
3. checks row counts, existing-column fingerprints, foreign keys, and SQLite
   integrity; and
4. applies the migration to the live database only after the rehearsal passes.

Never edit an already published migration. Add a new forward migration.

If an update fails after a migration, the updater prints the previous source
revision and verified backup path. It does not attempt an unsafe automatic
database rollback. Diagnose the failure, preserve the failed state, and use the
verified restore procedure below when rollback is necessary.

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
database fingerprints, foreign keys, and SQLite integrity.

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
