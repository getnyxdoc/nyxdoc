#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts", "verify-release-qualification-receipt.mjs");
const qualification = path.join(root, "scripts", "release-qualification.sh");
const workflow = path.join(root, ".github", "workflows", "release.yml");
const composeCommon = path.join(root, "scripts", "compose-common.sh");
const compose = path.join(root, "compose.yaml");
const installScript = path.join(root, "scripts", "install.sh");
const updateScript = path.join(root, "scripts", "update.sh");
const releaseMetadataVerifier = path.join(root, "scripts", "verify-release-metadata.mjs");
const imagePromoter = path.join(root, "scripts", "promote-release-image.sh");
const lifecycleShell = path.join(root, "scripts", "test-lifecycle-shell.sh");
const historicalFixture = path.join(
  root,
  "scripts",
  "test-fixtures",
  "release-qualification-historical.ts",
);
const qualificationRegistryProxy = path.join(
  root,
  "scripts",
  "test-fixtures",
  "release-qualification-registry-proxy.sh",
);
const image = "ghcr.io/getnyxdoc/nyxdoc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const revision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const checkNames = [
  "candidate-provenance",
  "fresh-install",
  "fresh-auth-session",
  "fresh-http-health",
  "fresh-browser-session",
  "fresh-collaboration-websocket",
  "fresh-mcp-http",
  "fresh-reinstall",
  "historical-install",
  "historical-update-bootstrap",
  "historical-upgrade",
  "historical-auth-session",
  "historical-http-health",
  "historical-browser-session",
  "historical-collaboration-websocket",
  "historical-mcp-http",
  "historical-database-integrity",
  "historical-data-preserved",
  "historical-fixture-created",
  "historical-websocket-mutation",
  "historical-legacy-bridge-backup",
  "historical-fixture-upgrade-preserved",
  "historical-fixture-commit-reload",
  "historical-fixture-reinstall-preserved",
  "historical-backup-verified",
  "historical-restore-empty-volume",
  "historical-restore-objects-preserved",
];

function verify(receiptPath) {
  return spawnSync(process.execPath, [verifier,
    "--receipt", receiptPath,
    "--candidate-image", image,
    "--candidate-revision", revision,
  ], { encoding: "utf8" });
}

function historicalEvidence(stage) {
  const candidateDirty = stage !== "baseline-dirty";
  const candidateCommitted = stage === "candidate-commit-reload";
  const canonicalRevisionIds = candidateCommitted
    ? ["revision-release-qualification-1", "revision-release-qualification-2", "revision-release-qualification-3"]
    : ["revision-release-qualification-1", "revision-release-qualification-2"];
  const canonicalRevisionContentSha256 = candidateCommitted
    ? [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    ]
    : [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ];
  const workingContentSha256 = candidateDirty
    ? "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    : "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const workingBlockIds = candidateDirty
    ? ["rq-historical-canonical", "rq-historical-websocket-first-hop"]
    : ["rq-historical-canonical"];
  return {
    format: "nyxdoc-release-historical-evidence/v1",
    stage,
    workspaceId: "workspace-release-qualification",
    parentDocumentId: "parent-release-qualification",
    nestedDocumentId: "nested-release-qualification",
    nestedDocumentTitle: "Release qualification nested document",
    parentDocumentIdFromNested: "parent-release-qualification",
    canonicalRevisionIds,
    canonicalRevisionContentSha256,
    canonicalRevisionCount: canonicalRevisionIds.length,
    canonicalRevisionNumber: canonicalRevisionIds.length,
    parentContentSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    canonicalContentSha256: candidateCommitted
      ? "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    workingContentSha256,
    canonicalBlockIds: candidateCommitted
      ? ["rq-historical-canonical", "rq-historical-websocket-first-hop"]
      : ["rq-historical-canonical"],
    workingBlockIds,
    draft: {
      generation: 3,
      draftVersion: 4,
      committedDraftVersion: candidateCommitted ? 4 : 3,
      baseRevisionId: candidateCommitted
        ? "revision-release-qualification-3"
        : "revision-release-qualification-2",
      baseRevisionNumber: candidateCommitted ? 3 : 2,
      hasUncommittedChanges: !candidateCommitted,
    },
    media: {
      id: "media-release-qualification",
      mimeType: "image/png",
      byteSize: 128,
      sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    },
  };
}

async function main() {
  const temporary = await mkdtemp(path.join(tmpdir(), "nyxdoc-release-qualification-script-test-"));
  try {
    const receipt = {
      format: "nyxdoc-release-qualification/v1",
      candidate: { image, digest: image.split("@")[1], revision },
      baseline: {
        ref: "v0.24.1",
        image: "ghcr.io/getnyxdoc/nyxdoc:0.24.1",
        immutableImage: "ghcr.io/getnyxdoc/nyxdoc:0.24.1@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        revision: "cccccccccccccccccccccccccccccccccccccccc",
      },
      checks: Object.fromEntries(checkNames.map((name) => [name, { status: "passed" }])),
      database: {
        baseline: {
          integrity: "ok",
          userVersion: 43,
          rows: {
            user: 1,
            workspaces: 1,
            workspace_members: 1,
            documents: 2,
            document_revisions: 3,
            media_assets: 1,
          },
        },
        candidate: {
          integrity: "ok",
          userVersion: 46,
          rows: {
            user: 1,
            workspaces: 1,
            workspace_members: 1,
            documents: 2,
            document_revisions: 3,
            media_assets: 1,
          },
        },
      },
      historicalFixture: {
        baselineDirty: historicalEvidence("baseline-dirty"),
        websocketBeforeFirstHop: historicalEvidence("baseline-websocket-dirty"),
        legacyBridgeBackup: {
          format: "nyxdoc-release-historical-backup-evidence/v1",
          generationPath: "/backups/release-qualification-bridge",
          documentId: "nested-release-qualification",
          workingContentSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          draftVersion: 4,
          status: "passed",
        },
        candidateDirty: historicalEvidence("candidate-upgrade-dirty"),
        normalReinstall: historicalEvidence("candidate-normal-reinstall"),
        isolatedRestore: historicalEvidence("candidate-isolated-restore"),
        candidateCommitted: historicalEvidence("candidate-commit-reload"),
      },
      backupRestore: {
        generationId: "release-qualification-backup",
        generationPath: "/backups/release-qualification-backup",
        databaseSha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        mediaTreeSha256: "9999999999999999999999999999999999999999999999999999999999999999",
        mediaFiles: 1,
        mediaBytes: 128,
        restoreStatus: "restored-and-verified",
        targetVolumeWasEmpty: true,
      },
    };
    const receiptPath = path.join(temporary, "receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const valid = verify(receiptPath);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);

    const expectRejected = async (description, mutate, messagePattern) => {
      const mutated = structuredClone(receipt);
      mutate(mutated);
      assert.ok(
        Object.values(mutated.checks).every((check) => check.status === "passed"),
        `${description} mutation must keep every check status passed`,
      );
      await writeFile(receiptPath, `${JSON.stringify(mutated, null, 2)}\n`);
      const result = verify(receiptPath);
      assert.notEqual(result.status, 0, description);
      assert.match(result.stderr, messagePattern);
    };

    await expectRejected(
      "missing baseline database proof must fail promotion",
      (value) => delete value.database.baseline,
      /baseline database evidence is missing/,
    );
    await expectRejected(
      "corrupt candidate database integrity proof must fail promotion",
      (value) => { value.database.candidate.integrity = "unknown"; },
      /candidate database integrity evidence is not ok/,
    );
    await expectRejected(
      "candidate database migration regression must fail promotion",
      (value) => { value.database.candidate.userVersion = 42; },
      /userVersion regressed/,
    );
    await expectRejected(
      "candidate database row-count regression must fail promotion",
      (value) => { value.database.candidate.rows.documents = 1; },
      /row count regressed for documents/,
    );
    await expectRejected(
      "missing isolated restore object proof must fail promotion",
      (value) => delete value.historicalFixture.isolatedRestore,
      /isolated restore historical fixture evidence is missing/,
    );
    await expectRejected(
      "corrupt isolated restore stage must fail promotion",
      (value) => { value.historicalFixture.isolatedRestore.stage = "candidate-upgrade-dirty"; },
      /isolated restore historical fixture evidence has an unexpected stage/,
    );
    await expectRejected(
      "isolated restore content mismatch must fail promotion",
      (value) => {
        value.historicalFixture.isolatedRestore.workingContentSha256 =
          "abababababababababababababababababababababababababababababababab";
      },
      /isolated restore workingContentSha256 does not match/,
    );
    await expectRejected(
      "missing backup and restore proof must fail promotion",
      (value) => delete value.backupRestore,
      /backup and restore evidence is missing/,
    );
    await expectRejected(
      "corrupt backup generation ID proof must fail promotion",
      (value) => { value.backupRestore.generationId = "bad/generation"; },
      /backup generation ID evidence is invalid/,
    );
    await expectRejected(
      "mismatched backup generation path proof must fail promotion",
      (value) => { value.backupRestore.generationPath = "/backups/another-generation"; },
      /backup generation path does not match/,
    );
    await expectRejected(
      "corrupt backup database hash proof must fail promotion",
      (value) => { value.backupRestore.databaseSha256 = "not-a-sha256"; },
      /backup database hash evidence is invalid/,
    );
    await expectRejected(
      "corrupt backup media tree hash proof must fail promotion",
      (value) => { value.backupRestore.mediaTreeSha256 = "not-a-sha256"; },
      /backup media tree hash evidence is invalid/,
    );
    await expectRejected(
      "missing backup media file-count proof must fail promotion",
      (value) => { value.backupRestore.mediaFiles = 0; },
      /backup media file-count evidence is invalid/,
    );
    await expectRejected(
      "corrupt backup media byte-count proof must fail promotion",
      (value) => { value.backupRestore.mediaBytes = 127; },
      /backup media byte-count evidence is invalid/,
    );
    await expectRejected(
      "missing restored-and-verified proof must fail promotion",
      (value) => { value.backupRestore.restoreStatus = "restored"; },
      /did not report restored-and-verified/,
    );
    await expectRejected(
      "missing empty restore target proof must fail promotion",
      (value) => { value.backupRestore.targetVolumeWasEmpty = false; },
      /restore target was not proven empty/,
    );

    for (const checkName of checkNames) {
      delete receipt.checks[checkName];
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      const absent = verify(receiptPath);
      assert.notEqual(absent.status, 0, `absent ${checkName} evidence must fail promotion`);
      assert.match(absent.stderr, new RegExp(checkName));

      receipt.checks[checkName] = { status: "skipped" };
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      const notPassed = verify(receiptPath);
      assert.notEqual(notPassed.status, 0, `non-passed ${checkName} evidence must fail promotion`);
      assert.match(notPassed.stderr, new RegExp(checkName));

      receipt.checks[checkName] = { status: "passed" };
    }

    await expectRejected(
      "digest provenance mismatch must fail promotion",
      (value) => {
        value.candidate.digest =
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      },
      /candidate digest/,
    );
    await expectRejected(
      "missing baseline immutable image evidence must fail promotion",
      (value) => delete value.baseline.immutableImage,
      /baseline immutable image/,
    );
    await expectRejected(
      "baseline digest/image mismatch must fail promotion",
      (value) => { value.baseline.digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; },
      /baseline image and revision evidence is inconsistent/,
    );
    await expectRejected(
      "baseline dirty evidence must prove an uncommitted draft",
      (value) => { value.historicalFixture.baselineDirty.draft.committedDraftVersion = 4; },
      /baseline dirty evidence must prove an uncommitted draft/,
    );
    await expectRejected(
      "candidate dirty evidence must preserve canonical baseline state",
      (value) => { value.historicalFixture.candidateDirty.canonicalContentSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; },
      /candidate dirty evidence did not preserve the baseline canonical fixture/,
    );
    await expectRejected(
      "normal reinstall must preserve the candidate dirty draft",
      (value) => { value.historicalFixture.normalReinstall.workingContentSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; },
      /normal reinstall evidence did not preserve the candidate dirty fixture/,
    );
    await expectRejected(
      "candidate commit must append exactly one canonical revision",
      (value) => {
        value.historicalFixture.candidateCommitted.canonicalRevisionContentSha256[0] =
          "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      },
      /candidate committed evidence does not append exactly one canonical revision/,
    );
    await expectRejected(
      "candidate commit must clear the dirty draft",
      (value) => { value.historicalFixture.candidateCommitted.draft.hasUncommittedChanges = true; },
      /candidate committed evidence does not prove the candidate dirty draft was committed and reloaded/,
    );
    await expectRejected(
      "a check ID alone must not prove historical WebSocket mutation",
      (value) => delete value.historicalFixture.websocketBeforeFirstHop,
      /WebSocket mutation evidence is missing/,
    );
    await expectRejected(
      "a bridge backup must prove the same accepted WebSocket draft",
      (value) => {
        value.historicalFixture.legacyBridgeBackup.workingContentSha256 =
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      },
      /content hash does not match/,
    );
    await expectRejected(
      "the receipt must prove the first-hop mutation block",
      (value) => { value.historicalFixture.websocketBeforeFirstHop.workingBlockIds = []; },
      /required first-hop block/,
    );

    const shell = await readFile(qualification, "utf8");
    const historicalFixtureSource = await readFile(historicalFixture, "utf8");
    const mediaBase64 = historicalFixtureSource.match(
      /const mediaBytes = Buffer\.from\(\s*"([A-Za-z0-9+/=]+)",\s*"base64"/u,
    )?.[1];
    assert.ok(mediaBase64, "historical qualification fixture media bytes are missing");
    const mediaBytes = Buffer.from(mediaBase64, "base64");
    const decodedFixture = await sharp(mediaBytes, {
      animated: true,
      failOn: "warning",
      sequentialRead: true,
      unlimited: false,
    }).toBuffer();
    assert.ok(
      decodedFixture.byteLength > 0,
      "historical qualification fixture media must fully decode with production settings",
    );
    assert.match(
      historicalFixtureSource,
      /authenticateApiToken\(sqlite, `Bearer \$\{state\.credential\.token\}`/u,
      "historical WebSocket qualification must authenticate the fixture's real credential",
    );
    assert.match(
      historicalFixtureSource,
      /actor: tokenDocumentActor\(identity, "api"\)/u,
      "historical WebSocket qualification must use the credential's revocable agent identity",
    );
    assert.doesNotMatch(
      historicalFixtureSource,
      /principalId:\s*"release-qualification-websocket"/u,
      "historical WebSocket qualification must not mint a synthetic principal",
    );
    assert.match(
      historicalFixtureSource,
      /function requireBaseUrl\(\)/u,
      "historical qualification must require HTTP configuration only for online fixture modes",
    );
    assert.doesNotMatch(
      historicalFixtureSource,
      /const baseUrl[^;]+;\s*if \(!baseUrl\) throw/u,
      "offline backup verification must not fail at module load when no HTTP base URL is configured",
    );
    const requiredChecksBlock = shell.match(
      /required_checks=\(\s*([\s\S]*?)\s*\)\s*for required_check in/,
    );
    assert.ok(requiredChecksBlock, "release qualification must declare its promotion-gating checks");
    const shellRequiredChecks = [...requiredChecksBlock[1].matchAll(/"([^"]+)"/g)]
      .map((match) => match[1]);
    assert.deepEqual(
      shellRequiredChecks,
      checkNames,
      "the canonical receipt verifier must require every release qualification gate",
    );
    assert.match(
      shell,
      /compose_for\(\) \{\s+local directory="\$1"\s+shift\s+docker compose/,
      "compose_for must consume its directory argument before forwarding Compose arguments",
    );
    for (const requiredFragment of [
      "--candidate-image",
      "docker buildx imagetools inspect",
      "candidate digest not visible yet",
      "image pull not ready yet",
      "image OCI revision label",
      "org.opencontainers.image.revision",
      "NYXDOC_SOURCE_REVISION",
      "--preflight-only",
      "qualification.log",
      "npm run test:mcp-http",
      "exec -T --user node",
      "scripts/update-bootstrap.sh",
      'checks["historical-update-bootstrap"]="passed"',
      'checks["historical-websocket-mutation"]="passed"',
      'checks["historical-legacy-bridge-backup"]="passed"',
      "verify-backup",
      "update-origin.git",
      "git init --bare --initial-branch=main",
      'git -C "$root" push "$update_origin"',
      'NYXDOC_OFFICIAL_RELEASE_SOURCE="$update_origin"',
      "candidate revision must have an exact stable semver tag",
      "qualification-only semver projection",
      "release-qualification-registry-proxy.sh",
      "Legacy bridge verified backup",
      "Pre-update verified backup",
      "integrity_check",
      "http://127.0.0.1:${httpPort}",
      "playwright test e2e/vertical --project=chromium",
      "nyxdoc-release-qualification/v1",
      "exec -T collaboration node -e",
      'historical_fixture_container_root="/tmp/nyxdoc-release-qualification"',
      'historical_fixture_container_path="${historical_fixture_container_root}/scripts/test-fixtures/release-qualification-historical.ts"',
      '"app:${historical_fixture_container_path}"',
      "mkdir -p /tmp/nyxdoc-release-qualification/scripts/test-fixtures",
      "ln -sfn /app/src /tmp/nyxdoc-release-qualification/src",
      "ln -sfn /app/node_modules /tmp/nyxdoc-release-qualification/node_modules",
      'NYXDOC_COLLABORATION_HOST_PORT "$((http_port + 1))"',
      "qualification_ports_are_available",
      "select_qualification_fresh_port",
      "Stay below Linux's default ephemeral range",
      '"$((configured + 4000))" "$((configured + 4001))"',
      "diagnostic output (last 40 lines)",
      'tail -n 40 "$evidence_path"',
    ]) {
      assert.match(shell, new RegExp(requiredFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(
      shell,
      /app:\/scripts\/test-fixtures\/release-qualification-historical\.ts|mkdir -p \/app\/scripts\/test-fixtures/,
      "historical qualification fixtures must be staged in the container-writable temporary directory",
    );
    assert.doesNotMatch(
      shell,
      /38000 \+ RANDOM/,
      "release qualification must not allocate reusable service ports inside Linux's default ephemeral range",
    );
    const temporaryOriginStart = shell.indexOf('git init --bare --initial-branch=main "$update_origin"');
    const bridgeInvocationStart = shell.indexOf('bridge_output="$(');
    const bridgeInvocationEnd = shell.indexOf(')"', bridgeInvocationStart);
    assert.ok(temporaryOriginStart >= 0 && bridgeInvocationStart > temporaryOriginStart);
    const bridgeInvocation = shell.slice(bridgeInvocationStart, bridgeInvocationEnd);
    assert.match(
      bridgeInvocation,
      /NYXDOC_OFFICIAL_RELEASE_SOURCE="\$update_origin"/,
      "the unpublished candidate tag must be resolved from qualification's disposable origin, never the public release remote",
    );
    assert.match(
      bridgeInvocation,
      /PATH="\$qualification_docker_bin:\$PATH"/,
      "the historical updater must see the qualification-only registry projection",
    );
    assert.match(
      bridgeInvocation,
      /NYXDOC_RELEASE_QUALIFICATION_SEMVER_IMAGE="\$candidate_semver_image"/,
      "the registry projection must be restricted to the exact candidate semver image",
    );
    assert.match(
      bridgeInvocation,
      /NYXDOC_RELEASE_QUALIFICATION_CANDIDATE_DIGEST="\$candidate_digest"/,
      "the registry projection must expose only the verified immutable candidate digest",
    );
    assert.match(
      shell.slice(temporaryOriginStart, bridgeInvocationStart),
      /refs\/tags\/\$candidate_tag:refs\/tags\/\$candidate_tag/,
      "the disposable qualification origin must contain the unpublished candidate tag before the bridge runs",
    );
    assert.match(
      shell,
      /Legacy bridge verified backup:[\s\S]*?Pre-update verified backup:/,
      "qualification must accept the verified-backup receipt from both legacy and modern historical updaters",
    );

    const proxyDir = await mkdtemp(path.join(tmpdir(), "nyxdoc-release-proxy-"));
    try {
      const fakeDocker = path.join(proxyDir, "docker-real");
      await writeFile(fakeDocker, "#!/usr/bin/env bash\nprintf 'delegated:%s\\n' \"$*\"\n", "utf8");
      await chmod(fakeDocker, 0o755);
      const shellPath = (value) => value.replaceAll("\\", "/");
      const toWslPath = (value) => {
        const normalized = shellPath(value);
        const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
        assert(match, `expected an absolute Windows path: ${value}`);
        return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
      };
      const quoteForBash = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const proxyEnvironment = {
        ...process.env,
        NYXDOC_RELEASE_QUALIFICATION_REAL_DOCKER: shellPath(fakeDocker),
        NYXDOC_RELEASE_QUALIFICATION_SEMVER_IMAGE: "ghcr.io/getnyxdoc/nyxdoc:0.25.20",
        NYXDOC_RELEASE_QUALIFICATION_CANDIDATE_DIGEST: `sha256:${"a".repeat(64)}`,
      };
      const invokeProxy = (arguments_) => {
        if (process.platform === "win32") {
          const proxyPath = toWslPath(qualificationRegistryProxy);
          const fakeDockerPath = toWslPath(fakeDocker);
          const command = [
            `chmod +x ${quoteForBash(fakeDockerPath)}`,
            `export NYXDOC_RELEASE_QUALIFICATION_REAL_DOCKER=${quoteForBash(fakeDockerPath)}`,
            `export NYXDOC_RELEASE_QUALIFICATION_SEMVER_IMAGE=${quoteForBash(proxyEnvironment.NYXDOC_RELEASE_QUALIFICATION_SEMVER_IMAGE)}`,
            `export NYXDOC_RELEASE_QUALIFICATION_CANDIDATE_DIGEST=${quoteForBash(proxyEnvironment.NYXDOC_RELEASE_QUALIFICATION_CANDIDATE_DIGEST)}`,
            `bash ${quoteForBash(proxyPath)} ${arguments_.map(quoteForBash).join(" ")}`,
          ].join(" && ");
          return spawnSync("wsl.exe", ["bash", "-lc", command], { encoding: "utf8" });
        }
        return spawnSync(
          "bash",
          [qualificationRegistryProxy, ...arguments_],
          { encoding: "utf8", env: proxyEnvironment },
        );
      };
      const projected = invokeProxy([
        "buildx", "imagetools", "inspect", "ghcr.io/getnyxdoc/nyxdoc:0.25.20",
      ]);
      assert.equal(projected.status, 0, projected.stderr);
      assert.match(projected.stdout, /Name: ghcr\.io\/getnyxdoc\/nyxdoc:0\.25\.20/);
      assert.match(projected.stdout, new RegExp(`Digest: sha256:${"a".repeat(64)}`));
      assert.doesNotMatch(projected.stdout, /delegated:/);

      const delegated = invokeProxy(["compose", "version"]);
      assert.equal(delegated.status, 0, delegated.stderr);
      assert.equal(delegated.stdout.trim(), "delegated:compose version");
    } finally {
      await rm(proxyDir, { recursive: true, force: true });
    }

    const composeText = await readFile(compose, "utf8");
    const collaborationSection = composeText.slice(
      composeText.indexOf("  collaboration:"),
      composeText.indexOf("  gateway:"),
    );
    assert.doesNotMatch(
      collaborationSection,
      /^    ports:/m,
      "the collaboration service must not expose a host port",
    );
    assert.match(
      composeText,
      /NYXDOC_COLLABORATION_SECRET: \$\{NYXDOC_COLLABORATION_SECRET\}/,
      "the trusted gateway must receive the collaboration IP proof secret",
    );

    const workflowText = await readFile(workflow, "utf8");
    assert.match(workflowText, /workflow_dispatch:/);
    assert.match(workflowText, /version:\s+description: Stable version to publish/);
    assert.doesNotMatch(workflowText, /push:\s+tags:/);
    assert.match(workflowText, /build-candidate:/);
    assert.match(workflowText, /qualify-candidate:/);
    assert.match(workflowText, /promote-image:/);
    assert.match(workflowText, /group: nyxdoc-release-publication/);
    assert.match(workflowText, /verify-release-qualification-receipt\.mjs/);
    assert.match(workflowText, /name: release-qualification-\$\{\{ github\.run_id \}\}/);
    assert.doesNotMatch(workflowText, /name: release-qualification-.*github\.run_attempt/);
    assert.match(workflowText, /overwrite: true/);
    assert.match(workflowText, /playwright install --with-deps chromium/);
    assert.match(workflowText, /group: release-\$\{\{ inputs\.version \}\}/);
    assert.match(workflowText, /cancel-in-progress: false/);
    assert.match(workflowText, /node scripts\/test-lifecycle-cli\.mjs/);
    assert.match(workflowText, /bash scripts\/test-lifecycle-shell\.sh/);
    assert.match(workflowText, /verify-release-metadata\.mjs --tag/);
    assert.match(workflowText, /release_revision="\$\(git rev-parse HEAD\)"/);
    assert.match(workflowText, /git merge-base --is-ancestor "\$release_revision" refs\/remotes\/origin\/main/);
    assert.match(workflowText, /existing release tag .* points to/);
    assert.match(workflowText, /release invariant violated: .* exists but .* is not pullable/);
    assert.match(workflowText, /revision: \$\{\{ needs\.quality\.outputs\.revision \}\}/);
    assert.match(workflowText, /org\.opencontainers\.image\.revision=\$\{\{ needs\.quality\.outputs\.revision \}\}/);
    assert.match(workflowText, /SOURCE_REVISION=\$\{\{ needs\.quality\.outputs\.revision \}\}/);
    assert.match(workflowText, /CANDIDATE_REVISION: \$\{\{ needs\.build-candidate\.outputs\.revision \}\}/);
    assert.match(workflowText, /grep -E '\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$'/);
    assert.match(workflowText, /git merge-base --is-ancestor "\$\{candidate\}\^\{commit\}" "\$RELEASE_REVISION"/);
    assert.match(workflowText, /promote-release-image\.sh/);
    assert.match(workflowText, /gh release edit/);
    const immutablePromotionIndex = workflowText.indexOf("PROMOTION_PHASE: immutable");
    const finalTagIndex = workflowText.indexOf("Publish or verify the final Git tag");
    const aliasPromotionIndex = workflowText.indexOf("PROMOTION_PHASE: aliases");
    const githubReleaseIndex = workflowText.indexOf("Create or repair the GitHub release");
    assert.ok(immutablePromotionIndex >= 0 && immutablePromotionIndex < finalTagIndex);
    assert.ok(finalTagIndex < aliasPromotionIndex);
    assert.ok(aliasPromotionIndex < githubReleaseIndex);
    assert.doesNotMatch(workflowText, /^  github-release:/m);
    assert.match(workflowText, /git push origin "refs\/tags\/\$\{RELEASE_TAG\}:refs\/tags\/\$\{RELEASE_TAG\}"/);

    const lifecycleShellText = await readFile(lifecycleShell, "utf8");
    const firstHopStart = lifecycleShellText.indexOf("# First-hop compatibility contract");
    const firstHopEnd = lifecycleShellText.indexOf('update_remote="$temporary/update-origin.git"');
    assert.ok(firstHopStart >= 0 && firstHopEnd > firstHopStart);
    const firstHopContract = lifecycleShellText.slice(firstHopStart, firstHopEnd);
    assert.match(firstHopContract, /git .* show v0\.25\.17:scripts\/update\.sh/);
    assert.match(firstHopContract, /published-images/);
    assert.ok(
      firstHopContract.indexOf("ghcr.io/getnyxdoc/nyxdoc:0.25.18")
        < firstHopContract.indexOf("push \"$first_hop_remote\" v0.25.18"),
      "the v0.25.18 image must become pullable before its final Git tag is pushed",
    );
    assert.doesNotMatch(
      firstHopContract,
      /NYXDOC_UPDATE_IMAGE/,
      "the v0.25.17 first-hop proof must use its real stable resolver",
    );

    const promoterText = await readFile(imagePromoter, "utf8");
    assert.match(promoterText, /docker buildx imagetools create --prefer-index=false/);
    assert.match(promoterText, /CANDIDATE_REVISION must be a 40-character lowercase Git SHA/);
    assert.match(promoterText, /candidate registry digest/);
    assert.match(promoterText, /candidate image OCI revision label/);
    assert.match(promoterText, /\.Config\.Env/);
    assert.match(promoterText, /NYXDOC_SOURCE_REVISION/);
    assert.match(promoterText, /refusing to overwrite immutable release tag/);
    assert.match(promoterText, /existing_version_digest/);
    assert.match(promoterText, /TARGET_TAGS must include the exact immutable release tag/);
    assert.match(promoterText, /PROMOTION_PHASE must be immutable or aliases/);
    assert.match(promoterText, /refusing mutable alias publication: Git tag/);
    assert.match(promoterText, /plan_mutable_aliases/);
    assert.match(promoterText, /skipping mutable alias/);
    assert.match(promoterText, /returned a corrupt digest/);
    assert.match(promoterText, /tag --list 'v\[0-9\]\*'/);
    const immutableVersionPromotionIndex = promoterText.indexOf('promote_and_verify "$version_tag"');
    const mutableAliasPlanIndex = promoterText.lastIndexOf("\nplan_mutable_aliases\n");
    const mutableAliasPromotionIndex = promoterText.indexOf(
      'for tag in "${mutable_aliases_to_promote[@]}"',
      mutableAliasPlanIndex,
    );
    assert.ok(
      immutableVersionPromotionIndex >= 0
        && immutableVersionPromotionIndex < mutableAliasPlanIndex
        && mutableAliasPlanIndex < mutableAliasPromotionIndex,
      "the immutable release tag must precede read-only alias planning and mutable promotion",
    );

    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const validMetadata = spawnSync(process.execPath, [
      releaseMetadataVerifier,
      "--tag",
      `v${packageJson.version}`,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(validMetadata.status, 0, validMetadata.stderr || validMetadata.stdout);
    const mismatchedMetadata = spawnSync(process.execPath, [
      releaseMetadataVerifier,
      "--tag",
      "v99.99.99",
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(mismatchedMetadata.status, 0, "tag/package version mismatch must fail release metadata validation");

    if (process.platform !== "win32") {
      const fakeBin = path.join(temporary, "fake-bin");
      const fakeDocker = path.join(fakeBin, "docker");
      const registryState = path.join(temporary, "registry-state");
      const dockerLog = path.join(temporary, "docker.log");
      const promotionRoot = path.join(temporary, "promotion-root");
      const promotionScript = path.join(promotionRoot, "scripts", "promote-release-image.sh");
      await mkdir(fakeBin, { recursive: true });
      await mkdir(path.dirname(promotionScript), { recursive: true });
      await writeFile(promotionScript, await readFile(imagePromoter, "utf8"), { mode: 0o755 });
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: promotionRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Nyxdoc Promotion Test"], { cwd: promotionRoot });
      execFileSync("git", ["config", "user.email", "promotion@example.test"], { cwd: promotionRoot });
      execFileSync("git", ["add", "scripts/promote-release-image.sh"], { cwd: promotionRoot });
      execFileSync("git", ["commit", "-m", "candidate"], { cwd: promotionRoot, stdio: "ignore" });
      const promotionRevision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: promotionRoot,
        encoding: "utf8",
      }).trim();
      for (const version of ["v0.25.16", "v0.25.17", "v0.25.18", "v0.25.19"]) {
        execFileSync("git", ["tag", "-a", version, "-m", version], { cwd: promotionRoot });
      }
      await writeFile(fakeDocker, `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "\${1:-} \${2:-} \${3:-}" = "buildx imagetools inspect" ]; then
  reference="\${4:-}"
  digest="$(awk -v ref="$reference" '$1 == ref { print $2; exit }' "$FAKE_REGISTRY_STATE" 2>/dev/null || true)"
  if [ "\${FAKE_INSPECT_FAILURE_REFERENCE:-}" = "$reference" ]; then
    case "\${FAKE_INSPECT_FAILURE_MODE:-}" in
      unauthorized) printf 'unauthorized: authentication required\n' >&2; exit 1 ;;
      timeout) printf 'request timed out while contacting registry\n' >&2; exit 1 ;;
      not-found) if [ -z "$digest" ]; then printf 'manifest unknown: manifest unknown\n' >&2; exit 1; fi ;;
      buildx-ghcr-not-found) if [ -z "$digest" ]; then printf 'ERROR: %s: not found\n' "$reference" >&2; exit 1; fi ;;
      empty) exit 1 ;;
      malformed) printf 'Digest: not-a-digest\n'; exit 0 ;;
    esac
  fi
  if [ -z "$digest" ]; then
    printf 'manifest unknown: manifest unknown\n' >&2
    exit 1
  fi
  printf 'Digest: %s\\n' "$digest"
  exit 0
fi
if [ "\${1:-}" = pull ]; then
  printf 'pulled %s\\n' "\${2:-}"
  exit 0
fi
if [ "\${1:-} \${2:-}" = "image inspect" ]; then
  format=""
  reference="\${!#}"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --format ]; then format="$2"; break; fi
    shift
  done
  case "$reference" in
    "$FAKE_CANDIDATE_IMAGE")
      if [[ "$format" == *org.opencontainers.image.revision* ]]; then
        printf '%s\\n' "$FAKE_CANDIDATE_OCI_REVISION"
      else
        if [ "\${FAKE_DUPLICATE_CANDIDATE_SOURCE_REVISION:-0}" = 1 ]; then
          printf 'NYXDOC_SOURCE_REVISION=%040d\\n' 0
        fi
        printf 'NODE_ENV=production\\nNYXDOC_SOURCE_REVISION=%s\\n' "$FAKE_CANDIDATE_SOURCE_REVISION"
      fi
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "buildx imagetools create" ]; then
  tag=""
  shift 3
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -t ]; then tag="$2"; shift 2; continue; fi
    shift
  done
  printf 'create %s\\n' "$tag" >>"$FAKE_DOCKER_LOG"
  printf '%s %s\\n' "$tag" "$FAKE_CANDIDATE_DIGEST" >>"$FAKE_REGISTRY_STATE"
  exit 0
fi
exit 2
`, { mode: 0o755 });

      const candidateDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const versionTag = "ghcr.io/getnyxdoc/nyxdoc:0.25.17";
      const candidateImage = `ghcr.io/getnyxdoc/nyxdoc@${candidateDigest}`;
      const promoterEnv = {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        FAKE_REGISTRY_STATE: registryState,
        FAKE_DOCKER_LOG: dockerLog,
        FAKE_CANDIDATE_DIGEST: candidateDigest,
        CANDIDATE_IMAGE: candidateImage,
        CANDIDATE_DIGEST: candidateDigest,
        CANDIDATE_REVISION: promotionRevision,
        FAKE_CANDIDATE_IMAGE: candidateImage,
        FAKE_CANDIDATE_OCI_REVISION: promotionRevision,
        FAKE_CANDIDATE_SOURCE_REVISION: promotionRevision,
        VERSION_TAG: versionTag,
        PROMOTION_PHASE: "immutable",
        // Put mutable aliases first to prove the preflight does not rely on
        // metadata-action's output order.
        TARGET_TAGS: `ghcr.io/getnyxdoc/nyxdoc:latest ghcr.io/getnyxdoc/nyxdoc:0.25 ${versionTag}`,
      };

      await writeFile(registryState, `${candidateImage} ${candidateDigest}\n${versionTag} sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n`);
      await writeFile(dockerLog, "");
      const conflict = spawnSync("bash", [promotionScript], { cwd: promotionRoot, env: promoterEnv, encoding: "utf8" });
      assert.notEqual(conflict.status, 0, "a conflicting immutable version tag must fail promotion");
      assert.match(conflict.stderr, /refusing to overwrite immutable release tag/);
      assert.equal(await readFile(dockerLog, "utf8"), "", "no mutable alias may move before immutable conflict detection");

      await writeFile(registryState, `${candidateImage} ${candidateDigest}\n`);
      await writeFile(dockerLog, "");
      const missingVersionTag = spawnSync("bash", [promotionScript], {
        cwd: promotionRoot,
        env: { ...promoterEnv, FAKE_INSPECT_FAILURE_REFERENCE: versionTag, FAKE_INSPECT_FAILURE_MODE: "not-found" },
        encoding: "utf8",
      });
      assert.equal(missingVersionTag.status, 0, missingVersionTag.stderr || missingVersionTag.stdout);
      assert.equal(
        await readFile(dockerLog, "utf8"),
        `create ${versionTag}\n`,
        "an explicit manifest-not-found response must publish the immutable version tag",
      );

      await writeFile(registryState, `${candidateImage} ${candidateDigest}\n`);
      await writeFile(dockerLog, "");
      const buildxGhcrMissingVersionTag = spawnSync("bash", [promotionScript], {
        cwd: promotionRoot,
        env: {
          ...promoterEnv,
          FAKE_INSPECT_FAILURE_REFERENCE: versionTag,
          FAKE_INSPECT_FAILURE_MODE: "buildx-ghcr-not-found",
        },
        encoding: "utf8",
      });
      assert.equal(
        buildxGhcrMissingVersionTag.status,
        0,
        buildxGhcrMissingVersionTag.stderr || buildxGhcrMissingVersionTag.stdout,
      );
      assert.equal(
        await readFile(dockerLog, "utf8"),
        `create ${versionTag}\n`,
        "the exact reference-bound Buildx/GHCR not-found response must publish the immutable version tag",
      );

      await writeFile(registryState, `${candidateImage} ${candidateDigest}\n${versionTag} ${candidateDigest}\n`);
      await writeFile(dockerLog, "");
      const identicalVersionTag = spawnSync("bash", [promotionScript], {
        cwd: promotionRoot,
        env: promoterEnv,
        encoding: "utf8",
      });
      assert.equal(identicalVersionTag.status, 0, identicalVersionTag.stderr || identicalVersionTag.stdout);
      assert.match(identicalVersionTag.stdout, /already points to the qualified digest/);
      assert.equal(
        await readFile(dockerLog, "utf8"),
        "",
        "an immutable version tag already at the candidate digest must not be republished",
      );

      for (const failureMode of ["unauthorized", "timeout", "empty", "malformed"]) {
        await writeFile(registryState, `${candidateImage} ${candidateDigest}\n`);
        await writeFile(dockerLog, "");
        const ambiguousInspection = spawnSync("bash", [promotionScript], {
          cwd: promotionRoot,
          env: {
            ...promoterEnv,
            FAKE_INSPECT_FAILURE_REFERENCE: versionTag,
            FAKE_INSPECT_FAILURE_MODE: failureMode,
          },
          encoding: "utf8",
        });
        assert.notEqual(
          ambiguousInspection.status,
          0,
          `${failureMode} while inspecting an immutable version tag must fail closed`,
        );
        assert.match(ambiguousInspection.stderr, /refusing registry publication: inspection/);
        assert.equal(
          await readFile(dockerLog, "utf8"),
          "",
          `${failureMode} must not execute imagetools create`,
        );
      }

      await writeFile(registryState, `${candidateImage} ${candidateDigest}\n${versionTag} ${candidateDigest}\n`);
      await writeFile(dockerLog, "");
      const retry = spawnSync("bash", [promotionScript], {
        cwd: promotionRoot,
        env: { ...promoterEnv, PROMOTION_PHASE: "aliases" },
        encoding: "utf8",
      });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);
      const retryLog = await readFile(dockerLog, "utf8");
      assert.doesNotMatch(retryLog, new RegExp(`create ${versionTag.replaceAll(".", "\\.")}`));
      assert.match(retryLog, /create ghcr\.io\/getnyxdoc\/nyxdoc:latest/);
      assert.match(retryLog, /create ghcr\.io\/getnyxdoc\/nyxdoc:0\.25/);

      await writeFile(registryState, `${candidateImage} sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n`);
      await writeFile(dockerLog, "");
      const wrongCandidateDigest = spawnSync("bash", [promotionScript], { cwd: promotionRoot, env: promoterEnv, encoding: "utf8" });
      assert.notEqual(wrongCandidateDigest.status, 0, "a registry digest that differs from the candidate pin must fail promotion");
      assert.match(wrongCandidateDigest.stderr, /candidate registry digest/);
      assert.equal(await readFile(dockerLog, "utf8"), "", "a digest provenance failure must not move any alias");

      await writeFile(registryState, `${candidateImage} ${candidateDigest}\n`);
      await writeFile(dockerLog, "");
      const wrongCandidateRevision = spawnSync("bash", [promotionScript], {
        cwd: promotionRoot,
        env: { ...promoterEnv, FAKE_CANDIDATE_OCI_REVISION: "cccccccccccccccccccccccccccccccccccccccc" },
        encoding: "utf8",
      });
      assert.notEqual(wrongCandidateRevision.status, 0, "a candidate image from another source revision must fail promotion");
      assert.match(wrongCandidateRevision.stderr, /candidate image OCI revision label/);
      assert.equal(await readFile(dockerLog, "utf8"), "", "a revision provenance failure must not move any alias");

      await writeFile(registryState, `${candidateImage} ${candidateDigest}\n${versionTag} ${candidateDigest}\nghcr.io/getnyxdoc/nyxdoc:latest sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n`);
      await writeFile(dockerLog, "");
      const unknownAlias = spawnSync("bash", [promotionScript], {
        cwd: promotionRoot,
        env: { ...promoterEnv, PROMOTION_PHASE: "aliases" },
        encoding: "utf8",
      });
      assert.notEqual(unknownAlias.status, 0, "an alias with an unmapped digest must fail promotion");
      assert.match(unknownAlias.stderr, /not mapped to an immutable stable release tag/);
      assert.equal(await readFile(dockerLog, "utf8"), "", "an unsafe existing alias must remain unchanged");

      const delayedVersionTag = "ghcr.io/getnyxdoc/nyxdoc:0.25.18";
      const newerVersionTag = "ghcr.io/getnyxdoc/nyxdoc:0.25.19";
      const newerDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      const delayedEnv = {
        ...promoterEnv,
        VERSION_TAG: delayedVersionTag,
        TARGET_TAGS: `ghcr.io/getnyxdoc/nyxdoc:latest ghcr.io/getnyxdoc/nyxdoc:0.25 ${delayedVersionTag}`,
        PROMOTION_PHASE: "aliases",
      };
      await writeFile(registryState, [
        `${candidateImage} ${candidateDigest}`,
        `${delayedVersionTag} ${candidateDigest}`,
        `${newerVersionTag} ${newerDigest}`,
        `ghcr.io/getnyxdoc/nyxdoc:latest ${newerDigest}`,
        `ghcr.io/getnyxdoc/nyxdoc:0.25 ${newerDigest}`,
        "",
      ].join("\n"));
      await writeFile(dockerLog, "");
      const delayedPublication = spawnSync("bash", [promotionScript], {
        cwd: promotionRoot,
        env: delayedEnv,
        encoding: "utf8",
      });
      assert.equal(
        delayedPublication.status,
        0,
        delayedPublication.stderr || delayedPublication.stdout,
      );
      assert.equal(
        await readFile(dockerLog, "utf8"),
        "",
        "a delayed v0.25.18 publication must not downgrade v0.25.19 aliases",
      );
      assert.match(
        delayedPublication.stdout,
        /skipping mutable alias ghcr\.io\/getnyxdoc\/nyxdoc:latest: existing release 0\.25\.19 is newer than 0\.25\.18/,
      );
      assert.match(
        delayedPublication.stdout,
        /skipping mutable alias ghcr\.io\/getnyxdoc\/nyxdoc:0\.25: existing release 0\.25\.19 is newer than 0\.25\.18/,
      );

      await writeFile(registryState, [
        `${candidateImage} ${candidateDigest}`,
        `${delayedVersionTag} ${candidateDigest}`,
        "ghcr.io/getnyxdoc/nyxdoc:latest not-a-digest",
        "",
      ].join("\n"));
      await writeFile(dockerLog, "");
      const corruptAlias = spawnSync("bash", [promotionScript], {
        cwd: promotionRoot,
        env: delayedEnv,
        encoding: "utf8",
      });
      assert.notEqual(corruptAlias.status, 0, "a corrupt alias digest must fail promotion");
      assert.match(corruptAlias.stderr, /returned a corrupt digest/);
      assert.equal(
        await readFile(dockerLog, "utf8"),
        "",
        "a corrupt alias must fail before any other mutable alias moves",
      );
    }

    {
      // Run the qualification preflight against a clean temporary checkout so
      // the real script's clean-tree requirement remains part of the contract.
      // The fake Docker CLI exercises registry/image responses without touching
      // a registry, daemon, volume, or running service.
      const preflightCheckout = path.join(temporary, "provenance-checkout");
      execFileSync("git", ["clone", "--no-local", root, preflightCheckout], { stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Nyxdoc Release Test"], { cwd: preflightCheckout });
      execFileSync("git", ["config", "user.email", "release-test@example.test"], { cwd: preflightCheckout });
      await writeFile(
        path.join(preflightCheckout, "scripts", "release-qualification.sh"),
        await readFile(qualification, "utf8"),
      );
      execFileSync("git", ["add", "scripts/release-qualification.sh"], { cwd: preflightCheckout });
      execFileSync("git", ["commit", "--allow-empty", "--no-gpg-sign", "-m", "test release provenance preflight"], {
        cwd: preflightCheckout,
        stdio: "ignore",
      });

      const preflightCandidateRevision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: preflightCheckout,
        encoding: "utf8",
      }).trim();
      const preflightBaselineRef = "v0.25.17";
      assert.equal(execFileSync(
        "git",
        ["tag", "--list", preflightBaselineRef],
        { cwd: preflightCheckout, encoding: "utf8" },
      ).trim(), preflightBaselineRef, "the realistic historical baseline tag must exist");
      const preflightBaselineRevision = execFileSync(
        "git",
        ["rev-parse", `${preflightBaselineRef}^{commit}`],
        { cwd: preflightCheckout, encoding: "utf8" },
      ).trim();

      const preflightBin = path.join(temporary, "provenance-fake-bin");
      const preflightDocker = path.join(preflightBin, "docker");
      const preflightLog = path.join(temporary, "provenance-docker.log");
      await mkdir(preflightBin, { recursive: true });
      await writeFile(preflightDocker, `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "\${1:-} \${2:-}" = "compose version" ] || [ "\${1:-} \${2:-}" = "buildx version" ]; then
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = "buildx imagetools inspect" ]; then
  reference="\${4:-}"
  case "$reference" in
    "$FAKE_CANDIDATE_IMAGE") digest="$FAKE_CANDIDATE_MANIFEST_DIGEST" ;;
    "$FAKE_BASELINE_IMAGE") digest="$FAKE_BASELINE_MANIFEST_DIGEST" ;;
    *) exit 1 ;;
  esac
  printf 'Digest: %s\\n' "$digest"
  exit 0
fi
if [ "\${1:-}" = pull ]; then
  printf 'pull %s\\n' "\${2:-}" >>"$FAKE_DOCKER_LOG"
  exit 0
fi
if [ "\${1:-} \${2:-}" = "image inspect" ]; then
  format=""
  reference="\${!#}"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --format ]; then format="$2"; break; fi
    shift
  done
  case "$reference" in
    "$FAKE_CANDIDATE_IMAGE")
      if [[ "$format" == *org.opencontainers.image.revision* ]]; then
        printf '%s\\n' "$FAKE_CANDIDATE_OCI_REVISION"
      else
        if [ "\${FAKE_DUPLICATE_CANDIDATE_SOURCE_REVISION:-0}" = 1 ]; then
          printf 'NYXDOC_SOURCE_REVISION=%040d\\n' 0
        fi
        printf 'NODE_ENV=production\\nNYXDOC_SOURCE_REVISION=%s\\n' "$FAKE_CANDIDATE_SOURCE_REVISION"
      fi
      ;;
    "$FAKE_BASELINE_IMAGE")
      if [[ "$format" == *org.opencontainers.image.revision* ]]; then
        printf '%s\\n' "$FAKE_BASELINE_OCI_REVISION"
      else
        if [ "\${FAKE_DUPLICATE_BASELINE_SOURCE_REVISION:-0}" = 1 ]; then
          printf 'NYXDOC_SOURCE_REVISION=%040d\\n' 0
        fi
        printf 'NODE_ENV=production\\nNYXDOC_SOURCE_REVISION=%s\\n' "$FAKE_BASELINE_SOURCE_REVISION"
      fi
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 2
`, { mode: 0o755 });
      await writeFile(path.join(preflightBin, "git"), `#!/usr/bin/env bash
exec /usr/bin/git -c safe.directory='*' "$@"
`, { mode: 0o755 });
      await writeFile(path.join(preflightBin, "node"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      await writeFile(path.join(preflightBin, "npx"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

      const preflightCandidateDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const preflightBaselineDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const preflightCandidateImage = `registry.example.test/nyxdoc@${preflightCandidateDigest}`;
      const preflightBaselineImage = "registry.example.test/nyxdoc:baseline";
      const preflightEnv = {
        PATH: `${preflightBin}${path.delimiter}${process.env.PATH}`,
        FAKE_DOCKER_LOG: preflightLog,
        FAKE_CANDIDATE_IMAGE: preflightCandidateImage,
        FAKE_BASELINE_IMAGE: preflightBaselineImage,
        FAKE_CANDIDATE_MANIFEST_DIGEST: preflightCandidateDigest,
        FAKE_BASELINE_MANIFEST_DIGEST: preflightBaselineDigest,
        FAKE_CANDIDATE_OCI_REVISION: preflightCandidateRevision,
        FAKE_CANDIDATE_SOURCE_REVISION: preflightCandidateRevision,
        FAKE_BASELINE_OCI_REVISION: preflightBaselineRevision,
        FAKE_BASELINE_SOURCE_REVISION: preflightBaselineRevision,
        NYXDOC_RELEASE_QUALIFICATION_REGISTRY_RETRY_ATTEMPTS: "1",
        NYXDOC_RELEASE_QUALIFICATION_REGISTRY_RETRY_DELAY_SECONDS: "0",
      };
      const runPreflight = async (overrides = {}) => {
        await writeFile(preflightLog, "");
        const environment = { ...preflightEnv, ...overrides };
        if (process.platform === "win32") {
          const toWslPath = (value) => {
            const normalized = value.replaceAll("\\", "/");
            const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
            assert(match, `expected an absolute Windows path: ${value}`);
            return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
          };
          const quoteForBash = (value) => `'${value.replaceAll("'", "'\\''")}'`;
          const wslEnvironment = {
            ...environment,
            FAKE_DOCKER_LOG: toWslPath(preflightLog),
          };
          const exports = Object.entries(wslEnvironment)
            .filter(([key]) => key !== "PATH" && (key.startsWith("FAKE_") || key.startsWith("NYXDOC_")))
            .map(([key, value]) => `export ${key}=${quoteForBash(value)}`);
          const command = [
            `cd ${quoteForBash(toWslPath(preflightCheckout))}`,
            `export PATH=${quoteForBash(`${toWslPath(preflightBin)}:`)}"$PATH"`,
            ...exports,
            `bash ${quoteForBash(toWslPath(path.join(preflightCheckout, "scripts", "release-qualification.sh")))} --candidate-image ${quoteForBash(preflightCandidateImage)} --candidate-revision ${quoteForBash(preflightCandidateRevision)} --baseline-ref ${quoteForBash(preflightBaselineRef)} --baseline-image ${quoteForBash(preflightBaselineImage)} --preflight-only`,
          ].join(" && ");
          return spawnSync("wsl.exe", ["bash", "-lc", command], { encoding: "utf8" });
        }
        return spawnSync("bash", [
          path.join(preflightCheckout, "scripts", "release-qualification.sh"),
          "--candidate-image", preflightCandidateImage,
          "--candidate-revision", preflightCandidateRevision,
          "--baseline-ref", preflightBaselineRef,
          "--baseline-image", preflightBaselineImage,
          "--preflight-only",
        ], {
          cwd: preflightCheckout,
          env: environment,
          encoding: "utf8",
        });
      };

      const validPreflight = await runPreflight();
      assert.equal(validPreflight.status, 0, validPreflight.stderr || validPreflight.stdout);

      const wrongPreflightDigest = await runPreflight({
        FAKE_CANDIDATE_MANIFEST_DIGEST: preflightBaselineDigest,
      });
      assert.notEqual(wrongPreflightDigest.status, 0, "a candidate manifest digest mismatch must fail qualification");
      assert.match(wrongPreflightDigest.stderr, /registry manifest digest provenance/);
      assert.equal(await readFile(preflightLog, "utf8"), "", "a digest mismatch must fail before either image is pulled");

      const wrongCandidateOci = await runPreflight({
        FAKE_CANDIDATE_OCI_REVISION: preflightBaselineRevision,
      });
      assert.notEqual(wrongCandidateOci.status, 0, "a candidate OCI revision mismatch must fail qualification");
      assert.match(wrongCandidateOci.stderr, /candidate image OCI revision label/);
      assert.doesNotMatch(await readFile(preflightLog, "utf8"), /pull registry\.example\.test\/nyxdoc:baseline/);

      const wrongCandidateSource = await runPreflight({
        FAKE_CANDIDATE_SOURCE_REVISION: preflightBaselineRevision,
      });
      assert.notEqual(wrongCandidateSource.status, 0, "a candidate source revision mismatch must fail qualification");
      assert.match(wrongCandidateSource.stderr, /candidate image NYXDOC_SOURCE_REVISION environment/);

      const duplicateCandidateSource = await runPreflight({
        FAKE_DUPLICATE_CANDIDATE_SOURCE_REVISION: "1",
      });
      assert.notEqual(duplicateCandidateSource.status, 0, "duplicate candidate source revision provenance must fail qualification");
      assert.match(duplicateCandidateSource.stderr, /candidate image must contain exactly one NYXDOC_SOURCE_REVISION/);

      const wrongBaselineOci = await runPreflight({
        FAKE_BASELINE_OCI_REVISION: preflightCandidateRevision,
      });
      assert.notEqual(wrongBaselineOci.status, 0, "a retagged baseline OCI revision must fail before migration qualification");
      assert.match(wrongBaselineOci.stderr, /baseline image OCI revision label/);

      const wrongBaselineSource = await runPreflight({
        FAKE_BASELINE_SOURCE_REVISION: preflightCandidateRevision,
      });
      assert.notEqual(wrongBaselineSource.status, 0, "a retagged baseline source revision must fail before migration qualification");
      assert.match(wrongBaselineSource.stderr, /baseline image NYXDOC_SOURCE_REVISION environment/);

      const duplicateBaselineSource = await runPreflight({
        FAKE_DUPLICATE_BASELINE_SOURCE_REVISION: "1",
      });
      assert.notEqual(duplicateBaselineSource.status, 0, "duplicate baseline source revision provenance must fail qualification");
      assert.match(duplicateBaselineSource.stderr, /baseline image must contain exactly one NYXDOC_SOURCE_REVISION/);
    }

    const composeCommonText = await readFile(composeCommon, "utf8");
    const installText = await readFile(installScript, "utf8");
    const updateText = await readFile(updateScript, "utf8");
    const releaseWorkflowText = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
    assert.match(composeCommonText, /nyxdoc_resolve_update_target\(\)/);
    assert.match(composeCommonText, /refs\/nyxdoc-update\/stable/);
    assert.match(composeCommonText, /fetch --no-tags/);
    assert.match(composeCommonText, /docker buildx imagetools inspect/);
    assert.match(composeCommonText, /nyxdoc_require_buildx/);
    assert.match(updateText, /nyxdoc_require_buildx/);
    assert.match(releaseWorkflowText, /source_revision_count/);
    assert.match(releaseWorkflowText, /exactly one NYXDOC_SOURCE_REVISION/);
    assert.equal(
      [...releaseWorkflowText.matchAll(/git rev-parse --verify "\$\{RELEASE_TAG\}\^\{commit\}" 2>\/dev\/null \|\| true/g)].length,
      3,
      "optional release-tag lookups must use rev-parse --verify so a missing tag produces no stdout",
    );
    assert.ok(
      !releaseWorkflowText.includes('git rev-parse "${RELEASE_TAG}^{commit}" 2>/dev/null || true'),
      "release qualification must not mistake an unresolved revision expression for an existing tag",
    );
    assert.match(composeCommonText, /No stable Git tag with a verifiably published semver image/);
    assert.ok(
      composeCommonText.includes("awk '$2 ~ /^refs\\/tags\\/v[0-9]+\\.[0-9]+\\.[0-9]+$/"),
      "stable update selection must exclude prerelease tags",
    );
    assert.doesNotMatch(updateText, /fetch --tags/);
    assert.match(updateText, /nyxdoc_resolve_update_target/);
    assert.match(updateText, /nyxdoc_resumable_update_target/);
    assert.ok(
      updateText.indexOf("nyxdoc_resumable_update_target") < updateText.indexOf('nyxdoc_resolve_update_target "$channel"'),
      "an interrupted-update receipt must be resolved before a newly published stable target",
    );
    assert.match(updateText, /nyxdoc_select_update_image/);
    assert.match(updateText, /Source is already on .*configured image requires reconciliation/);
    assert.match(updateText, /nyxdoc_services_use_image/);
    assert.match(updateText, /running services require reconciliation/);
    assert.match(updateText, /nyxdoc_resumable_update_backup/);
    assert.match(updateText, /resuming the interrupted update with its verified pre-update backup/);
    assert.match(composeCommonText, /nyxdoc_require_data_volume_quiescent/);
    assert.match(composeCommonText, /npm run db:migrate/);
    assert.match(composeCommonText, /run --rm --no-deps app true/);
    assert.match(installText, /nyxdoc_env_remove NYXDOC_SOURCE_REVISION/);
    assert.match(installText, /nyxdoc_running_containers_using_data_volume/);
    assert.match(installText, /nyxdoc_run_offline_database_migrations/);
    assert.match(updateText, /nyxdoc_env_remove NYXDOC_SOURCE_REVISION/);
    assert.match(updateText, /nyxdoc_verify_image_source_revision/);
    const stopGateway = updateText.indexOf("nyxdoc_compose stop -t 20 gateway");
    const stopCollaboration = updateText.indexOf("nyxdoc_compose stop -t 20 collaboration");
    const stopApp = updateText.indexOf("nyxdoc_compose stop -t 20 app");
    const offlineMigration = updateText.indexOf("nyxdoc_run_offline_database_migrations");
    const restartServices = updateText.indexOf("nyxdoc_compose up -d --no-build --remove-orphans");
    assert.ok(
      stopGateway >= 0
        && stopGateway < stopCollaboration
        && stopCollaboration < stopApp
        && stopApp < offlineMigration
        && offlineMigration < restartServices,
      "the updater must stop every writer before offline migration and restart only afterward",
    );
    assert.match(composeCommonText, /npm run backup:verify -- "\$generation_path"/);
    assert.match(
      shell,
      /NYXDOC_UPDATE_ROOT="\$upgrade_dir"[\s\S]*NYXDOC_UPDATE_IMAGE="\$candidate_image"[\s\S]*scripts\/update-bootstrap\.sh/,
    );

    if (process.platform !== "win32") {
      const stateRoot = path.join(temporary, "update-state-root");
      const stateBackup = path.join(stateRoot, "backups", "generation-1");
      await mkdir(stateBackup, { recursive: true });
      await writeFile(path.join(stateRoot, ".env.production"), "NYXDOC_BACKUP_HOST_PATH=./backups\n");
      await writeFile(path.join(stateBackup, "manifest.json"), "{}\n");
      const previousRevision = "1111111111111111111111111111111111111111";
      const targetRevision = "2222222222222222222222222222222222222222";
      const otherRevision = "3333333333333333333333333333333333333333";
      const updateState = spawnSync("bash", ["-c", [
        "source scripts/compose-common.sh",
        'NYXDOC_ROOT="$STATE_ROOT"',
         'NYXDOC_ENV_FILE="$NYXDOC_ROOT/.env.production"',
         'NYXDOC_COMPOSE_FILE="$NYXDOC_ROOT/compose.yaml"',
         'nyxdoc_compose() { return 0; }',
         'test "$(nyxdoc_update_state_file)" = "$NYXDOC_ROOT/.nyxdoc-update-state"',
         `nyxdoc_write_update_state ${previousRevision} ${targetRevision} v0.25.17 generation-1 /backups/generation-1`,
        `test "$(nyxdoc_resumable_update_backup ${previousRevision} ${targetRevision})" = $'generation-1\\t/backups/generation-1'`,
        `test "$(nyxdoc_resumable_update_backup ${targetRevision} ${targetRevision})" = $'generation-1\\t/backups/generation-1'`,
        `! nyxdoc_resumable_update_backup ${otherRevision} ${targetRevision}`,
        `! nyxdoc_resumable_update_backup ${targetRevision} ${otherRevision}`,
        "nyxdoc_clear_update_state",
        '! test -e "$(nyxdoc_update_state_file)"',
      ].join("\n")], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, STATE_ROOT: stateRoot },
      });
      assert.equal(updateState.status, 0, updateState.stderr || updateState.stdout);
    }

    if (process.platform !== "win32") {
      const servicesUseImage = (runningIds) => spawnSync("bash", ["-c", `
        source scripts/compose-common.sh
        nyxdoc_compose() {
          case "\${5}" in
            app) printf 'app-id\\n' ;;
            collaboration) printf 'collaboration-id\\n' ;;
            gateway) printf 'gateway-id\\n' ;;
          esac
        }
        docker() {
          if [ "\${1} \${2}" = "image inspect" ]; then
            printf 'sha256:desired\\n'
            return
          fi
          case "\${4}" in
            app-id) printf '%s\\n' "$MOCK_APP_IMAGE" ;;
            collaboration-id) printf '%s\\n' "$MOCK_COLLABORATION_IMAGE" ;;
            gateway-id) printf '%s\\n' "$MOCK_GATEWAY_IMAGE" ;;
          esac
        }
        nyxdoc_services_use_image ghcr.io/getnyxdoc/nyxdoc:0.25.17
      `], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MOCK_APP_IMAGE: runningIds.app,
          MOCK_COLLABORATION_IMAGE: runningIds.collaboration,
          MOCK_GATEWAY_IMAGE: runningIds.gateway,
        },
      });
      const matchingServices = servicesUseImage({
        app: "sha256:desired",
        collaboration: "sha256:desired",
        gateway: "sha256:desired",
      });
      assert.equal(
        matchingServices.status,
        0,
        `all three running services must match the selected image\n${matchingServices.stderr || matchingServices.stdout}`,
      );
      assert.notEqual(servicesUseImage({
        app: "sha256:old",
        collaboration: "sha256:desired",
        gateway: "sha256:desired",
      }).status, 0, "one stale service must force reconciliation");
    }

    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const selectUpdateImage = (currentImage, version, overrideImage = "") => execFileSync(
      "bash",
      [
        "-c",
        `source scripts/compose-common.sh; nyxdoc_select_update_image ${shellQuote(currentImage)} ${shellQuote(version)} ${shellQuote(overrideImage)}`,
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
    assert.equal(
      selectUpdateImage(
        "ghcr.io/getnyxdoc/nyxdoc@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0.25.14",
      ),
      "ghcr.io/getnyxdoc/nyxdoc:0.25.14",
      "an official pinned release digest must advance to the selected stable version",
    );
    assert.equal(
      selectUpdateImage("ghcr.io/getnyxdoc/nyxdoc:0.25.13", "0.25.14"),
      "ghcr.io/getnyxdoc/nyxdoc:0.25.14",
    );
    assert.equal(
      selectUpdateImage("registry.example.test/nyxdoc:managed", "0.25.14"),
      "registry.example.test/nyxdoc:managed",
      "an explicitly configured custom image must remain unchanged",
    );
    assert.equal(
      selectUpdateImage(
        "ghcr.io/getnyxdoc/nyxdoc:0.25.13",
        "0.25.14",
        image,
      ),
      image,
      "release qualification must be able to pin the immutable candidate digest",
    );

    // Windows Node and WSL Bash use different path and repository ownership
    // models. The updater is a supported Linux lifecycle script, so exercise
    // the real cross-repository Git fixture on Linux CI and keep Windows to
    // the static contract plus shell syntax checks above.
    if (process.platform !== "win32") {
    const updateRemote = path.join(temporary, "update-remote.git");
    const updateSeed = path.join(temporary, "update-seed");
    const updateCheckout = path.join(temporary, "update-checkout");
    const git = (cwd, args) => execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    execFileSync("git", ["init", "--bare", "--initial-branch=main", updateRemote], {
      stdio: "ignore",
    });
    execFileSync("git", ["clone", updateRemote, updateSeed], { stdio: "ignore" });
    git(updateSeed, ["config", "user.name", "Nyxdoc Release Test"]);
    git(updateSeed, ["config", "user.email", "release-test@example.test"]);
    await writeFile(path.join(updateSeed, "version.txt"), "0.25.1\n");
    git(updateSeed, ["add", "version.txt"]);
    git(updateSeed, ["commit", "-m", "baseline"]);
    const baselineRevision = git(updateSeed, ["rev-parse", "HEAD"]);
    git(updateSeed, ["tag", "-a", "v0.25.1", "-m", "baseline"]);
    await writeFile(path.join(updateSeed, "version.txt"), "0.25.9\n");
    git(updateSeed, ["add", "version.txt"]);
    git(updateSeed, ["commit", "-m", "candidate"]);
    const candidateRevision = git(updateSeed, ["rev-parse", "HEAD"]);
    git(updateSeed, ["tag", "-a", "v0.25.9", "-m", "candidate"]);
    git(updateSeed, ["tag", "-a", "v0.25.10", "-m", "failed release without image"]);
    git(updateSeed, ["tag", "-a", "v99.0.0-rc.1", "-m", "prerelease must not enter stable"]);
    git(updateSeed, ["push", "origin", "main", "--tags"]);
    execFileSync("git", ["clone", updateRemote, updateCheckout], { stdio: "ignore" });

    // Reproduce Actions' tag checkout shape: the local release tag resolves to
    // the wrong object while origin still has the canonical annotated tag.
    git(updateCheckout, ["tag", "-f", "v0.25.9", baselineRevision]);
    const resolution = spawnSync("bash", [
      "-c",
      [
        "source scripts/compose-common.sh",
        'if command -v wslpath >/dev/null 2>&1; then NYXDOC_ROOT="$(wslpath "$UPDATE_CHECKOUT")"; else NYXDOC_ROOT="$UPDATE_CHECKOUT"; fi',
        'docker() { if [ "${1:-} ${2:-} ${3:-} ${4:-}" = "buildx imagetools inspect ghcr.io/getnyxdoc/nyxdoc:0.25.9" ]; then printf "Digest: sha256:%064d\\n" 9; else return 1; fi; }',
        "nyxdoc_resolve_update_target stable",
      ].join("; "),
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, UPDATE_CHECKOUT: updateCheckout },
    });
    assert.equal(resolution.status, 0, resolution.stderr || resolution.stdout);
    assert.equal(
      resolution.stdout.trim().split(/\r?\n/).at(-1),
      "refs/nyxdoc-update/stable\tv0.25.9",
    );
    assert.equal(
      git(updateCheckout, ["rev-parse", "refs/nyxdoc-update/stable^{commit}"]),
      candidateRevision,
      "stable update must resolve the canonical origin tag",
    );
    assert.equal(
      git(updateCheckout, ["rev-parse", "refs/tags/v0.25.9^{commit}"]),
      baselineRevision,
      "stable update must not rewrite a local/user tag",
    );
    }

    for (const script of [
      "scripts/compose-common.sh",
      "scripts/update.sh",
      "scripts/update-bootstrap.sh",
      "scripts/release-qualification.sh",
      "scripts/promote-release-image.sh",
      "scripts/test-lifecycle-shell.sh",
    ]) {
      execFileSync("bash", ["-n", script], { cwd: root, stdio: "inherit" });
    }
    console.log("Release qualification script contracts passed.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
