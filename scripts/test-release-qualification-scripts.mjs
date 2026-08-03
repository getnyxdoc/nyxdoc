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
