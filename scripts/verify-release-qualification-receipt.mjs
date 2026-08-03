#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const REQUIRED_CHECKS = [
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

function fail(message) {
  throw new Error(`Release qualification receipt is invalid: ${message}`);
}

function valueAfter(argumentsList, flag) {
  const index = argumentsList.indexOf(flag);
  if (index === -1 || !argumentsList[index + 1]) fail(`missing ${flag}`);
  return argumentsList[index + 1];
}

function candidateDigest(image) {
  const match = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/.exec(image);
  if (!match) fail("candidate image must be an immutable image@sha256 digest reference");
  return match[2];
}

function isPassedCheck(value) {
  return value && typeof value === "object" && value.status === "passed";
}

async function main() {
  const args = process.argv.slice(2);
  const receiptPath = valueAfter(args, "--receipt");
  const expectedImage = valueAfter(args, "--candidate-image");
  const expectedRevision = valueAfter(args, "--candidate-revision");
  const expectedDigest = candidateDigest(expectedImage);

  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    fail(`cannot read JSON receipt at ${receiptPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!receipt || typeof receipt !== "object") fail("receipt must be an object");
  if (receipt.format !== "nyxdoc-release-qualification/v1") fail("unexpected receipt format");
  if (!receipt.candidate || typeof receipt.candidate !== "object") fail("candidate evidence is missing");
  if (receipt.candidate.image !== expectedImage) fail("candidate image does not match workflow digest");
  if (receipt.candidate.digest !== expectedDigest) fail("candidate digest does not match immutable image reference");
  if (receipt.candidate.revision !== expectedRevision) fail("candidate revision does not match the release commit");
  if (!receipt.baseline || typeof receipt.baseline !== "object" || typeof receipt.baseline.ref !== "string") {
    fail("historical baseline evidence is missing");
  }
  if (!receipt.checks || typeof receipt.checks !== "object") fail("check evidence is missing");

  for (const check of REQUIRED_CHECKS) {
    if (!isPassedCheck(receipt.checks[check])) fail(`required check ${check} is absent or not passed`);
  }

  console.log(JSON.stringify({
    status: "passed",
    format: receipt.format,
    candidate: receipt.candidate,
    baseline: receipt.baseline,
    requiredChecks: REQUIRED_CHECKS,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
