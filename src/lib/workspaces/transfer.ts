import { createHash, randomBytes, randomUUID } from "node:crypto";
import { recordWorkspaceAuditEvent } from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import { assertDatabaseIntegrity } from "@/lib/db/integrity";

export type WorkspaceTreeTransferInput = {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  rootDocumentId: string;
  agentId?: string;
};

export type WorkspaceTreeTransferPlan = {
  status: "ready" | "blocked" | "already_applied";
  sourceWorkspace: { id: string; name: string } | null;
  targetWorkspace: { id: string; name: string } | null;
  rootDocument: { id: string; title: string } | null;
  counts: {
    documents: number;
    blocks: number;
    revisions: number;
    events: number;
    internalReferences: number;
    media: number;
    credentials: number;
    writeReceipts: number;
  };
  blockers: string[];
};

export type WorkspaceAgentHistoryArchiveInput = Pick<
  WorkspaceTreeTransferInput,
  "sourceWorkspaceId" | "rootDocumentId" | "agentId"
> & { agentId: string; displayName: string };

export type WorkspaceAgentHistoryArchivePlan = {
  status: "ready" | "blocked" | "not_needed";
  counts: {
    documents: number;
    revisions: number;
    events: number;
    writeReceipts: number;
    media: number;
  };
  blockers: string[];
};

export type WorkspaceAgentHistoryArchiveResult = {
  plan: WorkspaceAgentHistoryArchivePlan;
  archiveAgentId: string | null;
  archiveCredentialId: string | null;
};

type DocumentTransferRow = {
  depth: number;
  id: string;
  parent_document_id: string | null;
  slug: string;
  title: string;
};

type AgentTransferRow = {
  avatar_media_id: string | null;
  display_name: string;
  id: string;
  workspace_id: string;
};

type CredentialTransferRow = {
  id: string;
  root_document_id: string | null;
};

type MediaTransferRow = {
  id: string;
  sha256: string;
  uploaded_by_token_id: string | null;
  workspace_id: string;
};

type PreparedTransfer = {
  plan: WorkspaceTreeTransferPlan;
  documents: DocumentTransferRow[];
  agent: AgentTransferRow | null;
  credentials: CredentialTransferRow[];
  media: MediaTransferRow[];
};

type PreparedHistoryArchive = {
  plan: WorkspaceAgentHistoryArchivePlan;
  creatorUserId: string | null;
  revisionIds: string[];
  eventIds: string[];
  receipts: Array<{ token_id: string; request_id: string }>;
  mediaIds: string[];
};

function placeholders(values: unknown[]) {
  return values.map(() => "?").join(",");
}

function count(database: NyxDatabase, sql: string, ...args: unknown[]) {
  return Number((database.prepare(sql).get(...args) as { count: number }).count);
}

function collectMediaIds(value: unknown, output: Set<string>) {
  let root = value;
  if (typeof value === "string") {
    try {
      root = JSON.parse(value);
    } catch {
      return;
    }
  }
  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "img" && typeof record.mediaId === "string") {
      output.add(record.mediaId);
    }
    Object.values(record).forEach(visit);
  }
  visit(root);
}

function documentMediaIds(database: NyxDatabase, documentIds: string[]) {
  const media = new Set<string>();
  if (documentIds.length === 0) return media;
  const ids = placeholders(documentIds);
  for (const row of database.prepare(
    `SELECT content_json FROM document_blocks WHERE document_id IN (${ids})`,
  ).all(...documentIds) as Array<{ content_json: string | null }>) {
    collectMediaIds(row.content_json, media);
  }
  for (const row of database.prepare(
    `SELECT snapshot_json FROM document_revisions WHERE document_id IN (${ids})`,
  ).all(...documentIds) as Array<{ snapshot_json: string }>) {
    collectMediaIds(row.snapshot_json, media);
  }
  return media;
}

function workspace(database: NyxDatabase, id: string) {
  return database.prepare("SELECT id, name FROM workspaces WHERE id = ?")
    .get(id) as { id: string; name: string } | undefined;
}

function emptyCounts(): WorkspaceTreeTransferPlan["counts"] {
  return {
    documents: 0,
    blocks: 0,
    revisions: 0,
    events: 0,
    internalReferences: 0,
    media: 0,
    credentials: 0,
    writeReceipts: 0,
  };
}

function emptyHistoryCounts(): WorkspaceAgentHistoryArchivePlan["counts"] {
  return { documents: 0, revisions: 0, events: 0, writeReceipts: 0, media: 0 };
}

function prepareWorkspaceAgentHistoryArchive(
  database: NyxDatabase,
  input: WorkspaceAgentHistoryArchiveInput,
): PreparedHistoryArchive {
  const blockers: string[] = [];
  const displayName = input.displayName.trim().replace(/\s+/g, " ");
  if (!displayName || displayName.length > 80) {
    blockers.push("보관 에이전트 이름은 1자 이상 80자 이하여야 합니다.");
  }
  const source = workspace(database, input.sourceWorkspaceId);
  if (!source) blockers.push("원본 워크스페이스를 찾을 수 없습니다.");
  const root = database.prepare(
    "SELECT workspace_id FROM documents WHERE id = ?",
  ).get(input.rootDocumentId) as { workspace_id: string } | undefined;
  if (!root || root.workspace_id !== input.sourceWorkspaceId) {
    blockers.push("보관 기준 루트 문서가 원본 워크스페이스에 없습니다.");
  }
  const agent = database.prepare(
    "SELECT workspace_id, created_by_user_id FROM workspace_agents WHERE id = ?",
  ).get(input.agentId) as { workspace_id: string; created_by_user_id: string } | undefined;
  if (!agent || agent.workspace_id !== input.sourceWorkspaceId) {
    blockers.push("보관할 에이전트가 원본 워크스페이스에 없습니다.");
  }
  if (!source || !root || root.workspace_id !== input.sourceWorkspaceId || !agent) {
    return {
      plan: { status: "blocked", counts: emptyHistoryCounts(), blockers },
      creatorUserId: null,
      revisionIds: [],
      eventIds: [],
      receipts: [],
      mediaIds: [],
    };
  }

  const treeIds = (database.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM documents WHERE id = ? AND workspace_id = ?
       UNION ALL
       SELECT document.id FROM documents document JOIN tree ON document.parent_document_id = tree.id
       WHERE document.workspace_id = ?
     ) SELECT id FROM tree`,
  ).all(input.rootDocumentId, input.sourceWorkspaceId, input.sourceWorkspaceId) as Array<{ id: string }>)
    .map((row) => row.id);
  const treePlaceholders = placeholders(treeIds);
  const credentialIds = (database.prepare(
    "SELECT id FROM workspace_api_tokens WHERE workspace_id = ? AND agent_id = ?",
  ).all(input.sourceWorkspaceId, input.agentId) as Array<{ id: string }>).map((row) => row.id);
  if (!credentialIds.length) blockers.push("보관할 에이전트의 연결 키를 찾을 수 없습니다.");
  const credentialPlaceholders = placeholders(credentialIds);
  if (!credentialIds.length) {
    return {
      plan: { status: "blocked", counts: emptyHistoryCounts(), blockers },
      creatorUserId: agent.created_by_user_id,
      revisionIds: [],
      eventIds: [],
      receipts: [],
      mediaIds: [],
    };
  }

  const revisionIds = (database.prepare(
    `SELECT revision.id
     FROM document_revisions revision
     JOIN documents document ON document.id = revision.document_id
     WHERE document.workspace_id = ? AND document.id NOT IN (${treePlaceholders})
       AND (revision.actor_principal_id = ?
            OR revision.actor_token_id IN (${credentialPlaceholders}))`,
  ).all(input.sourceWorkspaceId, ...treeIds, input.agentId, ...credentialIds) as Array<{ id: string }>)
    .map((row) => row.id);
  const eventIds = (database.prepare(
    `SELECT event.id
     FROM document_events event
     JOIN documents document ON document.id = event.document_id
     WHERE document.workspace_id = ? AND document.id NOT IN (${treePlaceholders})
       AND (event.actor_principal_id = ?
            OR event.actor_token_id IN (${credentialPlaceholders}))`,
  ).all(input.sourceWorkspaceId, ...treeIds, input.agentId, ...credentialIds) as Array<{ id: string }>)
    .map((row) => row.id);
  const receipts = database.prepare(
    `SELECT request.token_id, request.request_id, request.document_id,
            document.workspace_id, document.status, document.lifecycle_state
     FROM agent_write_requests request
     LEFT JOIN documents document ON document.id = request.document_id
     WHERE request.token_id IN (${credentialPlaceholders})
       AND (request.document_id IS NULL OR request.document_id NOT IN (${treePlaceholders}))`,
  ).all(...credentialIds, ...treeIds) as Array<{
    token_id: string;
    request_id: string;
    document_id: string | null;
    workspace_id: string | null;
    status: string | null;
    lifecycle_state: string | null;
  }>;
  if (receipts.some((receipt) => !receipt.document_id)) {
    blockers.push("문서를 가리키지 않는 과거 재시도 기록이 있어 자동 보관할 수 없습니다.");
  }

  const affectedDocumentIds = new Set<string>();
  if (revisionIds.length) {
    for (const row of database.prepare(
      `SELECT DISTINCT document_id FROM document_revisions WHERE id IN (${placeholders(revisionIds)})`,
    ).all(...revisionIds) as Array<{ document_id: string }>) affectedDocumentIds.add(row.document_id);
  }
  if (eventIds.length) {
    for (const row of database.prepare(
      `SELECT DISTINCT document_id FROM document_events WHERE id IN (${placeholders(eventIds)})`,
    ).all(...eventIds) as Array<{ document_id: string }>) affectedDocumentIds.add(row.document_id);
  }
  for (const receipt of receipts) if (receipt.document_id) affectedDocumentIds.add(receipt.document_id);
  if (affectedDocumentIds.size) {
    const rows = database.prepare(
      `SELECT id, workspace_id, status, lifecycle_state FROM documents
       WHERE id IN (${placeholders([...affectedDocumentIds])})`,
    ).all(...affectedDocumentIds) as Array<{
      id: string;
      workspace_id: string;
      status: string;
      lifecycle_state: string;
    }>;
    if (
      rows.length !== affectedDocumentIds.size
      || rows.some((row) => row.workspace_id !== input.sourceWorkspaceId
        || row.status !== "archived" || row.lifecycle_state !== "archived")
    ) {
      blockers.push("범위 밖 기록 중 보관 완료 상태가 아닌 문서가 있어 자동 분리할 수 없습니다.");
    }
  }
  const duplicateRequestIds = database.prepare(
    `SELECT request_id, COUNT(*) AS count FROM agent_write_requests
     WHERE token_id IN (${credentialPlaceholders})
       AND (document_id IS NULL OR document_id NOT IN (${treePlaceholders}))
     GROUP BY request_id HAVING COUNT(*) > 1`,
  ).all(...credentialIds, ...treeIds) as Array<{ request_id: string; count: number }>;
  if (duplicateRequestIds.length) {
    blockers.push("여러 연결 키가 같은 requestId를 사용한 과거 기록은 하나의 보관 키로 합칠 수 없습니다.");
  }

  const canonicalMediaIds = documentMediaIds(database, treeIds);
  const agentAvatar = database.prepare(
    "SELECT avatar_media_id FROM workspace_agents WHERE id = ?",
  ).get(input.agentId) as { avatar_media_id: string | null };
  if (agentAvatar.avatar_media_id) canonicalMediaIds.add(agentAvatar.avatar_media_id);
  const mediaIds = (database.prepare(
    `SELECT id FROM media_assets
     WHERE workspace_id = ? AND uploaded_by_token_id IN (${credentialPlaceholders})`,
  ).all(input.sourceWorkspaceId, ...credentialIds) as Array<{ id: string }>)
    .map((row) => row.id)
    .filter((id) => !canonicalMediaIds.has(id));
  const activeOutsideIds = (database.prepare(
    `SELECT id FROM documents
     WHERE workspace_id = ? AND lifecycle_state = 'active' AND id NOT IN (${treePlaceholders})`,
  ).all(input.sourceWorkspaceId, ...treeIds) as Array<{ id: string }>).map((row) => row.id);
  const activeOutsideMedia = documentMediaIds(database, activeOutsideIds);
  if (mediaIds.some((id) => activeOutsideMedia.has(id))) {
    blockers.push("보관 키로 분리할 이미지가 원본 워크스페이스의 활성 문서에서도 사용됩니다.");
  }

  const counts = {
    documents: affectedDocumentIds.size,
    revisions: revisionIds.length,
    events: eventIds.length,
    writeReceipts: receipts.length,
    media: mediaIds.length,
  };
  const hasHistory = Object.values(counts).some((value) => value > 0);
  return {
    plan: {
      status: blockers.length ? "blocked" : hasHistory ? "ready" : "not_needed",
      counts,
      blockers,
    },
    creatorUserId: agent.created_by_user_id,
    revisionIds,
    eventIds,
    receipts: receipts.map(({ token_id, request_id }) => ({ token_id, request_id })),
    mediaIds,
  };
}

export function planWorkspaceAgentHistoryArchive(
  database: NyxDatabase,
  input: WorkspaceAgentHistoryArchiveInput,
): WorkspaceAgentHistoryArchivePlan {
  return prepareWorkspaceAgentHistoryArchive(database, input).plan;
}

export function archiveWorkspaceAgentHistory(
  database: NyxDatabase,
  input: WorkspaceAgentHistoryArchiveInput,
): WorkspaceAgentHistoryArchiveResult {
  const initial = prepareWorkspaceAgentHistoryArchive(database, input);
  if (initial.plan.status === "not_needed") {
    return { plan: initial.plan, archiveAgentId: null, archiveCredentialId: null };
  }
  if (initial.plan.status !== "ready" || !initial.creatorUserId) {
    throw new Error(`Workspace agent history archive is blocked: ${initial.plan.blockers.join(" ")}`);
  }

  const result = database.transaction(() => {
    const prepared = prepareWorkspaceAgentHistoryArchive(database, input);
    if (prepared.plan.status !== "ready" || !prepared.creatorUserId) {
      throw new Error(`Workspace agent history archive changed during execution: ${prepared.plan.blockers.join(" ")}`);
    }
    const now = new Date().toISOString();
    const archiveAgentId = randomUUID();
    const archiveCredentialId = randomUUID();
    const archiveName = input.displayName.trim().replace(/\s+/g, " ");
    const archivePrefix = `nyx_archived_${archiveCredentialId.slice(0, 8)}`;
    const archiveHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    database.prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, avatar_media_id, status,
        created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'disabled', ?, ?, ?)`,
    ).run(archiveAgentId, prepared.creatorUserId, archiveName, prepared.creatorUserId, now, now);
    database.prepare(
      `INSERT INTO agent_ownership
       (agent_id, owner_type, owner_user_id, organization_id, created_at, updated_at)
       VALUES (?, 'personal', ?, NULL, ?, ?)`,
    ).run(archiveAgentId, prepared.creatorUserId, now, now);
    database.prepare(
      `INSERT INTO workspace_agents
       (id, workspace_id, display_name, avatar_media_id, role, status,
        created_by_user_id, created_at, updated_at, agent_identity_id,
        permission_allow_json, permission_deny_json, root_document_id)
       VALUES (?, ?, ?, NULL, 'viewer', 'disabled', ?, ?, ?, ?, '[]', '[]', NULL)`,
    ).run(
      archiveAgentId,
      input.sourceWorkspaceId,
      archiveName,
      prepared.creatorUserId,
      now,
      now,
      archiveAgentId,
    );
    database.prepare(
      `INSERT INTO agent_credentials
       (id, agent_id, created_by_user_id, name, token_prefix, token_hash,
        scopes_json, default_workspace_id, workspace_allowlist_json,
        ip_allowlist_json, last_used_at, last_used_ip, expires_at, revoked_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '["documents:read","changes:read"]', ?, ?, '[]',
               NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      archiveCredentialId,
      archiveAgentId,
      prepared.creatorUserId,
      archiveName,
      archivePrefix,
      archiveHash,
      input.sourceWorkspaceId,
      JSON.stringify([input.sourceWorkspaceId]),
      now,
      now,
      now,
      now,
    );
    database.prepare(
      `INSERT INTO workspace_api_tokens
       (id, workspace_id, created_by_user_id, name, token_prefix, token_hash,
        scopes_json, last_event_cursor, last_used_at, expires_at, revoked_at,
        root_document_id, agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '["documents:read","changes:read"]', 0,
               NULL, ?, ?, NULL, ?, ?)`,
    ).run(
      archiveCredentialId,
      input.sourceWorkspaceId,
      prepared.creatorUserId,
      archiveName,
      archivePrefix,
      archiveHash,
      now,
      now,
      archiveAgentId,
      now,
    );
    if (prepared.revisionIds.length) {
      const changed = database.prepare(
        `UPDATE document_revisions SET actor_principal_id = ?, actor_token_id = ?
         WHERE id IN (${placeholders(prepared.revisionIds)})`,
      ).run(archiveAgentId, archiveCredentialId, ...prepared.revisionIds);
      if (changed.changes !== prepared.revisionIds.length) throw new Error("Revision archive count mismatch.");
    }
    if (prepared.eventIds.length) {
      const changed = database.prepare(
        `UPDATE document_events SET actor_principal_id = ?, actor_token_id = ?
         WHERE id IN (${placeholders(prepared.eventIds)})`,
      ).run(archiveAgentId, archiveCredentialId, ...prepared.eventIds);
      if (changed.changes !== prepared.eventIds.length) throw new Error("Event archive count mismatch.");
    }
    for (const receipt of prepared.receipts) {
      const changed = database.prepare(
        `UPDATE agent_write_requests SET token_id = ?
         WHERE token_id = ? AND request_id = ?`,
      ).run(archiveCredentialId, receipt.token_id, receipt.request_id);
      if (changed.changes !== 1) throw new Error(`Write receipt ${receipt.request_id} was not archived.`);
      const canonicalChanged = database.prepare(
        `UPDATE agent_credential_write_requests SET credential_id = ?
         WHERE credential_id = ? AND request_id = ?`,
      ).run(archiveCredentialId, receipt.token_id, receipt.request_id);
      if (canonicalChanged.changes !== 1) throw new Error(`Canonical write receipt ${receipt.request_id} was not archived.`);
    }
    if (prepared.mediaIds.length) {
      const changed = database.prepare(
        `UPDATE media_assets SET uploaded_by_token_id = ?
         WHERE id IN (${placeholders(prepared.mediaIds)})`,
      ).run(archiveCredentialId, ...prepared.mediaIds);
      if (changed.changes !== prepared.mediaIds.length) throw new Error("Media archive count mismatch.");
      const canonicalChanged = database.prepare(
        `UPDATE media_assets SET uploaded_by_credential_id = ?
         WHERE id IN (${placeholders(prepared.mediaIds)})`,
      ).run(archiveCredentialId, ...prepared.mediaIds);
      if (canonicalChanged.changes !== prepared.mediaIds.length) throw new Error("Canonical media archive count mismatch.");
    }
    database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?")
      .run(now, input.sourceWorkspaceId);
    recordWorkspaceAuditEvent(database, {
      workspaceId: input.sourceWorkspaceId,
      action: "agent.history_archived",
      actorType: "system",
      actorLabel: "Nyxdoc 워크스페이스 이전",
      targetType: "agent",
      targetId: archiveAgentId,
      metadata: {
        originalAgentId: input.agentId,
        archiveCredentialId,
        counts: prepared.plan.counts,
      },
      createdAt: now,
    });
    assertDatabaseIntegrity(database);
    return { archiveAgentId, archiveCredentialId };
  }).immediate();

  const completed = prepareWorkspaceAgentHistoryArchive(database, input).plan;
  if (completed.status !== "not_needed") {
    throw new Error(`Workspace agent history archive did not reach the expected state: ${JSON.stringify(completed)}`);
  }
  return { plan: initial.plan, ...result };
}

function prepareWorkspaceTreeTransfer(
  database: NyxDatabase,
  input: WorkspaceTreeTransferInput,
): PreparedTransfer {
  const source = workspace(database, input.sourceWorkspaceId) ?? null;
  const target = workspace(database, input.targetWorkspaceId) ?? null;
  const root = database.prepare(
    "SELECT id, workspace_id, title FROM documents WHERE id = ?",
  ).get(input.rootDocumentId) as { id: string; workspace_id: string; title: string } | undefined;
  const blockers: string[] = [];

  if (input.sourceWorkspaceId === input.targetWorkspaceId) {
    blockers.push("원본과 대상 워크스페이스가 같습니다.");
  }
  if (!source) blockers.push("원본 워크스페이스를 찾을 수 없습니다.");
  if (!target) blockers.push("대상 워크스페이스를 찾을 수 없습니다.");
  if (!root) blockers.push("이전할 루트 문서를 찾을 수 없습니다.");

  if (root?.workspace_id === input.targetWorkspaceId) {
    const appliedDocuments = database.prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM documents WHERE id = ? AND workspace_id = ?
         UNION ALL
         SELECT document.id FROM documents document JOIN tree ON document.parent_document_id = tree.id
         WHERE document.workspace_id = ?
       ) SELECT id FROM tree`,
    ).all(input.rootDocumentId, input.targetWorkspaceId, input.targetWorkspaceId) as Array<{ id: string }>;
    const agent = input.agentId
      ? database.prepare("SELECT workspace_id FROM workspace_agents WHERE id = ?").get(input.agentId) as { workspace_id: string } | undefined
      : undefined;
    if (input.agentId && agent?.workspace_id !== input.targetWorkspaceId) {
      blockers.push("문서는 이미 이전됐지만 에이전트는 대상 워크스페이스에 없습니다.");
    }
    if (input.agentId && agent?.workspace_id === input.targetWorkspaceId) {
      const misplacedCredentials = count(
        database,
        "SELECT COUNT(*) AS count FROM workspace_api_tokens WHERE agent_id = ? AND workspace_id <> ?",
        input.agentId,
        input.targetWorkspaceId,
      );
      if (misplacedCredentials) {
        blockers.push(`문서는 이미 이전됐지만 연결 키 ${misplacedCredentials}개가 다른 워크스페이스에 남아 있습니다.`);
      }
    }
    return {
      plan: {
        status: blockers.length ? "blocked" : "already_applied",
        sourceWorkspace: source,
        targetWorkspace: target,
        rootDocument: { id: root.id, title: root.title },
        counts: { ...emptyCounts(), documents: appliedDocuments.length },
        blockers,
      },
      documents: [],
      agent: null,
      credentials: [],
      media: [],
    };
  }

  if (root && root.workspace_id !== input.sourceWorkspaceId) {
    blockers.push("루트 문서가 원본 워크스페이스에 없습니다.");
  }
  if (!root || root.workspace_id !== input.sourceWorkspaceId || !source || !target) {
    return {
      plan: {
        status: "blocked",
        sourceWorkspace: source,
        targetWorkspace: target,
        rootDocument: root ? { id: root.id, title: root.title } : null,
        counts: emptyCounts(),
        blockers,
      },
      documents: [],
      agent: null,
      credentials: [],
      media: [],
    };
  }

  const documents = database.prepare(
    `WITH RECURSIVE tree(id, title, slug, parent_document_id, depth) AS (
       SELECT id, title, slug, parent_document_id, 0
       FROM documents WHERE id = ? AND workspace_id = ?
       UNION ALL
       SELECT document.id, document.title, document.slug, document.parent_document_id, tree.depth + 1
       FROM documents document JOIN tree ON document.parent_document_id = tree.id
       WHERE document.workspace_id = ?
     )
     SELECT id, title, slug, parent_document_id, depth FROM tree ORDER BY depth, id`,
  ).all(input.rootDocumentId, input.sourceWorkspaceId, input.sourceWorkspaceId) as DocumentTransferRow[];
  const documentIds = documents.map((document) => document.id);
  const documentIdSet = new Set(documentIds);
  const ids = placeholders(documentIds);

  if (documents[0]?.parent_document_id) {
    blockers.push("워크스페이스로 이전할 루트 문서는 최상위 문서여야 합니다.");
  }

  const duplicateSlugs = database.prepare(
    `SELECT source.slug
     FROM documents source JOIN documents target ON target.slug = source.slug
     WHERE source.id IN (${ids}) AND target.workspace_id = ?`,
  ).all(...documentIds, input.targetWorkspaceId) as Array<{ slug: string }>;
  if (duplicateSlugs.length) {
    blockers.push(`대상 워크스페이스에 같은 문서 slug가 있습니다: ${duplicateSlugs.map((row) => row.slug).join(", ")}`);
  }

  const references = database.prepare(
    "SELECT source_document_id, target_document_id FROM document_references",
  ).all() as Array<{ source_document_id: string; target_document_id: string }>;
  const crossReferences = references.filter((reference) => (
    documentIdSet.has(reference.source_document_id) !== documentIdSet.has(reference.target_document_id)
  ));
  if (crossReferences.length) {
    blockers.push(`이전 범위를 넘는 내부 문서 링크가 ${crossReferences.length}개 있습니다.`);
  }

  const patchCount = count(database, `SELECT COUNT(*) AS count FROM patches WHERE document_id IN (${ids})`, ...documentIds);
  if (patchCount) blockers.push(`이전할 문서에 처리해야 할 legacy patch가 ${patchCount}개 있습니다.`);
  const nonActiveCount = count(
    database,
    `SELECT COUNT(*) AS count FROM documents WHERE id IN (${ids}) AND lifecycle_state <> 'active'`,
    ...documentIds,
  );
  if (nonActiveCount) blockers.push("휴지통이나 보관 상태의 문서가 이전 트리에 포함되어 있습니다.");

  const agent = input.agentId
    ? database.prepare(
      "SELECT id, workspace_id, display_name, avatar_media_id FROM workspace_agents WHERE id = ?",
    ).get(input.agentId) as AgentTransferRow | undefined
    : undefined;
  if (input.agentId && !agent) blockers.push("이전할 에이전트를 찾을 수 없습니다.");
  if (agent && agent.workspace_id !== input.sourceWorkspaceId) {
    blockers.push("이전할 에이전트가 원본 워크스페이스에 없습니다.");
  }
  const credentials = agent
    ? database.prepare(
      "SELECT id, root_document_id FROM workspace_api_tokens WHERE agent_id = ? AND workspace_id = ?",
    ).all(agent.id, input.sourceWorkspaceId) as CredentialTransferRow[]
    : [];
  for (const credential of credentials) {
    if (credential.root_document_id && !documentIdSet.has(credential.root_document_id)) {
      blockers.push(`연결 키 ${credential.id}의 문서 범위가 이전 트리 밖을 가리킵니다.`);
    }
  }
  const credentialIds = credentials.map((credential) => credential.id);
  const credentialIdSet = new Set(credentialIds);

  if (agent) {
    const tokenActorClause = credentialIds.length
      ? ` OR revision.actor_token_id IN (${placeholders(credentialIds)})`
      : "";
    const outsideRevisionActors = count(
      database,
      `SELECT COUNT(*) AS count
       FROM document_revisions revision
       JOIN documents document ON document.id = revision.document_id
       WHERE document.workspace_id = ? AND document.id NOT IN (${ids})
         AND (revision.actor_principal_id = ?${tokenActorClause})`,
      input.sourceWorkspaceId,
      ...documentIds,
      agent.id,
      ...credentialIds,
    );
    if (outsideRevisionActors) {
      blockers.push(`에이전트가 이전 범위 밖에 남긴 문서 리비전이 ${outsideRevisionActors}개 있습니다.`);
    }
    const eventTokenActorClause = credentialIds.length
      ? ` OR event.actor_token_id IN (${placeholders(credentialIds)})`
      : "";
    const outsideEventActors = count(
      database,
      `SELECT COUNT(*) AS count
       FROM document_events event
       JOIN documents document ON document.id = event.document_id
       WHERE document.workspace_id = ? AND document.id NOT IN (${ids})
         AND (event.actor_principal_id = ?${eventTokenActorClause})`,
      input.sourceWorkspaceId,
      ...documentIds,
      agent.id,
      ...credentialIds,
    );
    if (outsideEventActors) {
      blockers.push(`에이전트가 이전 범위 밖에 남긴 변경 이벤트가 ${outsideEventActors}개 있습니다.`);
    }
    if (credentialIds.length) {
      const outsideWriteReceipts = count(
        database,
        `SELECT COUNT(*) AS count FROM agent_write_requests
         WHERE token_id IN (${placeholders(credentialIds)})
           AND (document_id IS NULL OR document_id NOT IN (${ids}))`,
        ...credentialIds,
        ...documentIds,
      );
      if (outsideWriteReceipts) {
        blockers.push(`연결 키의 재시도 기록 ${outsideWriteReceipts}개가 이전 범위 밖을 가리킵니다.`);
      }
    }
    const assignmentRows = database.prepare(
      `SELECT agent_id, document_id FROM agent_document_assignments
       WHERE agent_id = ? OR document_id IN (${ids})`,
    ).all(agent.id, ...documentIds) as Array<{ agent_id: string; document_id: string }>;
    const incompatible = assignmentRows.filter((assignment) => (
      assignment.agent_id !== agent.id || !documentIdSet.has(assignment.document_id)
    ));
    if (incompatible.length) blockers.push(`이전 범위를 넘는 에이전트 할당이 ${incompatible.length}개 있습니다.`);
    const savedViews = count(
      database,
      "SELECT COUNT(*) AS count FROM workspace_saved_views WHERE created_by_agent_id = ?",
      agent.id,
    );
    if (savedViews) blockers.push(`에이전트가 만든 저장 필터 ${savedViews}개는 별도 검토가 필요합니다.`);
    const adminRequests = count(
      database,
      "SELECT COUNT(*) AS count FROM workspace_admin_action_requests WHERE requested_by_agent_id = ?",
      agent.id,
    );
    if (adminRequests) blockers.push(`에이전트의 관리 요청 ${adminRequests}개는 별도 검토가 필요합니다.`);
  } else {
    const assignments = count(
      database,
      `SELECT COUNT(*) AS count FROM agent_document_assignments WHERE document_id IN (${ids})`,
      ...documentIds,
    );
    if (assignments) blockers.push(`이전할 문서의 에이전트 할당이 ${assignments}개 있습니다.`);
  }

  const movedMediaIds = documentMediaIds(database, documentIds);
  if (agent?.avatar_media_id) movedMediaIds.add(agent.avatar_media_id);
  const outsideDocuments = database.prepare(
    `SELECT id FROM documents WHERE workspace_id = ? AND id NOT IN (${ids})`,
  ).all(input.sourceWorkspaceId, ...documentIds) as Array<{ id: string }>;
  const outsideMediaIds = documentMediaIds(database, outsideDocuments.map((document) => document.id));
  const sharedMedia = [...movedMediaIds].filter((mediaId) => outsideMediaIds.has(mediaId));
  if (sharedMedia.length) blockers.push(`원본 워크스페이스의 다른 문서와 공유하는 이미지가 ${sharedMedia.length}개 있습니다.`);

  const mediaIds = [...movedMediaIds];
  const media = mediaIds.length
    ? database.prepare(
      `SELECT id, workspace_id, sha256, uploaded_by_token_id
       FROM media_assets WHERE id IN (${placeholders(mediaIds)})`,
    ).all(...mediaIds) as MediaTransferRow[]
    : [];
  if (media.length !== mediaIds.length) blockers.push("문서 또는 에이전트가 참조하는 이미지 파일 일부가 없습니다.");
  if (credentialIds.length) {
    const credentialMedia = database.prepare(
      `SELECT id FROM media_assets
       WHERE workspace_id = ? AND uploaded_by_token_id IN (${placeholders(credentialIds)})`,
    ).all(input.sourceWorkspaceId, ...credentialIds) as Array<{ id: string }>;
    const outsideCredentialMedia = credentialMedia.filter((item) => !movedMediaIds.has(item.id));
    if (outsideCredentialMedia.length) {
      blockers.push(`연결 키로 올렸지만 이전 문서가 사용하지 않는 이미지가 ${outsideCredentialMedia.length}개 있습니다.`);
    }
  }
  if (mediaIds.length) {
    const outsideAvatarSnapshots = count(
      database,
      `SELECT COUNT(*) AS count FROM (
         SELECT revision.id
         FROM document_revisions revision
         JOIN documents document ON document.id = revision.document_id
         WHERE document.workspace_id = ? AND document.id NOT IN (${ids})
           AND revision.actor_avatar_media_id IN (${placeholders(mediaIds)})
         UNION ALL
         SELECT event.id
         FROM document_events event
         JOIN documents document ON document.id = event.document_id
         WHERE document.workspace_id = ? AND document.id NOT IN (${ids})
           AND event.actor_avatar_media_id IN (${placeholders(mediaIds)})
       )`,
      input.sourceWorkspaceId,
      ...documentIds,
      ...mediaIds,
      input.sourceWorkspaceId,
      ...documentIds,
      ...mediaIds,
    );
    if (outsideAvatarSnapshots) {
      blockers.push(`이전 이미지가 원본 워크스페이스의 과거 변경 기록 ${outsideAvatarSnapshots}개에도 사용됩니다.`);
    }
  }
  for (const item of media) {
    if (item.workspace_id !== input.sourceWorkspaceId) {
      blockers.push(`이미지 ${item.id}가 원본 워크스페이스에 없습니다.`);
    }
    if (item.uploaded_by_token_id && !credentialIdSet.has(item.uploaded_by_token_id)) {
      blockers.push(`이미지 ${item.id}의 업로드 연결 키가 이전 대상에 포함되지 않습니다.`);
    }
    const duplicate = database.prepare(
      "SELECT id FROM media_assets WHERE workspace_id = ? AND sha256 = ? AND id <> ?",
    ).get(input.targetWorkspaceId, item.sha256, item.id) as { id: string } | undefined;
    if (duplicate) {
      blockers.push(`대상 워크스페이스에 이미지 ${item.id}와 같은 파일이 이미 있습니다.`);
    }
  }

  const internalReferences = references.filter((reference) => (
    documentIdSet.has(reference.source_document_id) && documentIdSet.has(reference.target_document_id)
  )).length;
  const writeReceipts = credentialIds.length
    ? count(
      database,
      `SELECT COUNT(*) AS count FROM agent_write_requests WHERE token_id IN (${placeholders(credentialIds)})`,
      ...credentialIds,
    )
    : 0;
  const plan: WorkspaceTreeTransferPlan = {
    status: blockers.length ? "blocked" : "ready",
    sourceWorkspace: source,
    targetWorkspace: target,
    rootDocument: { id: root.id, title: root.title },
    counts: {
      documents: documents.length,
      blocks: count(database, `SELECT COUNT(*) AS count FROM document_blocks WHERE document_id IN (${ids})`, ...documentIds),
      revisions: count(database, `SELECT COUNT(*) AS count FROM document_revisions WHERE document_id IN (${ids})`, ...documentIds),
      events: count(database, `SELECT COUNT(*) AS count FROM document_events WHERE document_id IN (${ids})`, ...documentIds),
      internalReferences,
      media: media.length,
      credentials: credentials.length,
      writeReceipts,
    },
    blockers,
  };
  return { plan, documents, agent: agent ?? null, credentials, media };
}

export function planWorkspaceTreeTransfer(
  database: NyxDatabase,
  input: WorkspaceTreeTransferInput,
): WorkspaceTreeTransferPlan {
  return prepareWorkspaceTreeTransfer(database, input).plan;
}

export function applyWorkspaceTreeTransfer(
  database: NyxDatabase,
  input: WorkspaceTreeTransferInput,
): WorkspaceTreeTransferPlan {
  const initial = prepareWorkspaceTreeTransfer(database, input);
  if (initial.plan.status === "already_applied") return initial.plan;
  if (initial.plan.status !== "ready") {
    throw new Error(`Workspace tree transfer is blocked: ${initial.plan.blockers.join(" ")}`);
  }

  database.transaction(() => {
    const prepared = prepareWorkspaceTreeTransfer(database, input);
    if (prepared.plan.status !== "ready") {
      throw new Error(`Workspace tree transfer changed during execution: ${prepared.plan.blockers.join(" ")}`);
    }
    const now = new Date().toISOString();
    const documentIds = prepared.documents.map((document) => document.id);
    const mediaIds = prepared.media.map((media) => media.id);
    const credentialIds = prepared.credentials.map((credential) => credential.id);

    if (prepared.agent?.avatar_media_id && mediaIds.includes(prepared.agent.avatar_media_id)) {
      database.prepare("UPDATE workspace_agents SET avatar_media_id = NULL WHERE id = ?")
        .run(prepared.agent.id);
    }
    for (const media of prepared.media) {
      if (media.uploaded_by_token_id) {
        database.prepare("UPDATE media_assets SET uploaded_by_token_id = NULL WHERE id = ?")
          .run(media.id);
      }
      database.prepare("UPDATE media_assets SET workspace_id = ? WHERE id = ? AND workspace_id = ?")
        .run(input.targetWorkspaceId, media.id, input.sourceWorkspaceId);
    }

    database.prepare("UPDATE documents SET parent_document_id = NULL WHERE id = ? AND workspace_id = ?")
      .run(input.rootDocumentId, input.sourceWorkspaceId);
    for (const document of prepared.documents) {
      const changed = database.prepare(
        "UPDATE documents SET workspace_id = ? WHERE id = ? AND workspace_id = ?",
      ).run(input.targetWorkspaceId, document.id, input.sourceWorkspaceId);
      if (changed.changes !== 1) throw new Error(`Document ${document.id} was not transferred.`);
    }
    database.prepare(
      `UPDATE document_events SET workspace_id = ?
       WHERE document_id IN (${placeholders(documentIds)}) AND workspace_id = ?`,
    ).run(input.targetWorkspaceId, ...documentIds, input.sourceWorkspaceId);
    database.prepare(
      `UPDATE document_collaboration_states SET workspace_id = ?
       WHERE document_id IN (${placeholders(documentIds)}) AND workspace_id = ?`,
    ).run(input.targetWorkspaceId, ...documentIds, input.sourceWorkspaceId);
    database.prepare(
      `UPDATE collaboration_idempotency_requests SET workspace_id = ?
       WHERE document_id IN (${placeholders(documentIds)}) AND workspace_id = ?`,
    ).run(input.targetWorkspaceId, ...documentIds, input.sourceWorkspaceId);
    database.prepare(
      `UPDATE document_public_shares SET workspace_id = ?
       WHERE document_id IN (${placeholders(documentIds)}) AND workspace_id = ?`,
    ).run(input.targetWorkspaceId, ...documentIds, input.sourceWorkspaceId);
    database.prepare(
      `UPDATE document_human_grants SET workspace_id = ?
       WHERE document_id IN (${placeholders(documentIds)}) AND workspace_id = ?`,
    ).run(input.targetWorkspaceId, ...documentIds, input.sourceWorkspaceId);
    database.prepare(
      `UPDATE document_media_bindings SET workspace_id = ?
       WHERE document_id IN (${placeholders(documentIds)}) AND workspace_id = ?`,
    ).run(input.targetWorkspaceId, ...documentIds, input.sourceWorkspaceId);

    if (prepared.agent) {
      const changed = database.prepare(
        "UPDATE workspace_agents SET workspace_id = ? WHERE id = ? AND workspace_id = ?",
      ).run(input.targetWorkspaceId, prepared.agent.id, input.sourceWorkspaceId);
      if (changed.changes !== 1) throw new Error(`Agent ${prepared.agent.id} was not transferred.`);
    }
    for (const credential of prepared.credentials) {
      const changed = database.prepare(
        "UPDATE workspace_api_tokens SET workspace_id = ? WHERE id = ? AND workspace_id = ?",
      ).run(input.targetWorkspaceId, credential.id, input.sourceWorkspaceId);
      if (changed.changes !== 1) throw new Error(`Credential ${credential.id} was not transferred.`);
      const canonical = database.prepare(
        `SELECT default_workspace_id, workspace_allowlist_json
         FROM agent_credentials WHERE id = ?`,
      ).get(credential.id) as { default_workspace_id: string | null; workspace_allowlist_json: string } | undefined;
      if (!canonical) throw new Error(`Global credential ${credential.id} was not found.`);
      let workspaceAllowlist: string[] = [];
      try {
        const parsed = JSON.parse(canonical.workspace_allowlist_json) as unknown;
        if (Array.isArray(parsed)) workspaceAllowlist = parsed.filter((value): value is string => typeof value === "string");
      } catch {
        workspaceAllowlist = [];
      }
      workspaceAllowlist = Array.from(new Set(workspaceAllowlist.map((workspaceId) => (
        workspaceId === input.sourceWorkspaceId ? input.targetWorkspaceId : workspaceId
      ))));
      database.prepare(
        `UPDATE agent_credentials
         SET default_workspace_id = CASE WHEN default_workspace_id = ? THEN ? ELSE default_workspace_id END,
             workspace_allowlist_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.sourceWorkspaceId, input.targetWorkspaceId, JSON.stringify(workspaceAllowlist), now, credential.id);
      const state = database.prepare(
        `SELECT last_event_cursor, last_used_at, last_used_ip
         FROM agent_credential_workspace_state
         WHERE credential_id = ? AND workspace_id = ?`,
      ).get(credential.id, input.sourceWorkspaceId) as {
        last_event_cursor: number;
        last_used_at: string | null;
        last_used_ip: string | null;
      } | undefined;
      if (state) {
        database.prepare(
          `INSERT INTO agent_credential_workspace_state
           (credential_id, workspace_id, last_event_cursor, last_used_at, last_used_ip)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(credential_id, workspace_id) DO UPDATE SET
             last_event_cursor = MAX(last_event_cursor, excluded.last_event_cursor),
             last_used_at = COALESCE(excluded.last_used_at, last_used_at),
             last_used_ip = COALESCE(excluded.last_used_ip, last_used_ip)`,
        ).run(credential.id, input.targetWorkspaceId, state.last_event_cursor, state.last_used_at, state.last_used_ip);
        database.prepare(
          `DELETE FROM agent_credential_workspace_state
           WHERE credential_id = ? AND workspace_id = ?`,
        ).run(credential.id, input.sourceWorkspaceId);
      }
    }

    if (prepared.agent) {
      database.prepare(
        `UPDATE agent_document_assignments SET workspace_id = ?
         WHERE agent_id = ? AND document_id IN (${placeholders(documentIds)})`,
      ).run(input.targetWorkspaceId, prepared.agent.id, ...documentIds);
    }
    for (const media of prepared.media) {
      if (media.uploaded_by_token_id) {
        database.prepare("UPDATE media_assets SET uploaded_by_token_id = ? WHERE id = ?")
          .run(media.uploaded_by_token_id, media.id);
      }
    }
    if (prepared.agent?.avatar_media_id) {
      database.prepare("UPDATE workspace_agents SET avatar_media_id = ? WHERE id = ?")
        .run(prepared.agent.avatar_media_id, prepared.agent.id);
    }
    database.prepare("UPDATE workspaces SET updated_at = ? WHERE id IN (?, ?)")
      .run(now, input.sourceWorkspaceId, input.targetWorkspaceId);
    assertDatabaseIntegrity(database);

    if (credentialIds.length) {
      const movedCredentials = count(
        database,
        `SELECT COUNT(*) AS count FROM workspace_api_tokens
         WHERE workspace_id = ? AND id IN (${placeholders(credentialIds)})`,
        input.targetWorkspaceId,
        ...credentialIds,
      );
      if (movedCredentials !== credentialIds.length) throw new Error("Credential transfer count mismatch.");
    }
  }).immediate();

  const completed = prepareWorkspaceTreeTransfer(database, input).plan;
  if (completed.status !== "already_applied") {
    throw new Error(`Workspace tree transfer did not reach the expected state: ${JSON.stringify(completed)}`);
  }
  return { ...initial.plan, status: "already_applied" };
}
