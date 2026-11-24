# Testing and production deployment

GitHub distributes Nyxdoc source. Production runs a single Linux AMD64 image
built locally from a tested commit on `main`. Use the full source revision to
identify a deployment. The last public release was v0.25.28.

## Before deployment

- Reproduce the reported problem and test the fix in the affected environment.
  During development, rerun the affected specs for fast feedback. For editor
  changes, cover the reported sequence in the affected browser. CI runs the
  broader Chromium, Firefox, selection, composition and collaboration cases.
- Run CI for the proposed source tree. It covers types, lint, unit tests,
  real browser sessions, agent/MCP HTTP integration, and the production build
  used by the Linux Compose lifecycle. Six isolated browser jobs distribute
  the discovered cases round-robin. The signed-in suite runs on its own
  server at the same time. Browser jobs reuse installed dependencies when
  the package manifests, container image, Node, npm and install flags match.
  Update the pinned image alongside the locked Playwright version. The Compose
  job reuses the AMD64 dependency stage and runs the standard installer.
  A separate runner refreshes the layer cache alongside the installer. Lifecycle
  checks cover migrations, backup verification and restore, interrupted updates,
  and preserved data.
- For database, media or collaboration changes, exercise the affected data
  path with a populated fixture, including the upgrade and recovery paths.
  Preserve immutable migration checksums and add forward migrations.

## Production

Follow [DEPLOYMENT.md](../DEPLOYMENT.md#deploy-a-tested-source-commit).
Record the exact public main commit with the tested source tree. A passing PR
run covers a merge with the identical Git tree. If the merge changes the tree,
wait for CI on the merged revision. For changes confined to CI and its guide,
verify the updated workflow on main. For application updates, the updater
takes a verified backup, builds from that commit and checks image provenance,
then stops writers for the offline migration rehearsal and live migration.
Check the app, collaboration server and gateway, the public endpoint and the
changed behavior. Keep the backup and previous image available for recovery.

GitHub Releases, release tags and public container image publication ended
after v0.25.28. The historical procedure is available in that tag.
