#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(root, "scripts", "verify-release-qualification-receipt.mjs");
const qualification = path.join(root, "scripts", "release-qualification.sh");
const workflow = path.join(root, ".github", "workflows", "release.yml");
const composeCommon = path.join(root, "scripts", "compose-common.sh");
const updateScript = path.join(root, "scripts", "update.sh");
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
  "historical-upgrade",
  "historical-auth-session",
  "historical-http-health",
  "historical-browser-session",
  "historical-collaboration-websocket",
  "historical-mcp-http",
  "historical-database-integrity",
  "historical-data-preserved",
];

function verify(receiptPath) {
  return spawnSync(process.execPath, [verifier,
    "--receipt", receiptPath,
    "--candidate-image", image,
    "--candidate-revision", revision,
  ], { encoding: "utf8" });
}

async function main() {
  const temporary = await mkdtemp(path.join(tmpdir(), "nyxdoc-release-qualification-script-test-"));
  try {
    const receipt = {
      format: "nyxdoc-release-qualification/v1",
      candidate: { image, digest: image.split("@")[1], revision },
      baseline: { ref: "v0.24.1", image: "ghcr.io/getnyxdoc/nyxdoc:0.24.1" },
      checks: Object.fromEntries(checkNames.map((name) => [name, { status: "passed" }])),
    };
    const receiptPath = path.join(temporary, "receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const valid = verify(receiptPath);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);

    receipt.checks["historical-mcp-http"] = { status: "skipped" };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const incomplete = verify(receiptPath);
    assert.notEqual(incomplete.status, 0, "missing matrix evidence must fail promotion");
    assert.match(incomplete.stderr, /historical-mcp-http/);

    receipt.checks["historical-mcp-http"] = { status: "passed" };
    receipt.candidate.digest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const mismatchedDigest = verify(receiptPath);
    assert.notEqual(mismatchedDigest.status, 0, "digest provenance mismatch must fail promotion");
    assert.match(mismatchedDigest.stderr, /candidate digest/);

    const shell = await readFile(qualification, "utf8");
    assert.match(
      shell,
      /compose_for\(\) \{\s+local directory="\$1"\s+shift\s+docker compose/,
      "compose_for must consume its directory argument before forwarding Compose arguments",
    );
    for (const requiredFragment of [
      "--candidate-image",
      "docker buildx imagetools inspect",
      "candidate digest not visible yet",
      "candidate image pull not ready yet",
      "qualification.log",
      "npm run test:mcp-http",
      "exec -T --user node",
      "scripts/update.sh",
      "update-origin.git",
      "git init --bare --initial-branch=main",
      'git -C "$root" push "$update_origin"',
      "candidate revision must have an exact stable semver tag",
      "integrity_check",
      "http://127.0.0.1:${httpPort}",
      "playwright test e2e/vertical --project=chromium",
      "nyxdoc-release-qualification/v1",
    ]) {
      assert.match(shell, new RegExp(requiredFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    const workflowText = await readFile(workflow, "utf8");
    assert.match(workflowText, /build-candidate:/);
    assert.match(workflowText, /qualify-candidate:/);
    assert.match(workflowText, /promote-image:/);
    assert.match(workflowText, /verify-release-qualification-receipt\.mjs/);
    assert.match(workflowText, /playwright install --with-deps chromium/);
    assert.match(workflowText, /imagetools create --prefer-index=false/);

    const composeCommonText = await readFile(composeCommon, "utf8");
    const updateText = await readFile(updateScript, "utf8");
    assert.match(composeCommonText, /nyxdoc_resolve_update_target\(\)/);
    assert.match(composeCommonText, /refs\/nyxdoc-update\/stable/);
    assert.match(composeCommonText, /fetch --no-tags/);
    assert.doesNotMatch(updateText, /fetch --tags/);
    assert.match(updateText, /nyxdoc_resolve_update_target/);

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

    execFileSync("bash", ["-n", "scripts/release-qualification.sh"], { cwd: root, stdio: "inherit" });
    console.log("Release qualification script contracts passed.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
