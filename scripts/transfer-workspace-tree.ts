import { loadEnvConfig } from "@next/env";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

loadEnvConfig(process.cwd());

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string) {
  const value = option(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function expectedOption(name: string) {
  const raw = requiredOption(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

async function main() {
  const [
    { recordWorkspaceAuditEvent },
    { createBackupGeneration, verifyBackupGeneration },
    { openDatabase, sqlite },
    { assertDatabaseIntegrity },
    { getAppMigrationPlan },
    { archiveDocument },
    { assertRuntimeConfiguration, getBackupRoot, getDatabasePath, getMediaRoot },
    {
      applyWorkspaceTreeTransfer,
      archiveWorkspaceAgentHistory,
      planWorkspaceAgentHistoryArchive,
      planWorkspaceTreeTransfer,
    },
  ] = await Promise.all([
    import("../src/lib/authz/permissions"),
    import("../src/lib/db/backup"),
    import("../src/lib/db/client"),
    import("../src/lib/db/integrity"),
    import("../src/lib/db/migrations"),
    import("../src/lib/documents/service"),
    import("../src/lib/config"),
    import("../src/lib/workspaces/transfer"),
  ]);

  assertRuntimeConfiguration();
  const input = {
    sourceWorkspaceId: requiredOption("--source"),
    targetWorkspaceId: requiredOption("--target"),
    rootDocumentId: requiredOption("--root"),
    agentId: requiredOption("--agent"),
  };
  const targetStarterDocumentId = option("--archive-target-document")?.trim() || null;
  const shouldArchiveOutsideHistory = process.argv.includes("--archive-outside-history");
  const archiveHistoryName = option("--archive-history-name")?.trim() || "과거 에이전트 기록";
  const historyInput = {
    sourceWorkspaceId: input.sourceWorkspaceId,
    rootDocumentId: input.rootDocumentId,
    agentId: input.agentId,
    displayName: archiveHistoryName,
  };
  const shouldApply = process.argv.includes("--apply");
  const migrationPlan = getAppMigrationPlan(sqlite);
  if (migrationPlan.pending.length) {
    throw new Error(`Run database migrations first: ${migrationPlan.pending.map((item) => item.id).join(", ")}`);
  }

  const integrity = assertDatabaseIntegrity(sqlite);
  const plan = planWorkspaceTreeTransfer(sqlite, input);
  const historyPlan = planWorkspaceAgentHistoryArchive(sqlite, historyInput);
  const archiveResolvableBlockerPrefixes = [
    "에이전트가 이전 범위 밖에 남긴 문서 리비전",
    "에이전트가 이전 범위 밖에 남긴 변경 이벤트",
    "연결 키의 재시도 기록",
    "연결 키로 올렸지만 이전 문서가 사용하지 않는 이미지",
  ];
  function canArchiveResolve(candidate: typeof plan, candidateHistory: typeof historyPlan) {
    return candidate.status === "blocked"
      && candidateHistory.status === "ready"
      && candidate.blockers.length > 0
      && candidate.blockers.every((blocker) => (
        archiveResolvableBlockerPrefixes.some((prefix) => blocker.startsWith(prefix))
      ));
  }
  const archiveResolvesCurrentBlockers = canArchiveResolve(plan, historyPlan);
  const projectedTransferCounts = archiveResolvesCurrentBlockers
    ? {
      ...plan.counts,
      writeReceipts: plan.counts.writeReceipts - historyPlan.counts.writeReceipts,
    }
    : plan.counts;
  const starter = targetStarterDocumentId
    ? sqlite.prepare(
      `SELECT id, workspace_id, title, status, lifecycle_state, current_revision_id
       FROM documents WHERE id = ?`,
    ).get(targetStarterDocumentId) as {
      id: string;
      workspace_id: string;
      title: string;
      status: string;
      lifecycle_state: string;
      current_revision_id: string | null;
    } | undefined
    : undefined;
  const preview = {
    mode: shouldApply ? "apply" : "dry-run",
    integrity,
    plan,
    historyArchive: {
      requested: shouldArchiveOutsideHistory,
      displayName: archiveHistoryName,
      plan: historyPlan,
      resolvesCurrentTransferBlockers: archiveResolvesCurrentBlockers,
      projectedTransferCounts,
    },
    targetStarterDocument: starter ? {
      id: starter.id,
      title: starter.title,
      workspaceId: starter.workspace_id,
      status: starter.status,
      lifecycleState: starter.lifecycle_state,
    } : null,
  };

  if (!shouldApply) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  if (plan.status === "blocked" && !(shouldArchiveOutsideHistory && archiveResolvesCurrentBlockers)) {
    throw new Error(`Transfer is blocked: ${plan.blockers.join(" ")}`);
  }
  if (shouldArchiveOutsideHistory && historyPlan.status === "blocked") {
    throw new Error(`History archive is blocked: ${historyPlan.blockers.join(" ")}`);
  }
  if (requiredOption("--confirm-root") !== input.rootDocumentId) {
    throw new Error("--confirm-root must exactly match --root.");
  }
  if (targetStarterDocumentId && (!starter || starter.workspace_id !== input.targetWorkspaceId)) {
    throw new Error("--archive-target-document must identify a document in the target workspace.");
  }

  const expected = {
    documents: expectedOption("--expect-documents"),
    blocks: expectedOption("--expect-blocks"),
    revisions: expectedOption("--expect-revisions"),
    events: expectedOption("--expect-events"),
    internalReferences: expectedOption("--expect-internal-references"),
    media: expectedOption("--expect-media"),
    credentials: expectedOption("--expect-credentials"),
    writeReceipts: expectedOption("--expect-write-receipts"),
  };
  const expectedHistory = shouldArchiveOutsideHistory ? {
    documents: expectedOption("--expect-archived-documents"),
    revisions: expectedOption("--expect-archived-revisions"),
    events: expectedOption("--expect-archived-events"),
    writeReceipts: expectedOption("--expect-archived-write-receipts"),
    media: expectedOption("--expect-archived-media"),
  } : null;
  function assertExpectedPlan(candidate: typeof plan) {
    if (candidate.status !== "ready") return;
    for (const [key, expectedValue] of Object.entries(expected)) {
      const actual = candidate.counts[key as keyof typeof candidate.counts];
      if (actual !== expectedValue) {
        throw new Error(`Expected ${key}=${expectedValue}, found ${actual}.`);
      }
    }
  }
  function assertExpectedHistoryPlan(candidate: typeof historyPlan) {
    if (!expectedHistory) return;
    if (candidate.status === "blocked") {
      throw new Error(`History archive is blocked: ${candidate.blockers.join(" ")}`);
    }
    for (const [key, expectedValue] of Object.entries(expectedHistory)) {
      const actual = candidate.counts[key as keyof typeof candidate.counts];
      if (actual !== expectedValue) {
        throw new Error(`Expected archived ${key}=${expectedValue}, found ${actual}.`);
      }
    }
  }
  assertExpectedPlan(plan);
  assertExpectedHistoryPlan(historyPlan);

  const sourceRevision = process.env.NYXDOC_SOURCE_REVISION?.trim() || "workspace-transfer";
  const databasePath = getDatabasePath();
  if (databasePath === ":memory:") throw new Error("Workspace transfer requires a file database.");
  const backup = await createBackupGeneration({
    databasePath,
    mediaRoot: getMediaRoot(),
    backupRoot: getBackupRoot(),
    sourceRevision,
  });
  await verifyBackupGeneration(backup.generationPath);
  const receiptPath = path.join(backup.generationPath, "workspace-transfer-receipt.json");
  const temporary = await mkdtemp(path.join(tmpdir(), "nyxdoc-workspace-transfer-"));
  const clonePath = path.join(temporary, "preflight.db");
  const startedAt = new Date().toISOString();

  function archiveTargetStarter(database: typeof sqlite) {
    if (!targetStarterDocumentId) return { status: "not_requested" as const };
    const row = database.prepare(
      `SELECT workspace_id, title, status, lifecycle_state,
              (SELECT revision_number FROM document_revisions
               WHERE id = documents.current_revision_id) AS revision_number
       FROM documents WHERE id = ?`,
    ).get(targetStarterDocumentId) as {
      workspace_id: string;
      title: string;
      status: string;
      lifecycle_state: string;
      revision_number: number | null;
    } | undefined;
    if (!row || row.workspace_id !== input.targetWorkspaceId) {
      throw new Error("Target starter document disappeared or crossed a workspace boundary.");
    }
    if (row.lifecycle_state === "trashed") {
      return { status: "already_trashed" as const, title: row.title };
    }
    if (row.status !== "active" || row.lifecycle_state !== "active" || !row.revision_number) {
      throw new Error(`Target starter document has unsupported state ${row.status}/${row.lifecycle_state}.`);
    }
    const result = archiveDocument(database, input.targetWorkspaceId, {
      type: "system",
      userId: "system",
      label: "Nyxdoc 워크스페이스 이전",
      source: "migration",
    }, targetStarterDocumentId, { baseRevision: Number(row.revision_number) });
    return { status: "trashed" as const, title: row.title, ...result };
  }

  function verifyTransferredState(database: typeof sqlite) {
    const rows = database.prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM documents WHERE id = ? AND workspace_id = ?
         UNION ALL
         SELECT document.id FROM documents document JOIN tree ON document.parent_document_id = tree.id
         WHERE document.workspace_id = ?
       ) SELECT id FROM tree`,
    ).all(input.rootDocumentId, input.targetWorkspaceId, input.targetWorkspaceId) as Array<{ id: string }>;
    if (rows.length !== expected.documents) {
      throw new Error(`Transferred tree count mismatch: ${rows.length} != ${expected.documents}.`);
    }
    const documentIds = rows.map((row) => row.id);
    const placeholders = documentIds.map(() => "?").join(",");
    const treeCounts = {
      blocks: Number((database.prepare(
        `SELECT COUNT(*) AS count FROM document_blocks WHERE document_id IN (${placeholders})`,
      ).get(...documentIds) as { count: number }).count),
      revisions: Number((database.prepare(
        `SELECT COUNT(*) AS count FROM document_revisions WHERE document_id IN (${placeholders})`,
      ).get(...documentIds) as { count: number }).count),
      events: Number((database.prepare(
        `SELECT COUNT(*) AS count FROM document_events
         WHERE workspace_id = ? AND document_id IN (${placeholders})`,
      ).get(input.targetWorkspaceId, ...documentIds) as { count: number }).count),
      internalReferences: Number((database.prepare(
        `SELECT COUNT(*) AS count FROM document_references
         WHERE source_document_id IN (${placeholders})
           AND target_document_id IN (${placeholders})`,
      ).get(...documentIds, ...documentIds) as { count: number }).count),
    };
    for (const [key, value] of Object.entries(treeCounts)) {
      const expectedValue = expected[key as keyof typeof treeCounts];
      if (value !== expectedValue) {
        throw new Error(`Transferred ${key} count mismatch: ${value} != ${expectedValue}.`);
      }
    }
    const agent = database.prepare(
      "SELECT workspace_id FROM workspace_agents WHERE id = ?",
    ).get(input.agentId) as { workspace_id: string } | undefined;
    if (agent?.workspace_id !== input.targetWorkspaceId) throw new Error("Agent was not transferred.");
    const credentials = database.prepare(
      "SELECT id FROM workspace_api_tokens WHERE workspace_id = ? AND agent_id = ?",
    ).all(input.targetWorkspaceId, input.agentId) as Array<{ id: string }>;
    if (credentials.length !== expected.credentials) {
      throw new Error(`Credential count mismatch: ${credentials.length} != ${expected.credentials}.`);
    }
    const credentialIds = credentials.map((credential) => credential.id);
    const receipts = credentialIds.length
      ? Number((database.prepare(
        `SELECT COUNT(*) AS count FROM agent_write_requests
         WHERE token_id IN (${credentialIds.map(() => "?").join(",")})`,
      ).get(...credentialIds) as { count: number }).count)
      : 0;
    if (receipts !== expected.writeReceipts) {
      throw new Error(`Write receipt count mismatch: ${receipts} != ${expected.writeReceipts}.`);
    }
    assertDatabaseIntegrity(database);
  }

  function execute(database: typeof sqlite) {
    let before = planWorkspaceTreeTransfer(database, input);
    let result = before;
    let historyResult: ReturnType<typeof archiveWorkspaceAgentHistory> | {
      plan: typeof historyPlan;
      archiveAgentId: null;
      archiveCredentialId: null;
    } = {
      plan: planWorkspaceAgentHistoryArchive(database, historyInput),
      archiveAgentId: null,
      archiveCredentialId: null,
    };
    let starterResult: ReturnType<typeof archiveTargetStarter> = { status: "not_requested" };
    database.transaction(() => {
      const currentHistoryPlan = planWorkspaceAgentHistoryArchive(database, historyInput);
      assertExpectedHistoryPlan(currentHistoryPlan);
      if (shouldArchiveOutsideHistory && currentHistoryPlan.status === "ready") {
        historyResult = archiveWorkspaceAgentHistory(database, historyInput);
      }
      before = planWorkspaceTreeTransfer(database, input);
      if (before.status === "blocked") {
        throw new Error(`Transfer is blocked after history archival: ${before.blockers.join(" ")}`);
      }
      assertExpectedPlan(before);
      if (before.status === "ready") result = applyWorkspaceTreeTransfer(database, input);
      starterResult = archiveTargetStarter(database);
      if (before.status === "ready") {
        const metadata = {
          sourceWorkspaceId: input.sourceWorkspaceId,
          targetWorkspaceId: input.targetWorkspaceId,
          rootDocumentId: input.rootDocumentId,
          agentId: input.agentId,
          backupGenerationId: backup.manifest.generationId,
          counts: before.counts,
        };
        recordWorkspaceAuditEvent(database, {
          workspaceId: input.sourceWorkspaceId,
          action: "workspace.tree_transferred_out",
          actorType: "system",
          actorLabel: "Nyxdoc 워크스페이스 이전",
          targetType: "document_tree",
          targetId: input.rootDocumentId,
          metadata,
        });
        recordWorkspaceAuditEvent(database, {
          workspaceId: input.targetWorkspaceId,
          action: "workspace.tree_transferred_in",
          actorType: "system",
          actorLabel: "Nyxdoc 워크스페이스 이전",
          targetType: "document_tree",
          targetId: input.rootDocumentId,
          metadata,
        });
      }
      verifyTransferredState(database);
    }).immediate();
    return {
      historyArchive: historyResult,
      transfer: result,
      targetStarter: starterResult,
    };
  }

  try {
    await copyFile(path.join(backup.generationPath, "nyxdoc.db"), clonePath);
    const clone = openDatabase(clonePath);
    try {
      execute(clone);
    } finally {
      clone.close();
    }
    const result = execute(sqlite);
    const receipt = {
      format: "nyxdoc-workspace-transfer-receipt/v1",
      outcome: "succeeded",
      sourceRevision,
      backupGenerationId: backup.manifest.generationId,
      backupDatabaseSha256: backup.manifest.database.sha256,
      input,
      expected,
      expectedHistory,
      result,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      status: "transferred",
      backupGeneration: backup.generationPath,
      result,
    }, null, 2));
  } catch (error) {
    await writeFile(receiptPath, `${JSON.stringify({
      format: "nyxdoc-workspace-transfer-receipt/v1",
      outcome: "failed",
      sourceRevision,
      backupGenerationId: backup.manifest.generationId,
      backupDatabaseSha256: backup.manifest.database.sha256,
      input,
      expected,
      expectedHistory,
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Workspace transfer failed.", error);
  process.exitCode = 1;
});
