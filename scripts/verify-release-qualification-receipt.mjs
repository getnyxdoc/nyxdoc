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
const DATABASE_TABLES = [
  "user",
  "workspaces",
  "workspace_members",
  "documents",
  "document_revisions",
  "media_assets",
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function gitRevision(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => nonEmptyString(entry));
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function immutableImageDigest(image, label) {
  const match = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/u.exec(image);
  if (!match) fail(`${label} must be an immutable image@sha256 digest reference`);
  return match[2];
}

function immutableImageFor(reference, digest) {
  return `${reference.split("@")[0]}@${digest}`;
}

function assertSameHistoricalFields(left, right, fields, message) {
  for (const field of fields) {
    if (!equalJson(left[field], right[field])) fail(`${message}: ${field}`);
  }
}

function validateDatabaseSnapshot(value, label) {
  if (!isPlainObject(value)) fail(`${label} database evidence is missing`);
  if (value.integrity !== "ok") fail(`${label} database integrity evidence is not ok`);
  if (!nonNegativeInteger(value.userVersion)) {
    fail(`${label} database userVersion evidence is invalid`);
  }
  if (!isPlainObject(value.rows)) fail(`${label} database row-count evidence is missing`);
  for (const table of DATABASE_TABLES) {
    if (!nonNegativeInteger(value.rows[table])) {
      fail(`${label} database row-count evidence is missing or invalid for ${table}`);
    }
  }
  return value;
}

function validateDatabaseEvidence(receipt) {
  if (!isPlainObject(receipt.database)) fail("database qualification evidence is missing");
  const baseline = validateDatabaseSnapshot(receipt.database.baseline, "baseline");
  const candidate = validateDatabaseSnapshot(receipt.database.candidate, "candidate");
  if (candidate.userVersion < baseline.userVersion) {
    fail("candidate database userVersion regressed from the baseline");
  }
  for (const table of DATABASE_TABLES) {
    if (baseline.rows[table] < 1) {
      fail(`baseline historical fixture did not populate ${table}`);
    }
    if (candidate.rows[table] < baseline.rows[table]) {
      fail(`candidate database row count regressed for ${table}`);
    }
  }
}

function validateHistoricalObjectEvidence(value, label, expectedStage) {
  if (!isPlainObject(value)) fail(`${label} historical fixture evidence is missing`);
  if (value.format !== "nyxdoc-release-historical-evidence/v1") {
    fail(`${label} historical fixture evidence has an unexpected format`);
  }
  if (value.stage !== expectedStage) {
    fail(`${label} historical fixture evidence has an unexpected stage`);
  }
  for (const field of [
    "workspaceId",
    "parentDocumentId",
    "nestedDocumentId",
    "nestedDocumentTitle",
    "parentDocumentIdFromNested",
  ]) {
    if (!nonEmptyString(value[field])) {
      fail(`${label} historical fixture evidence is missing ${field}`);
    }
  }
  if (value.parentDocumentIdFromNested !== value.parentDocumentId) {
    fail(`${label} historical fixture parent relationship is inconsistent`);
  }
  for (const field of [
    "parentContentSha256",
    "canonicalContentSha256",
    "workingContentSha256",
  ]) {
    if (!sha256(value[field])) fail(`${label} historical fixture evidence has an invalid ${field}`);
  }
  if (!nonEmptyStringArray(value.canonicalRevisionIds)
    || !Array.isArray(value.canonicalRevisionContentSha256)
    || value.canonicalRevisionContentSha256.length !== value.canonicalRevisionIds.length
    || !value.canonicalRevisionContentSha256.every((entry) => sha256(entry))
    || value.canonicalRevisionCount !== value.canonicalRevisionIds.length
    || !positiveInteger(value.canonicalRevisionNumber)) {
    fail(`${label} historical fixture revision evidence is invalid`);
  }
  if (!nonEmptyStringArray(value.canonicalBlockIds)
    || !nonEmptyStringArray(value.workingBlockIds)) {
    fail(`${label} historical fixture block evidence is invalid`);
  }
  if (!isPlainObject(value.draft)
    || !nonNegativeInteger(value.draft.generation)
    || !positiveInteger(value.draft.draftVersion)
    || !nonNegativeInteger(value.draft.committedDraftVersion)
    || value.draft.committedDraftVersion > value.draft.draftVersion
    || !nonEmptyString(value.draft.baseRevisionId)
    || !positiveInteger(value.draft.baseRevisionNumber)
    || typeof value.draft.hasUncommittedChanges !== "boolean") {
    fail(`${label} historical fixture draft evidence is invalid`);
  }
  if (!isPlainObject(value.media)
    || !nonEmptyString(value.media.id)
    || !nonEmptyString(value.media.mimeType)
    || !positiveInteger(value.media.byteSize)
    || !sha256(value.media.sha256)) {
    fail(`${label} historical fixture media evidence is invalid`);
  }
  return value;
}

function validateBackupRestoreEvidence(receipt) {
  const fixture = receipt.historicalFixture;
  if (!isPlainObject(fixture)) fail("historical fixture evidence is missing");
  const source = validateHistoricalObjectEvidence(
    fixture.normalReinstall,
    "pre-backup reinstall",
    "candidate-normal-reinstall",
  );
  const restored = validateHistoricalObjectEvidence(
    fixture.isolatedRestore,
    "isolated restore",
    "candidate-isolated-restore",
  );
  for (const field of [
    "workspaceId",
    "parentDocumentId",
    "nestedDocumentId",
    "nestedDocumentTitle",
    "parentDocumentIdFromNested",
    "parentContentSha256",
    "canonicalContentSha256",
    "workingContentSha256",
    "canonicalRevisionCount",
    "canonicalRevisionNumber",
  ]) {
    if (restored[field] !== source[field]) {
      fail(`isolated restore ${field} does not match the pre-backup fixture`);
    }
  }
  for (const field of [
    "canonicalRevisionIds",
    "canonicalRevisionContentSha256",
    "canonicalBlockIds",
    "workingBlockIds",
    "draft",
    "media",
  ]) {
    if (!equalJson(restored[field], source[field])) {
      fail(`isolated restore ${field} does not match the pre-backup fixture`);
    }
  }

  const backup = receipt.backupRestore;
  if (!isPlainObject(backup)) fail("backup and restore evidence is missing");
  if (!nonEmptyString(backup.generationId)
    || !/^[A-Za-z0-9._-]+$/u.test(backup.generationId)) {
    fail("backup generation ID evidence is invalid");
  }
  if (backup.generationPath !== `/backups/${backup.generationId}`) {
    fail("backup generation path does not match its generation ID");
  }
  if (!sha256(backup.databaseSha256)) fail("backup database hash evidence is invalid");
  if (!sha256(backup.mediaTreeSha256)) fail("backup media tree hash evidence is invalid");
  if (!positiveInteger(backup.mediaFiles)) fail("backup media file-count evidence is invalid");
  if (!positiveInteger(backup.mediaBytes)
    || backup.mediaBytes < restored.media.byteSize) {
    fail("backup media byte-count evidence is invalid");
  }
  if (backup.restoreStatus !== "restored-and-verified") {
    fail("backup restore did not report restored-and-verified");
  }
  if (backup.targetVolumeWasEmpty !== true) {
    fail("isolated restore target was not proven empty");
  }
}

function validateHistoricalBridgeEvidence(receipt) {
  const fixture = receipt.historicalFixture;
  if (!isPlainObject(fixture)) fail("historical fixture evidence is missing");

  const websocket = fixture.websocketBeforeFirstHop;
  if (!isPlainObject(websocket)) fail("historical WebSocket mutation evidence is missing");
  if (websocket.format !== "nyxdoc-release-historical-evidence/v1") {
    fail("historical WebSocket mutation evidence has an unexpected format");
  }
  if (websocket.stage !== "baseline-websocket-dirty") {
    fail("historical WebSocket mutation evidence must describe the baseline WebSocket draft");
  }
  for (const field of ["workspaceId", "parentDocumentId", "nestedDocumentId", "workingContentSha256"]) {
    if (!nonEmptyString(websocket[field])) fail(`historical WebSocket mutation evidence is missing ${field}`);
  }
  if (!sha256(websocket.workingContentSha256)) {
    fail("historical WebSocket mutation evidence has an invalid working content hash");
  }
  if (!Array.isArray(websocket.workingBlockIds)
    || !websocket.workingBlockIds.includes("rq-historical-websocket-first-hop")) {
    fail("historical WebSocket mutation evidence does not contain the required first-hop block");
  }
  if (!isPlainObject(websocket.draft)
    || websocket.draft.hasUncommittedChanges !== true
    || !nonNegativeInteger(websocket.draft.draftVersion)
    || websocket.draft.draftVersion < 1
    || !nonNegativeInteger(websocket.draft.committedDraftVersion)
    || websocket.draft.committedDraftVersion > websocket.draft.draftVersion) {
    fail("historical WebSocket mutation evidence has an invalid dirty draft state");
  }

  const backup = fixture.legacyBridgeBackup;
  if (!isPlainObject(backup)) fail("legacy bridge backup evidence is missing");
  if (backup.format !== "nyxdoc-release-historical-backup-evidence/v1") {
    fail("legacy bridge backup evidence has an unexpected format");
  }
  if (backup.status !== "passed") fail("legacy bridge backup evidence is not passed");
  if (!nonEmptyString(backup.generationPath)
    || !/^\/backups\/[A-Za-z0-9._-]+$/u.test(backup.generationPath)) {
    fail("legacy bridge backup evidence has an invalid generation path");
  }
  if (!nonEmptyString(backup.documentId)
    || !sha256(backup.workingContentSha256)
    || !nonNegativeInteger(backup.draftVersion)) {
    fail("legacy bridge backup evidence is structurally incomplete");
  }
  if (backup.documentId !== websocket.nestedDocumentId) {
    fail("legacy bridge backup document does not match the WebSocket mutation document");
  }
  if (backup.workingContentSha256 !== websocket.workingContentSha256) {
    fail("legacy bridge backup content hash does not match the WebSocket mutation");
  }
  if (backup.draftVersion !== websocket.draft.draftVersion) {
    fail("legacy bridge backup draft version does not match the WebSocket mutation");
  }
}

function validateHistoricalTransitions(receipt) {
  const fixture = receipt.historicalFixture;
  if (!isPlainObject(fixture)) fail("historical fixture evidence is missing");
  const baselineDirty = validateHistoricalObjectEvidence(
    fixture.baselineDirty,
    "baseline dirty",
    "baseline-dirty",
  );
  const candidateDirty = validateHistoricalObjectEvidence(
    fixture.candidateDirty,
    "candidate dirty",
    "candidate-upgrade-dirty",
  );
  const normalReinstall = validateHistoricalObjectEvidence(
    fixture.normalReinstall,
    "normal reinstall",
    "candidate-normal-reinstall",
  );
  const candidateCommitted = validateHistoricalObjectEvidence(
    fixture.candidateCommitted,
    "candidate committed",
    "candidate-commit-reload",
  );

  if (baselineDirty.draft.hasUncommittedChanges !== true
    || baselineDirty.draft.committedDraftVersion >= baselineDirty.draft.draftVersion) {
    fail("baseline dirty evidence must prove an uncommitted draft");
  }

  const preservedCanonicalFields = [
    "workspaceId",
    "parentDocumentId",
    "nestedDocumentId",
    "nestedDocumentTitle",
    "parentDocumentIdFromNested",
    "parentContentSha256",
    "canonicalContentSha256",
    "canonicalRevisionIds",
    "canonicalRevisionContentSha256",
    "canonicalRevisionCount",
    "canonicalRevisionNumber",
    "canonicalBlockIds",
    "media",
  ];
  assertSameHistoricalFields(
    baselineDirty,
    candidateDirty,
    preservedCanonicalFields,
    "candidate dirty evidence did not preserve the baseline canonical fixture",
  );

  const websocket = fixture.websocketBeforeFirstHop;
  if (!isPlainObject(websocket)) fail("historical WebSocket mutation evidence is missing");
  assertSameHistoricalFields(
    websocket,
    candidateDirty,
    ["workspaceId", "parentDocumentId", "nestedDocumentId", "workingContentSha256", "workingBlockIds", "draft"],
    "candidate dirty evidence does not match the accepted WebSocket draft",
  );

  const dirtyFields = [
    ...preservedCanonicalFields,
    "workingContentSha256",
    "workingBlockIds",
    "draft",
  ];
  assertSameHistoricalFields(
    candidateDirty,
    normalReinstall,
    dirtyFields,
    "normal reinstall evidence did not preserve the candidate dirty fixture",
  );

  assertSameHistoricalFields(
    candidateDirty,
    candidateCommitted,
    ["workspaceId", "parentDocumentId", "nestedDocumentId", "nestedDocumentTitle", "parentDocumentIdFromNested", "parentContentSha256", "media"],
    "candidate committed evidence changed fixture identity",
  );
  if (candidateCommitted.canonicalContentSha256 !== candidateDirty.workingContentSha256
    || candidateCommitted.workingContentSha256 !== candidateDirty.workingContentSha256
    || !equalJson(candidateCommitted.canonicalBlockIds, candidateDirty.workingBlockIds)
    || !equalJson(candidateCommitted.workingBlockIds, candidateDirty.workingBlockIds)) {
    fail("candidate committed evidence does not canonically contain the candidate dirty content");
  }
  if (candidateCommitted.canonicalRevisionCount !== candidateDirty.canonicalRevisionCount + 1
    || candidateCommitted.canonicalRevisionNumber !== candidateDirty.canonicalRevisionNumber + 1
    || candidateCommitted.canonicalRevisionIds.length !== candidateDirty.canonicalRevisionIds.length + 1
    || candidateCommitted.canonicalRevisionContentSha256.length
      !== candidateDirty.canonicalRevisionContentSha256.length + 1
    || !equalJson(
      candidateCommitted.canonicalRevisionIds.slice(0, -1),
      candidateDirty.canonicalRevisionIds,
    )
    || !equalJson(
      candidateCommitted.canonicalRevisionContentSha256.slice(0, -1),
      candidateDirty.canonicalRevisionContentSha256,
    )
    || candidateCommitted.canonicalRevisionContentSha256.at(-1)
      !== candidateDirty.workingContentSha256) {
    fail("candidate committed evidence does not append exactly one canonical revision for the candidate dirty content");
  }
  if (candidateCommitted.draft.hasUncommittedChanges !== false
    || candidateCommitted.draft.committedDraftVersion !== candidateCommitted.draft.draftVersion
    || candidateCommitted.draft.baseRevisionId !== candidateCommitted.canonicalRevisionIds.at(-1)
    || candidateCommitted.draft.baseRevisionNumber !== candidateCommitted.canonicalRevisionNumber
    || candidateCommitted.draft.generation < candidateDirty.draft.generation) {
    fail("candidate committed evidence does not prove the candidate dirty draft was committed and reloaded");
  }
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
  if (!receipt.baseline || !isPlainObject(receipt.baseline)
    || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(receipt.baseline.ref)) {
    fail("historical baseline evidence is missing");
  }
  if (!nonEmptyString(receipt.baseline.image)
    || !gitRevision(receipt.baseline.revision)
    || !sha256(receipt.baseline.digest?.replace(/^sha256:/u, ""))
    || immutableImageDigest(receipt.baseline.immutableImage, "baseline immutable image")
      !== receipt.baseline.digest
    || receipt.baseline.immutableImage
      !== immutableImageFor(receipt.baseline.image, receipt.baseline.digest)) {
    fail("historical baseline image and revision evidence is inconsistent");
  }
  if (!receipt.checks || typeof receipt.checks !== "object") fail("check evidence is missing");

  for (const check of REQUIRED_CHECKS) {
    if (!isPassedCheck(receipt.checks[check])) fail(`required check ${check} is absent or not passed`);
  }

  validateDatabaseEvidence(receipt);
  validateHistoricalBridgeEvidence(receipt);
  validateHistoricalTransitions(receipt);
  validateBackupRestoreEvidence(receipt);

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
