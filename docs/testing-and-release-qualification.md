# Testing and production deployment

GitHub distributes Nyxdoc source. Production runs a single Linux AMD64 image
built locally from a tested commit on `main`. Use the full source revision to
identify a deployment. The last public release was v0.25.28.

## Before deployment

- Reproduce the reported problem and test the fix in the affected environment.
  For editor changes, cover the original sequence in Firefox and run the editor
  suite, including Chromium, selection, composition and collaboration cases.
- Run CI for the proposed source tree. It covers types, lint, unit tests, the
  real browser sessions, agent/MCP HTTP integration, and the production build
  used by the Linux Compose lifecycle. Browser specs run across four isolated
  jobs with separate app servers, databases and login quotas. A fresh server
  runs the signed-in vertical suite once. Update the browser image in CI
  alongside the locked Playwright version. The lifecycle checks cover real migrations,
  backup verification and restore, interrupted updates, and preserved data.
- For database, media or collaboration changes, exercise the affected data
  path with a populated fixture, including the upgrade and recovery paths.
  Preserve immutable migration checksums and add forward migrations.

## Production

Follow [DEPLOYMENT.md](../DEPLOYMENT.md#deploy-a-tested-source-commit).
Record the exact public main commit with the tested source tree. The updater
takes a verified backup, builds from that commit and checks image provenance,
then stops writers for the offline migration rehearsal and live migration.
Check the app, collaboration server and gateway, the public endpoint and the
changed behavior. Keep the backup and previous image available for recovery.

GitHub Releases, release tags and public container image publication ended
after v0.25.28. The historical procedure is available in that tag.
