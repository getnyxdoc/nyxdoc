import { randomUUID } from "node:crypto";
import {
  getHumanDocumentPrincipal,
  getHumanWorkspacePrincipal,
  humanDocumentPrincipalAllows,
  humanRoleAllows,
  recordWorkspaceAuditEvent,
} from "@/lib/authz/permissions";
import { cancelAssignmentsOutsideWorkspaceAgentBoundaries } from "@/lib/agents/workspace-grant-boundary";
import type { NyxDatabase } from "@/lib/db/client";
import {
  type BlockType,
  type TableBlockData,
} from "@/lib/db/types";
import {
  DocumentServiceError,
  type DocumentActor,
  type DocumentBacklink,
  type DocumentDetail,
  type DocumentEvent,
  type DocumentListEntry,
  type DocumentMetadata,
  type DocumentMutationResult,
  type DocumentPatchOperation,
  type DocumentRevision,
  type DocumentRevisionDiff,
  type DocumentRevisionSnapshot,
  type DocumentSearchResult,
  type DocumentSummary,
  type DocumentWorkflowStatus,
  type PatchDocumentInput,
  type TrashBatchSummary,
  type TrashMutationResult,
} from "@/lib/documents/types";
import {
  prepareAgentWrite,
  recordAgentWrite,
  replayAgentWrite,
} from "@/lib/documents/idempotency";
import {
  blockIdNormalization,
  normalizeTopLevelBlockIds,
} from "@/lib/documents/block-ids";
import {
  v2ToStorageBlockInputs,
  type StoredDocumentBlockInput,
} from "@/lib/editor/storage-projection";
import {
  parseNyxdocDocumentV2,
  type NyxdocBlock,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";
import { syncDocumentMediaBindings } from "@/lib/media/bindings";
import {
  ApiTokenError,
  authenticateAgentCredential,
  requireTokenDocumentAccess,
  requireTokenParentAccess,
  requireTokenPermission,
} from "@/lib/tokens/service";

type DocumentRow = {
  id: string;
  workspace_id: string;
  title: string;
  slug: string;
  status: "active" | "archived";
  parent_document_id: string | null;
  tree_order: number;
  current_revision_id: string | null;
  content_schema_version: number;
  document_type: string | null;
  workflow_status: DocumentWorkflowStatus;
  tags_json: string;
  revision_number: number;
  created_at: string;
  updated_at: string;
};

type BlockRow = {
  id: string;
  block_type: BlockType;
  content: string;
  content_json: string | null;
  indent_level: number;
  metadata_json: string;
  sort_order: number;
  version: number;
  deleted_at?: string | null;
};

export type CreateDocumentInput = {
  /** Internal protocol surface name used for idempotency bookkeeping. */
  idempotencyOperation?: string;
  requestId?: string;
  title: string;
  parentDocumentId?: string | null;
  documentType?: string | null;
  workflowStatus?: DocumentWorkflowStatus;
  tags?: string[];
  content: NyxdocDocumentV2;
  summary?: string;
};

export type UpdateDocumentInput = {
  /** Internal protocol surface name used for idempotency bookkeeping. */
  idempotencyOperation?: string;
  requestId?: string;
  baseRevision: number;
  title?: string;
  parentDocumentId?: string | null;
  documentType?: string | null;
  workflowStatus?: DocumentWorkflowStatus;
  tags?: string[];
  content?: NyxdocDocumentV2;
  summary?: string;
};

type DocumentMoveAuthorizationActor = {
  type: DocumentActor["type"];
  userId?: string | null;
  tokenId?: string | null;
  principalId?: string | null;
};

export function requireDocumentMoveAuthorization(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  parentDocumentId: string | null,
  actor: DocumentMoveAuthorizationActor,
  options: { requireCommitPermission?: boolean } = {},
) {
  if (parentDocumentId) {
    // This also enforces the destination workspace and active lifecycle.
    getDocument(database, workspaceId, parentDocumentId);
  }
  if (actor.type === "system") return;

  if (actor.type === "human") {
    if (!actor.userId) {
      throw new DocumentServiceError("FORBIDDEN", "문서 이동 작업의 사용자 신원을 확인할 수 없습니다.");
    }
    const sourcePrincipal = getHumanDocumentPrincipal(
      database,
      workspaceId,
      documentId,
      actor.userId,
    );
    if (
      !sourcePrincipal
      || sourcePrincipal.source === "document_grant"
      || !humanDocumentPrincipalAllows(sourcePrincipal, "documents.update")
      || (
        options.requireCommitPermission
        && !humanDocumentPrincipalAllows(sourcePrincipal, "documents.commit")
      )
    ) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        "직접 공유받은 문서는 이동할 수 없으며, 문서 이동에는 워크스페이스 편집 권한이 필요합니다.",
      );
    }
    if (parentDocumentId) {
      const destinationPrincipal = getHumanDocumentPrincipal(
        database,
        workspaceId,
        parentDocumentId,
        actor.userId,
      );
      if (
        !destinationPrincipal
        || destinationPrincipal.source !== "workspace"
        || !humanDocumentPrincipalAllows(destinationPrincipal, "documents.update")
      ) {
        throw new DocumentServiceError("FORBIDDEN", "대상 문서 아래로 이동할 권한이 없습니다.");
      }
    } else {
      const workspacePrincipal = getHumanWorkspacePrincipal(
        database,
        workspaceId,
        actor.userId,
      );
      if (
        !workspacePrincipal
        || !humanRoleAllows(workspacePrincipal.role, "documents.update")
      ) {
        throw new DocumentServiceError("FORBIDDEN", "문서를 워크스페이스 최상위로 이동할 권한이 없습니다.");
      }
    }
    return;
  }

  if (!actor.tokenId) {
    throw new DocumentServiceError("FORBIDDEN", "문서 이동 작업의 에이전트 연결을 확인할 수 없습니다.");
  }
  try {
    const identity = authenticateAgentCredential(database, actor.tokenId, {
      workspaceId,
    });
    if (actor.principalId && identity.globalAgentId !== actor.principalId) {
      throw new DocumentServiceError("FORBIDDEN", "에이전트 연결과 작업자 신원이 일치하지 않습니다.");
    }
    requireTokenPermission(identity, "documents:write", "documents.update");
    if (options.requireCommitPermission) {
      requireTokenPermission(identity, "documents:commit", "documents.commit");
    }
    requireTokenDocumentAccess(database, identity, documentId);
    requireTokenParentAccess(database, identity, parentDocumentId);
  } catch (error) {
    if (error instanceof DocumentServiceError) throw error;
    if (error instanceof ApiTokenError) {
      throw new DocumentServiceError(
        error.code === "NOT_FOUND" ? "NOT_FOUND" : "FORBIDDEN",
        error.message,
      );
    }
    throw error;
  }
}

const AST_ELEMENT_TYPES = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "callout",
  "hr",
  "img",
  "code_block",
  "code_line",
  "table",
  "tr",
  "td",
  "th",
]);

const TOP_LEVEL_NODE_TYPES = new Set<NyxdocBlock["type"]>([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "callout",
  "hr",
  "img",
  "code_block",
  "table",
]);

function canonicalStoredNodeType(contentJson: string | null): NyxdocBlock["type"] {
  try {
    const nodeType = (JSON.parse(contentJson ?? "null") as { type?: unknown } | null)?.type;
    if (typeof nodeType === "string" && TOP_LEVEL_NODE_TYPES.has(nodeType as NyxdocBlock["type"])) {
      return nodeType as NyxdocBlock["type"];
    }
  } catch {
    // Report the invariant violation below.
  }
  throw new DocumentServiceError("INVALID_INPUT", "검색 인덱스에 유효한 AST v2 노드가 없습니다.");
}

function assignMissingElementIds(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assignMissingElementIds);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.type === "string"
    && AST_ELEMENT_TYPES.has(record.type)
    && (typeof record.id !== "string" || !record.id)
  ) {
    record.id = randomUUID();
  }
  if (Array.isArray(record.children)) record.children.forEach(assignMissingElementIds);
}

function preparePatchBlock(value: Record<string, unknown>, forcedId?: string): NyxdocBlock {
  const block = structuredClone(value);
  if (forcedId && typeof block.id === "string" && block.id !== forcedId) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "교체 블록의 id는 대상 blockId와 같거나 생략되어야 합니다.",
    );
  }
  if (forcedId) block.id = forcedId;
  assignMissingElementIds(block);
  try {
    return parseNyxdocDocumentV2({ schemaVersion: 2, blocks: [block] }).blocks[0];
  } catch {
    throw new DocumentServiceError("INVALID_INPUT", "patch에 유효한 AST v2 블록이 필요합니다.");
  }
}

function requestedPatchBlockIds(operations: DocumentPatchOperation[]) {
  return Array.from(new Set(operations.flatMap((operation) => {
    if (operation.op === "replace_block" || operation.op === "delete_block") return [operation.blockId];
    if (!("blockId" in operation)) return [operation.anchorBlockId];
    return [operation.blockId, operation.anchorBlockId];
  })));
}

export type ArchiveDocumentInput = {
  baseRevision: number;
  createdByAgentId?: string;
};

export type ArchiveDocumentResult = {
  archivedDocumentIds: string[];
  archivedCount: number;
  nextDocumentId: string;
  eventCursor: number;
};

function cleanTitle(value: string) {
  const title = value.trim().replace(/\s+/g, " ");
  if (!title || title.length > 200) {
    throw new DocumentServiceError("INVALID_INPUT", "문서 제목은 1자 이상 200자 이하여야 합니다.");
  }
  return title;
}

function cleanSummary(value: string | undefined, fallback: string) {
  const summary = (value || fallback).trim().replace(/\s+/g, " ");
  if (!summary || summary.length > 300) {
    throw new DocumentServiceError("INVALID_INPUT", "변경 요약은 1자 이상 300자 이하여야 합니다.");
  }
  return summary;
}

function cleanDocumentType(value: string | null | undefined) {
  if (value === undefined || value === null) return value;
  const documentType = value.trim().replace(/\s+/g, " ");
  if (!documentType || documentType.length > 80) {
    throw new DocumentServiceError("INVALID_INPUT", "문서 유형은 1자 이상 80자 이하여야 합니다.");
  }
  return documentType;
}

function cleanTags(value: string[] | undefined) {
  if (value === undefined) return undefined;
  if (value.length > 30) {
    throw new DocumentServiceError("INVALID_INPUT", "문서 태그는 최대 30개까지 지정할 수 있습니다.");
  }
  const tags = Array.from(new Set(value.map((tag) => tag.trim().replace(/\s+/g, " ")).filter(Boolean)));
  if (tags.some((tag) => tag.length > 50)) {
    throw new DocumentServiceError("INVALID_INPUT", "각 문서 태그는 50자 이하여야 합니다.");
  }
  return tags;
}

function cleanWorkflowStatus(value: DocumentWorkflowStatus | undefined) {
  if (value === undefined) return undefined;
  if (value !== "draft" && value !== "review" && value !== "final") {
    throw new DocumentServiceError("INVALID_INPUT", "지원하지 않는 문서 상태입니다.");
  }
  return value;
}

function parseDocumentTags(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function documentMetadata(row: DocumentRow): DocumentMetadata {
  return {
    documentType: row.document_type,
    workflowStatus: row.workflow_status,
    tags: parseDocumentTags(row.tags_json),
  };
}

type BlockMetadata = {
  checked?: boolean;
  table?: TableBlockData;
};

function metadataJson(block: { type: BlockType; checked?: boolean; table?: TableBlockData }) {
  const metadata: BlockMetadata = {};
  if (block.type === "todo") metadata.checked = block.checked === true;
  if (block.type === "table" && block.table) metadata.table = block.table;
  return JSON.stringify(metadata);
}

type PreparedBlockInput = {
  id?: string;
  type: BlockType;
  content: string;
  indent: number;
  checked?: boolean;
  table?: TableBlockData;
  contentJson?: string;
};

function prepareV2Content(value: unknown) {
  const content = parseNyxdocDocumentV2(value);
  return {
    content,
    blocks: v2ToStorageBlockInputs(content) satisfies StoredDocumentBlockInput[],
  };
}

function assertContentMediaOwnership(
  database: NyxDatabase,
  workspaceId: string,
  content: NyxdocDocumentV2,
) {
  for (const block of content.blocks) {
    if (block.type !== "img") continue;
    const owned = database
      .prepare("SELECT 1 FROM media_assets WHERE id = ? AND workspace_id = ?")
      .get(block.mediaId, workspaceId);
    if (!owned) {
      throw new DocumentServiceError(
        "INVALID_INPUT",
        "문서 이미지가 이 워크스페이스의 미디어 저장소에 없습니다.",
      );
    }
  }
}

function contentDocumentReferences(content: NyxdocDocumentV2) {
  const references: Array<{ blockId: string; documentId: string }> = [];
  for (const block of content.blocks) {
    function visit(value: unknown) {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.type === "doc_ref" && typeof record.documentId === "string") {
        references.push({ blockId: block.id, documentId: record.documentId });
      }
      if (Array.isArray(record.children)) record.children.forEach(visit);
    }
    visit(block);
  }
  return references;
}

function documentIsWithinRoot(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  rootDocumentId: string,
) {
  return Boolean(database.prepare(
    `WITH RECURSIVE ancestors(id, parent_document_id) AS (
       SELECT id, parent_document_id
       FROM documents
       WHERE workspace_id = ? AND id = ? AND status = 'active'
       UNION ALL
       SELECT d.id, d.parent_document_id
       FROM documents d
       JOIN ancestors a ON d.id = a.parent_document_id
       WHERE d.workspace_id = ? AND d.status = 'active'
     )
     SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
  ).get(workspaceId, documentId, workspaceId, rootDocumentId));
}

function actorDocumentRoot(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
) {
  if (!actor.tokenId) return null;
  const row = database.prepare(
    `SELECT membership.root_document_id
     FROM agent_credentials credential
     JOIN workspace_agents membership
       ON membership.agent_identity_id = credential.agent_id
       AND membership.workspace_id = ?
     JOIN agent_credential_grant_bindings binding
       ON binding.credential_id = credential.id
      AND binding.grant_id = membership.id
      AND binding.status = 'active'
      AND binding.revoked_at IS NULL
     WHERE credential.id = ? AND credential.revoked_at IS NULL
       AND membership.status = 'active' AND membership.revoked_at IS NULL`,
  ).get(workspaceId, actor.tokenId) as { root_document_id: string | null } | undefined;
  if (!row) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      "이 연결 키는 현재 워크스페이스의 에이전트 접근 권한에 연결되어 있지 않습니다.",
    );
  }
  return row.root_document_id;
}

function assertContentDocumentReferences(
  database: NyxDatabase,
  workspaceId: string,
  content: NyxdocDocumentV2,
  rootDocumentId: string | null = null,
) {
  const targetIds = Array.from(new Set(contentDocumentReferences(content).map((reference) => reference.documentId)));
  for (const targetId of targetIds) {
    const target = database
      .prepare("SELECT 1 FROM documents WHERE id = ? AND workspace_id = ? AND status = 'active'")
      .get(targetId, workspaceId);
    if (!target) {
      throw new DocumentServiceError(
        "INVALID_INPUT",
        "내부 문서 링크의 대상이 이 워크스페이스에 없거나 보관되었습니다.",
        { targetDocumentId: targetId },
      );
    }
    if (rootDocumentId && !documentIsWithinRoot(database, workspaceId, targetId, rootDocumentId)) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        "내부 문서 링크가 이 연결의 허용 범위를 벗어났습니다.",
        { targetDocumentId: targetId },
      );
    }
  }
}

function syncDocumentReferences(
  database: NyxDatabase,
  sourceDocumentId: string,
  content: NyxdocDocumentV2 | null,
) {
  database.prepare("DELETE FROM document_references WHERE source_document_id = ?").run(sourceDocumentId);
  if (!content) return;
  const createdAt = new Date().toISOString();
  const insert = database.prepare(
    `INSERT OR IGNORE INTO document_references
     (source_document_id, target_document_id, source_block_id, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const reference of contentDocumentReferences(content)) {
    insert.run(sourceDocumentId, reference.documentId, reference.blockId, createdAt);
  }
}

function mapSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    parentDocumentId: row.parent_document_id,
    treeOrder: Number(row.tree_order),
    revisionId: row.current_revision_id,
    revisionNumber: Number(row.revision_number),
    ...documentMetadata(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadDocumentRow(database: NyxDatabase, workspaceId: string, documentId: string) {
  return database
    .prepare(
      `SELECT d.id, d.workspace_id, d.title, d.slug, d.status,
              d.parent_document_id, d.tree_order, d.current_revision_id,
              d.content_schema_version, d.document_type, d.workflow_status, d.tags_json,
              COALESCE(r.revision_number, 0) AS revision_number, d.created_at, d.updated_at
       FROM documents d
       LEFT JOIN document_revisions r ON r.id = d.current_revision_id
       WHERE d.workspace_id = ? AND d.id = ?`,
    )
    .get(workspaceId, documentId) as DocumentRow | undefined;
}

function loadBlockRows(database: NyxDatabase, documentId: string) {
  return database
    .prepare(
      `SELECT id, block_type, content, content_json, indent_level, metadata_json, sort_order, version
       FROM document_blocks
       WHERE document_id = ? AND deleted_at IS NULL
       ORDER BY sort_order ASC, created_at ASC`,
    )
    .all(documentId) as BlockRow[];
}

function contentFromRows(row: DocumentRow, rows: BlockRow[]): NyxdocDocumentV2 {
  if (row.content_schema_version !== 2 || rows.some((block) => !block.content_json)) {
    throw new DocumentServiceError("INVALID_INPUT", "정본 AST v2 본문이 없는 문서입니다.");
  }
  try {
    return parseNyxdocDocumentV2({
      schemaVersion: 2,
      blocks: rows.map((block) => JSON.parse(block.content_json!)),
    });
  } catch {
    throw new DocumentServiceError("INVALID_INPUT", "AST v2 문서 본문을 읽을 수 없습니다.");
  }
}

function longestCommonBlockIds(left: string[], right: string[]) {
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      lengths[leftIndex][rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? lengths[leftIndex - 1][rightIndex - 1] + 1
        : Math.max(lengths[leftIndex - 1][rightIndex], lengths[leftIndex][rightIndex - 1]);
    }
  }

  const ids = new Set<string>();
  let leftIndex = left.length;
  let rightIndex = right.length;
  while (leftIndex > 0 && rightIndex > 0) {
    if (left[leftIndex - 1] === right[rightIndex - 1]) {
      ids.add(left[leftIndex - 1]);
      leftIndex -= 1;
      rightIndex -= 1;
    } else if (lengths[leftIndex - 1][rightIndex] >= lengths[leftIndex][rightIndex - 1]) {
      leftIndex -= 1;
    } else {
      rightIndex -= 1;
    }
  }
  return ids;
}

function topLevelBlockChanges(before: NyxdocDocumentV2, after: NyxdocDocumentV2) {
  const beforeById = new Map(before.blocks.map((block) => [block.id, block]));
  const afterById = new Map(after.blocks.map((block) => [block.id, block]));
  const addedBlockIds = after.blocks.filter((block) => !beforeById.has(block.id)).map((block) => block.id);
  const removedBlockIds = before.blocks.filter((block) => !afterById.has(block.id)).map((block) => block.id);
  const modifiedBlockIds = after.blocks
    .filter((block) => {
      const previous = beforeById.get(block.id);
      return previous !== undefined && JSON.stringify(previous) !== JSON.stringify(block);
    })
    .map((block) => block.id);
  const commonBefore = before.blocks.map((block) => block.id).filter((id) => afterById.has(id));
  const commonAfter = after.blocks.map((block) => block.id).filter((id) => beforeById.has(id));
  const stableOrder = longestCommonBlockIds(commonBefore, commonAfter);
  const movedBlockIds = commonAfter.filter((id) => !stableOrder.has(id));
  const changedBlockIds = Array.from(new Set([
    ...addedBlockIds,
    ...removedBlockIds,
    ...modifiedBlockIds,
    ...movedBlockIds,
  ]));

  return { addedBlockIds, removedBlockIds, modifiedBlockIds, movedBlockIds, changedBlockIds };
}

function revisionConflictDetails(
  database: NyxDatabase,
  documentId: string,
  baseRevision: number,
  current: DocumentRow,
  requestedBlockIds: string[] = [],
) {
  const base = database
    .prepare(
      `SELECT snapshot_json FROM document_revisions
       WHERE document_id = ? AND revision_number = ?`,
    )
    .get(documentId, baseRevision) as { snapshot_json: string } | undefined;
  const currentContent = contentFromRows(current, loadBlockRows(database, documentId));
  const changes = base
    ? topLevelBlockChanges(parseRevisionSnapshot(base.snapshot_json), currentContent)
    : {
        addedBlockIds: currentContent.blocks.map((block) => block.id),
        removedBlockIds: [],
        modifiedBlockIds: [],
        movedBlockIds: [],
        changedBlockIds: currentContent.blocks.map((block) => block.id),
      };
  const changed = new Set(changes.changedBlockIds);
  return {
    baseRevision,
    currentRevision: current.revision_number,
    currentRevisionId: current.current_revision_id,
    diffAvailable: Boolean(base),
    ...changes,
    conflictingBlockIds: requestedBlockIds.filter((id) => changed.has(id)),
  };
}

function snapshot(value: unknown) {
  return JSON.stringify(value);
}

function revisionOrigin(actor: DocumentActor) {
  if (actor.source === "rollback") return "rollback";
  if (actor.type === "agent") return "agent";
  if (actor.type === "human") return "human";
  return "seed";
}

function tableHasColumn(
  database: NyxDatabase,
  table: string,
  column: string,
) {
  return Boolean(database.prepare(
    "SELECT 1 FROM pragma_table_info(?) WHERE name = ?",
  ).get(table, column));
}

function insertEvent(
  database: NyxDatabase,
  input: {
    workspaceId: string;
    documentId: string;
    revisionId: string;
    eventType: DocumentEvent["eventType"];
    actor: DocumentActor;
    summary: string;
    createdAt: string;
  },
) {
  const supportsActorSnapshot = tableHasColumn(
    database,
    "document_events",
    "actor_principal_id",
  ) && tableHasColumn(database, "document_events", "actor_avatar_media_id");
  if (!supportsActorSnapshot) {
    const result = database
      .prepare(
        `INSERT INTO document_events
         (id, workspace_id, document_id, revision_id, event_type, actor_type,
          actor_user_id, actor_token_id, actor_label, source, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.workspaceId,
        input.documentId,
        input.revisionId,
        input.eventType,
        input.actor.type,
        input.actor.userId,
        input.actor.tokenId ?? null,
        input.actor.label,
        input.actor.source,
        input.summary,
        input.createdAt,
      );
    return Number(result.lastInsertRowid);
  }
  const result = database
    .prepare(
      `INSERT INTO document_events
       (id, workspace_id, document_id, revision_id, event_type, actor_type,
        actor_user_id, actor_token_id, actor_label, source, summary, created_at,
        actor_principal_id, actor_avatar_media_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.workspaceId,
      input.documentId,
      input.revisionId,
      input.eventType,
      input.actor.type,
      input.actor.userId,
      input.actor.tokenId ?? null,
      input.actor.label,
      input.actor.source,
      input.summary,
      input.createdAt,
      input.actor.principalId ?? (input.actor.type === "human" ? input.actor.userId : null),
      input.actor.avatarMediaId ?? null,
    );
  return Number(result.lastInsertRowid);
}

type CanonicalRevisionWrite = {
  workspaceId: string;
  documentId: string;
  revisionNumber: number;
  baseRevisionId: string | null;
  content: NyxdocDocumentV2;
  title: string;
  parentDocumentId: string | null;
  metadata: DocumentMetadata;
  actor: DocumentActor;
  summary: string;
  eventType: DocumentEvent["eventType"];
  createdAt: string;
};

/**
 * The only runtime writer for canonical revision rows and their matching event.
 * Callers must already be inside the mutation transaction that persisted the
 * corresponding document projection.
 */
function appendCanonicalRevision(
  database: NyxDatabase,
  input: CanonicalRevisionWrite,
) {
  const revisionId = randomUUID();
  const revisionValues = [
    revisionId,
    input.documentId,
    input.revisionNumber,
    snapshot(input.content),
    input.summary,
    revisionOrigin(input.actor),
    input.actor.userId,
    input.createdAt,
    input.baseRevisionId,
    input.actor.type,
    input.actor.userId,
    input.actor.tokenId ?? null,
    input.actor.label,
    input.actor.source,
    input.title,
    input.parentDocumentId,
    JSON.stringify(input.metadata),
  ];
  const supportsActorSnapshot = tableHasColumn(
    database,
    "document_revisions",
    "actor_principal_id",
  ) && tableHasColumn(database, "document_revisions", "actor_avatar_media_id");
  database.prepare(
    `INSERT INTO document_revisions
     (id, document_id, revision_number, snapshot_json, summary, origin, patch_id,
      created_by_user_id, created_at, base_revision_id, actor_type, actor_user_id,
      actor_token_id, actor_label, source, title_snapshot, parent_document_id_snapshot,
      document_metadata_json${supportsActorSnapshot ? ", actor_principal_id, actor_avatar_media_id" : ""})
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${supportsActorSnapshot ? ", ?, ?" : ""})`,
  ).run(
    ...revisionValues,
    ...(supportsActorSnapshot
      ? [
          input.actor.principalId ?? (input.actor.type === "human" ? input.actor.userId : null),
          input.actor.avatarMediaId ?? null,
        ]
      : []),
  );
  database
    .prepare("UPDATE documents SET current_revision_id = ?, updated_at = ? WHERE id = ?")
    .run(revisionId, input.createdAt, input.documentId);
  const eventCursor = insertEvent(database, {
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    revisionId,
    eventType: input.eventType,
    actor: input.actor,
    summary: input.summary,
    createdAt: input.createdAt,
  });
  return { revisionId, eventCursor };
}

function uniqueSlug(database: NyxDatabase, workspaceId: string, title: string) {
  const normalized = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const base = normalized || `document-${randomUUID().slice(0, 8)}`;
  let slug = base;
  let suffix = 2;
  while (database.prepare("SELECT 1 FROM documents WHERE workspace_id = ? AND slug = ?").get(workspaceId, slug)) {
    slug = `${base}-${suffix++}`;
  }
  return slug;
}

function requireParentDocument(
  database: NyxDatabase,
  workspaceId: string,
  parentDocumentId: string | null,
) {
  if (parentDocumentId === null) return;
  const parent = database
    .prepare("SELECT id FROM documents WHERE workspace_id = ? AND id = ? AND status = 'active'")
    .get(workspaceId, parentDocumentId);
  if (!parent) {
    throw new DocumentServiceError("INVALID_INPUT", "부모 문서를 찾을 수 없습니다.");
  }
}

function nextTreeOrder(
  database: NyxDatabase,
  workspaceId: string,
  parentDocumentId: string | null,
) {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(tree_order), 0) + 100 AS next_order
       FROM documents
       WHERE workspace_id = ? AND status = 'active' AND parent_document_id IS ?`,
    )
    .get(workspaceId, parentDocumentId) as { next_order: number };
  return Number(row.next_order);
}

function wouldCreateDocumentCycle(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  parentDocumentId: string,
) {
  return Boolean(
    database
      .prepare(
        `WITH RECURSIVE ancestors(id, parent_document_id) AS (
           SELECT id, parent_document_id
           FROM documents
           WHERE workspace_id = ? AND id = ? AND status = 'active'
           UNION ALL
           SELECT d.id, d.parent_document_id
           FROM documents d
           JOIN ancestors a ON d.id = a.parent_document_id
           WHERE d.workspace_id = ? AND d.status = 'active'
         )
         SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
      )
      .get(workspaceId, parentDocumentId, workspaceId, documentId),
  );
}

export function assertWorkspaceMembership(database: NyxDatabase, workspaceId: string, userId: string) {
  const membership = database
    .prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
    .get(workspaceId, userId);
  if (!membership) {
    throw new DocumentServiceError("FORBIDDEN", "이 워크스페이스에 접근할 수 없습니다.");
  }
}

export function listDocuments(database: NyxDatabase, workspaceId: string): DocumentSummary[] {
  const rows = database
    .prepare(
      `SELECT d.id, d.workspace_id, d.title, d.slug, d.status,
              d.parent_document_id, d.tree_order, d.current_revision_id,
              d.content_schema_version, d.document_type, d.workflow_status, d.tags_json,
              COALESCE(r.revision_number, 0) AS revision_number, d.created_at, d.updated_at
       FROM documents d
       LEFT JOIN document_revisions r ON r.id = d.current_revision_id
       WHERE d.workspace_id = ? AND d.status = 'active'
       ORDER BY CASE WHEN d.parent_document_id IS NULL THEN 0 ELSE 1 END,
                d.tree_order ASC, d.created_at ASC`,
    )
    .all(workspaceId) as DocumentRow[];
  const documents = rows.map(mapSummary);
  const byId = new Map(documents.map((document) => [document.id, document]));
  const children = new Map<string | null, DocumentSummary[]>();
  for (const document of documents) {
    const parentId = document.parentDocumentId && byId.has(document.parentDocumentId)
      ? document.parentDocumentId
      : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(document);
    children.set(parentId, siblings);
  }
  const compare = (left: DocumentSummary, right: DocumentSummary) =>
    left.treeOrder - right.treeOrder
    || left.title.localeCompare(right.title, "ko")
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
  for (const siblings of children.values()) siblings.sort(compare);

  const ordered: DocumentSummary[] = [];
  const visited = new Set<string>();
  const visit = (document: DocumentSummary) => {
    if (visited.has(document.id)) return;
    visited.add(document.id);
    ordered.push(document);
    for (const child of children.get(document.id) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  for (const document of documents.sort(compare)) visit(document);
  return ordered;
}

export type ListDocumentsQuery = {
  parentDocumentId?: string | null;
  withinDocumentId?: string;
  titlePrefix?: string;
  documentType?: string;
  workflowStatus?: DocumentWorkflowStatus;
  tag?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  updatedWithinDays?: number;
  assignedAgentId?: string;
  assignmentType?: "owner" | "contributor" | "reviewer";
  unassigned?: boolean;
  sort?: "tree" | "updated_desc";
  offset?: number;
  limit?: number;
};

function documentPath(document: DocumentSummary, byId: Map<string, DocumentSummary>) {
  const path: DocumentListEntry["path"] = [];
  const visited = new Set<string>();
  let current: DocumentSummary | undefined = document;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift({ id: current.id, title: current.title });
    current = current.parentDocumentId ? byId.get(current.parentDocumentId) : undefined;
  }
  return path;
}

export function queryDocuments(
  database: NyxDatabase,
  workspaceId: string,
  query: ListDocumentsQuery = {},
) {
  if (query.unassigned && query.assignedAgentId) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "미할당 문서와 특정 에이전트 담당 문서를 동시에 조회할 수 없습니다.",
    );
  }
  const all = listDocuments(database, workspaceId);
  const byId = new Map(all.map((document) => [document.id, document]));
  if (query.withinDocumentId && !byId.has(query.withinDocumentId)) {
    throw new DocumentServiceError("NOT_FOUND", "조회 범위의 문서를 찾을 수 없습니다.");
  }
  const normalizeSearch = (value: string) => value.normalize("NFC").toLocaleLowerCase();
  const prefix = query.titlePrefix ? normalizeSearch(query.titlePrefix.trim()) : undefined;
  const documentType = query.documentType ? normalizeSearch(query.documentType.trim()) : undefined;
  const tag = query.tag ? normalizeSearch(query.tag.trim()) : undefined;
  const updatedAfter = query.updatedWithinDays
    ? new Date(Date.now() - Math.max(1, query.updatedWithinDays) * 86_400_000).toISOString()
    : query.updatedAfter;
  const assignmentFilterActive = Boolean(query.assignedAgentId || query.assignmentType || query.unassigned);
  const assignmentRows = assignmentFilterActive
    ? database.prepare(
      `SELECT document_id, agent_id, assignment_type
       FROM agent_document_assignments
       WHERE workspace_id = ? AND status = 'active'`,
    ).all(workspaceId) as Array<{
      document_id: string;
      agent_id: string;
      assignment_type: "owner" | "contributor" | "reviewer";
    }>
    : [];
  const assignmentsByDocument = new Map<string, typeof assignmentRows>();
  for (const assignment of assignmentRows) {
    const items = assignmentsByDocument.get(assignment.document_id) ?? [];
    items.push(assignment);
    assignmentsByDocument.set(assignment.document_id, items);
  }
  let documents: DocumentListEntry[] = all
    .map((document) => ({ ...document, path: documentPath(document, byId) }))
    .filter((document) => {
      if (query.parentDocumentId !== undefined && document.parentDocumentId !== query.parentDocumentId) return false;
      if (query.withinDocumentId && !document.path.some((item) => item.id === query.withinDocumentId)) return false;
      if (prefix && !normalizeSearch(document.title).startsWith(prefix)) return false;
      if (documentType && (!document.documentType || normalizeSearch(document.documentType) !== documentType)) return false;
      if (query.workflowStatus && document.workflowStatus !== query.workflowStatus) return false;
      if (tag && !document.tags.some((value) => normalizeSearch(value) === tag)) return false;
      if (updatedAfter && document.updatedAt <= updatedAfter) return false;
      if (query.updatedBefore && document.updatedAt >= query.updatedBefore) return false;
      if (assignmentFilterActive) {
        const assignments = assignmentsByDocument.get(document.id) ?? [];
        if (query.unassigned && assignments.length > 0) return false;
        if (
          !query.unassigned
          && !assignments.some((assignment) =>
            (!query.assignedAgentId || assignment.agent_id === query.assignedAgentId)
            && (!query.assignmentType || assignment.assignment_type === query.assignmentType))
        ) return false;
      }
      return true;
    });
  if (query.sort === "updated_desc") {
    documents = documents.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 100)));
  const page = documents.slice(offset, offset + limit);
  return {
    documents: page,
    nextOffset: offset + page.length < documents.length ? offset + page.length : null,
    total: documents.length,
  };
}

export function batchGetDocuments(
  database: NyxDatabase,
  workspaceId: string,
  documentIds: string[],
) {
  if (!Array.isArray(documentIds) || documentIds.length < 1 || documentIds.length > 50) {
    throw new DocumentServiceError("INVALID_INPUT", "한 번에 1개 이상 50개 이하의 문서를 읽을 수 있습니다.");
  }
  const uniqueIds = Array.from(new Set(documentIds));
  const documents: DocumentDetail[] = [];
  const missingDocumentIds: string[] = [];
  for (const documentId of uniqueIds) {
    try {
      documents.push(getDocument(database, workspaceId, documentId));
    } catch (error) {
      if (error instanceof DocumentServiceError && error.code === "NOT_FOUND") {
        missingDocumentIds.push(documentId);
        continue;
      }
      throw error;
    }
  }
  return { documents, missingDocumentIds };
}

export function getDocumentBacklinks(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
): DocumentBacklink[] {
  const target = loadDocumentRow(database, workspaceId, documentId);
  if (!target || target.status !== "active") {
    throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
  }
  const rows = database
    .prepare(
      `SELECT r.source_document_id, r.source_block_id
       FROM document_references r
       JOIN documents source ON source.id = r.source_document_id
       WHERE r.target_document_id = ?
         AND source.workspace_id = ?
         AND source.status = 'active'
       ORDER BY source.updated_at DESC, r.source_block_id ASC`,
    )
    .all(documentId, workspaceId) as Array<{ source_document_id: string; source_block_id: string }>;
  const all = listDocuments(database, workspaceId);
  const byId = new Map(all.map((document) => [document.id, document]));
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const blockIds = grouped.get(row.source_document_id) ?? [];
    blockIds.push(row.source_block_id);
    grouped.set(row.source_document_id, blockIds);
  }
  return Array.from(grouped, ([sourceDocumentId, blockIds]) => {
    const document = byId.get(sourceDocumentId)!;
    return {
      document: { ...document, path: documentPath(document, byId) },
      blockIds: Array.from(new Set(blockIds)),
    };
  });
}

export function getDocument(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
): DocumentDetail {
  const row = loadDocumentRow(database, workspaceId, documentId);
  if (!row || row.status !== "active") {
    throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
  }
  const rows = loadBlockRows(database, row.id);
  return {
    ...mapSummary(row),
    workspaceId: row.workspace_id,
    content: contentFromRows(row, rows),
  };
}

export function createDocument(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
  input: CreateDocumentInput,
): DocumentMutationResult {
  const idempotency = prepareAgentWrite(
    actor,
    input.idempotencyOperation ?? "create_document",
    input.requestId,
    {
      title: input.title,
      parentDocumentId: input.parentDocumentId ?? null,
      documentType: input.documentType ?? null,
      workflowStatus: input.workflowStatus ?? "draft",
      tags: input.tags ?? [],
      content: input.content,
      summary: input.summary,
    },
  );
  const title = cleanTitle(input.title);
  let parentDocumentId = input.parentDocumentId ?? null;
  const documentType = cleanDocumentType(input.documentType) ?? null;
  const workflowStatus = cleanWorkflowStatus(input.workflowStatus) ?? "draft";
  const tags = cleanTags(input.tags) ?? [];
  const summary = cleanSummary(input.summary, `${actor.label}가 문서를 만들었습니다.`);

  return database.transaction(() => {
    const replayed = replayAgentWrite<DocumentMutationResult>(database, idempotency);
    if (replayed) return replayed;
    const actorRootDocumentId = actorDocumentRoot(database, workspaceId, actor);
    if (actorRootDocumentId) {
      if (parentDocumentId === null) parentDocumentId = actorRootDocumentId;
      if (!documentIsWithinRoot(database, workspaceId, parentDocumentId, actorRootDocumentId)) {
        throw new DocumentServiceError("FORBIDDEN", "이 연결의 허용 범위 밖에 문서를 만들 수 없습니다.");
      }
    }
    requireParentDocument(database, workspaceId, parentDocumentId);
    const documentId = randomUUID();
    const normalizedV2 = normalizeTopLevelBlockIds(
      database,
      documentId,
      input.content,
    );
    const normalization = blockIdNormalization(normalizedV2.repairs);
    const persistedV2 = prepareV2Content(normalizedV2.content);
    assertContentMediaOwnership(database, workspaceId, persistedV2.content);
    assertContentDocumentReferences(
      database,
      workspaceId,
      persistedV2.content,
      actorDocumentRoot(database, workspaceId, actor),
    );
    const now = new Date().toISOString();
    const blocks: PreparedBlockInput[] = persistedV2.blocks;
    const treeOrder = nextTreeOrder(database, workspaceId, parentDocumentId);
    database
      .prepare(
        `INSERT INTO documents
         (id, workspace_id, title, slug, status, parent_document_id, tree_order,
          current_revision_id, content_schema_version, document_type, workflow_status, tags_json,
          created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        workspaceId,
        title,
        uniqueSlug(database, workspaceId, title),
        parentDocumentId,
        treeOrder,
        2,
        documentType,
        workflowStatus,
        JSON.stringify(tags),
        actor.userId,
        now,
        now,
      );

    const insertBlock = database.prepare(
      `INSERT INTO document_blocks
       (id, document_id, block_type, content, content_json, indent_level, metadata_json,
        sort_order, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    blocks.forEach((block, index) => {
      const created = {
        id: block.id ?? randomUUID(),
        type: block.type,
        content: block.content,
        indent: block.indent,
        ...(block.checked !== undefined ? { checked: block.checked } : {}),
        ...(block.table ? { table: block.table } : {}),
        order: (index + 1) * 100,
        version: 1,
      };
      insertBlock.run(
        created.id,
        documentId,
        created.type,
        created.content,
        block.contentJson ?? null,
        created.indent,
        metadataJson(created),
        created.order,
        now,
        now,
      );
    });
    syncDocumentReferences(database, documentId, persistedV2.content);
    syncDocumentMediaBindings(
      database,
      workspaceId,
      documentId,
      persistedV2.content,
      now,
    );

    const { revisionId, eventCursor } = appendCanonicalRevision(database, {
      workspaceId,
      documentId,
      revisionNumber: 1,
      baseRevisionId: null,
      content: persistedV2.content,
      title,
      parentDocumentId,
      metadata: { documentType, workflowStatus, tags },
      actor,
      summary,
      eventType: "created",
      createdAt: now,
    });
    const result: DocumentMutationResult = {
      document: {
        id: documentId,
        workspaceId,
        title,
        slug: uniqueSlugForRead(database, documentId),
        status: "active" as const,
        parentDocumentId,
        treeOrder,
        revisionId,
        revisionNumber: 1,
        documentType,
        workflowStatus,
        tags,
        createdAt: now,
        updatedAt: now,
        content: persistedV2.content,
      },
      eventCursor,
      unchanged: false,
      ...(normalization ? { normalization } : {}),
    };
    recordAgentWrite(database, idempotency, documentId, result);
    return result;
  }).immediate();
}

function uniqueSlugForRead(database: NyxDatabase, documentId: string) {
  return (database.prepare("SELECT slug FROM documents WHERE id = ?").get(documentId) as { slug: string }).slug;
}

export function updateDocument(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
  documentId: string,
  input: UpdateDocumentInput,
): DocumentMutationResult {
  const idempotency = prepareAgentWrite(
    actor,
    input.idempotencyOperation ?? "update_document",
    input.requestId,
    {
      documentId,
      baseRevision: input.baseRevision,
      title: input.title,
      parentDocumentId: input.parentDocumentId,
      documentType: input.documentType,
      workflowStatus: input.workflowStatus,
      tags: input.tags,
      content: input.content,
      summary: input.summary,
    },
  );
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 1) {
    throw new DocumentServiceError("INVALID_INPUT", "기준 리비전 번호가 필요합니다.");
  }
  if (
    input.title === undefined
    && input.parentDocumentId === undefined
    && input.documentType === undefined
    && input.workflowStatus === undefined
    && input.tags === undefined
    && input.content === undefined
  ) {
    throw new DocumentServiceError("INVALID_INPUT", "바꿀 제목, 위치, 메타데이터 또는 본문이 필요합니다.");
  }
  const title = input.title === undefined ? undefined : cleanTitle(input.title);
  const documentType = cleanDocumentType(input.documentType);
  const workflowStatus = cleanWorkflowStatus(input.workflowStatus);
  const tags = cleanTags(input.tags);

  return database.transaction(() => {
    const replayed = replayAgentWrite<DocumentMutationResult>(database, idempotency);
    if (replayed) return replayed;
    const current = loadDocumentRow(database, workspaceId, documentId);
    if (!current || current.status !== "active") {
      throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }
    const lifecycle = database.prepare(
      "SELECT lifecycle_state FROM documents WHERE id = ? AND workspace_id = ?",
    ).get(documentId, workspaceId) as { lifecycle_state: string } | undefined;
    if (lifecycle?.lifecycle_state !== "active") {
      throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }
    if (current.content_schema_version !== 2) {
      throw new DocumentServiceError("INVALID_INPUT", "정본 AST v2 본문이 없는 문서입니다.");
    }
    const actorRootDocumentId = actorDocumentRoot(database, workspaceId, actor);
    if (
      actorRootDocumentId
      && !documentIsWithinRoot(database, workspaceId, documentId, actorRootDocumentId)
    ) {
      throw new DocumentServiceError("FORBIDDEN", "이 연결의 허용 범위 밖에 있는 문서입니다.");
    }
    if (current.revision_number !== input.baseRevision) {
      throw new DocumentServiceError(
        "REVISION_CONFLICT",
        "문서가 이미 변경되었습니다. 최신 리비전을 다시 읽고 변경을 적용해주세요.",
        revisionConflictDetails(database, documentId, input.baseRevision, current),
      );
    }
    if (
      input.parentDocumentId !== undefined
      && input.parentDocumentId !== current.parent_document_id
    ) {
      requireDocumentMoveAuthorization(
        database,
        workspaceId,
        documentId,
        input.parentDocumentId,
        actor,
        { requireCommitPermission: true },
      );
    }
    const normalizedV2 = input.content === undefined
      ? null
      : normalizeTopLevelBlockIds(database, documentId, input.content);
    const normalization = normalizedV2
      ? blockIdNormalization(normalizedV2.repairs)
      : undefined;
    const preparedV2 = normalizedV2 === null
      ? null
      : prepareV2Content(normalizedV2.content);
    const blocks: PreparedBlockInput[] | undefined = preparedV2?.blocks;
    if (preparedV2) {
      assertContentMediaOwnership(database, workspaceId, preparedV2.content);
      assertContentDocumentReferences(
        database,
        workspaceId,
        preparedV2.content,
        actorDocumentRoot(database, workspaceId, actor),
      );
    }

    const now = new Date().toISOString();
    let changed = false;
    if (title !== undefined && title !== current.title) {
      database.prepare("UPDATE documents SET title = ? WHERE id = ?").run(title, documentId);
      changed = true;
    }

    if (documentType !== undefined && documentType !== current.document_type) {
      database.prepare("UPDATE documents SET document_type = ? WHERE id = ?").run(documentType, documentId);
      changed = true;
    }
    if (workflowStatus !== undefined && workflowStatus !== current.workflow_status) {
      database.prepare("UPDATE documents SET workflow_status = ? WHERE id = ?").run(workflowStatus, documentId);
      changed = true;
    }
    if (tags !== undefined && JSON.stringify(tags) !== JSON.stringify(parseDocumentTags(current.tags_json))) {
      database.prepare("UPDATE documents SET tags_json = ? WHERE id = ?").run(JSON.stringify(tags), documentId);
      changed = true;
    }

    if (input.parentDocumentId !== undefined && input.parentDocumentId !== current.parent_document_id) {
      const parentDocumentId = input.parentDocumentId;
      if (
        actorRootDocumentId
        && (
          parentDocumentId === null
          || !documentIsWithinRoot(database, workspaceId, parentDocumentId, actorRootDocumentId)
        )
      ) {
        throw new DocumentServiceError("FORBIDDEN", "이 연결의 허용 범위 밖으로 문서를 옮길 수 없습니다.");
      }
      requireParentDocument(database, workspaceId, parentDocumentId);
      if (parentDocumentId === documentId) {
        throw new DocumentServiceError("INVALID_INPUT", "문서를 자기 자신의 하위 문서로 옮길 수 없습니다.");
      }
      if (
        parentDocumentId !== null &&
        wouldCreateDocumentCycle(database, workspaceId, documentId, parentDocumentId)
      ) {
        throw new DocumentServiceError("INVALID_INPUT", "하위 문서 아래로 옮기면 문서 트리가 순환합니다.");
      }
      database
        .prepare("UPDATE documents SET parent_document_id = ?, tree_order = ? WHERE id = ?")
        .run(parentDocumentId, nextTreeOrder(database, workspaceId, parentDocumentId), documentId);
      // The move can take this document (or its descendants) outside another
      // agent grant's document-tree root. Cancel stale active responsibility
      // rows before this canonical revision is committed.
      cancelAssignmentsOutsideWorkspaceAgentBoundaries(database, {
        workspaceId,
        actor: {
          type: actor.type,
          label: actor.label,
          userId: actor.type === "human" ? actor.userId : null,
          agentId: actor.type === "agent" ? actor.principalId ?? null : null,
        },
        reason: "document_moved",
        now,
      });
      changed = true;
    }

    if (blocks !== undefined) {
      const existingRows = database
        .prepare(
          `SELECT id, block_type, content, content_json, indent_level, metadata_json,
                  sort_order, version, deleted_at
           FROM document_blocks WHERE document_id = ?`,
        )
        .all(documentId) as BlockRow[];
      const existing = new Map(existingRows.map((block) => [block.id, block]));
      const activeRows = existingRows.filter((block) => !block.deleted_at);
      const includedIds = new Set(blocks.flatMap((block) => (block.id ? [block.id] : [])));

      for (const id of includedIds) {
        if (!existing.has(id)) {
          const owner = database
            .prepare("SELECT document_id FROM document_blocks WHERE id = ?")
            .get(id) as { document_id: string } | undefined;
          if (owner) {
            throw new DocumentServiceError("INVALID_INPUT", "다른 문서에서 사용 중인 블록 ID가 포함되어 있습니다.");
          }
        }
      }

      for (const block of activeRows) {
        if (!includedIds.has(block.id)) {
          database
            .prepare("UPDATE document_blocks SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
            .run(now, now, block.id);
          changed = true;
        }
      }

      const insertBlock = database.prepare(
        `INSERT INTO document_blocks
         (id, document_id, block_type, content, content_json, indent_level, metadata_json,
          sort_order, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      );
      const updateBlock = database.prepare(
        `UPDATE document_blocks
         SET block_type = ?, content = ?, content_json = ?, indent_level = ?, metadata_json = ?,
             sort_order = ?, version = version + 1, updated_at = ?, deleted_at = NULL
         WHERE id = ?`,
      );
      blocks.forEach((block, index) => {
        const order = (index + 1) * 100;
        const metadata = metadataJson(block);
        const before = block.id ? existing.get(block.id) : undefined;
        if (!before) {
          insertBlock.run(
            block.id ?? randomUUID(),
            documentId,
            block.type,
            block.content,
            block.contentJson ?? null,
            block.indent,
            metadata,
            order,
            now,
            now,
          );
          changed = true;
          return;
        }
        if (
          Boolean(before.deleted_at) ||
          before.block_type !== block.type ||
          before.content !== block.content ||
          before.content_json !== (block.contentJson ?? null) ||
          before.indent_level !== block.indent ||
          before.metadata_json !== metadata ||
          before.sort_order !== order
        ) {
          updateBlock.run(
            block.type,
            block.content,
            block.contentJson ?? null,
            block.indent,
            metadata,
            order,
            now,
            block.id,
          );
          changed = true;
        }
      });

      syncDocumentReferences(database, documentId, preparedV2!.content);
      syncDocumentMediaBindings(
        database,
        workspaceId,
        documentId,
        preparedV2!.content,
        now,
      );
    }

    if (!changed) {
      const result = {
        document: getDocument(database, workspaceId, documentId),
        eventCursor: null,
        unchanged: true,
        ...(normalization ? { normalization } : {}),
      } satisfies DocumentMutationResult;
      recordAgentWrite(database, idempotency, documentId, result);
      return result;
    }

    const nextDocument = getDocument(database, workspaceId, documentId);
    const revisionNumber = current.revision_number + 1;
    const summary = cleanSummary(input.summary, `${actor.label}가 문서를 수정했습니다.`);
    const { eventCursor } = appendCanonicalRevision(database, {
      workspaceId,
      documentId,
      revisionNumber,
      baseRevisionId: current.current_revision_id,
      content: nextDocument.content,
      title: nextDocument.title,
      parentDocumentId: nextDocument.parentDocumentId,
      metadata: {
        documentType: nextDocument.documentType,
        workflowStatus: nextDocument.workflowStatus,
        tags: nextDocument.tags,
      },
      actor,
      summary,
      eventType: actor.source === "rollback" ? "restored" : "updated",
      createdAt: now,
    });
    const result: DocumentMutationResult = {
      document: getDocument(database, workspaceId, documentId),
      eventCursor,
      unchanged: false,
      ...(normalization ? { normalization } : {}),
    };
    recordAgentWrite(database, idempotency, documentId, result);
    return result;
  }).immediate();
}

function requirePatchBlockIndex(blocks: NyxdocBlock[], blockId: string, role: "block" | "anchor") {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      role === "anchor" ? "patch 기준 블록을 찾을 수 없습니다." : "patch 대상 블록을 찾을 수 없습니다.",
      { blockId },
    );
  }
  return index;
}

export function applyDocumentPatch(content: NyxdocDocumentV2, operations: DocumentPatchOperation[]) {
  const blocks = structuredClone(content.blocks) as NyxdocBlock[];

  for (const operation of operations) {
    if (operation.op === "replace_block") {
      const index = requirePatchBlockIndex(blocks, operation.blockId, "block");
      blocks[index] = preparePatchBlock(operation.block, operation.blockId);
      continue;
    }

    if (operation.op === "insert_before" || operation.op === "insert_after") {
      const anchorIndex = requirePatchBlockIndex(blocks, operation.anchorBlockId, "anchor");
      const inserted = operation.blocks.map((block) => preparePatchBlock(block));
      blocks.splice(operation.op === "insert_before" ? anchorIndex : anchorIndex + 1, 0, ...inserted);
      continue;
    }

    if (operation.op === "delete_block") {
      const index = requirePatchBlockIndex(blocks, operation.blockId, "block");
      blocks.splice(index, 1);
      continue;
    }

    if (!("blockId" in operation)) {
      throw new DocumentServiceError("INVALID_INPUT", "지원하지 않는 patch 연산입니다.");
    }
    if (operation.blockId === operation.anchorBlockId) {
      throw new DocumentServiceError("INVALID_INPUT", "블록을 자기 자신 기준으로 이동할 수 없습니다.");
    }
    const sourceIndex = requirePatchBlockIndex(blocks, operation.blockId, "block");
    const [moved] = blocks.splice(sourceIndex, 1);
    const anchorIndex = requirePatchBlockIndex(blocks, operation.anchorBlockId, "anchor");
    blocks.splice(operation.op === "move_before" ? anchorIndex : anchorIndex + 1, 0, moved);
  }

  try {
    return parseNyxdocDocumentV2({ schemaVersion: 2, blocks });
  } catch {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "patch 결과가 유효한 AST v2 문서가 아닙니다. 문서에는 최소 한 개의 블록이 필요합니다.",
    );
  }
}

export function patchDocument(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
  documentId: string,
  input: PatchDocumentInput,
): DocumentMutationResult {
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 1) {
    throw new DocumentServiceError("INVALID_INPUT", "기준 리비전 번호가 필요합니다.");
  }
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100) {
    throw new DocumentServiceError("INVALID_INPUT", "patch에는 1개 이상 100개 이하의 연산이 필요합니다.");
  }
  const idempotency = prepareAgentWrite(actor, "patch_document", input.requestId, {
    documentId,
    baseRevision: input.baseRevision,
    operations: input.operations,
    summary: input.summary,
  });
  if (!idempotency) {
    throw new DocumentServiceError("INVALID_INPUT", "patch_document에는 requestId가 필요합니다.");
  }

  return database.transaction(() => {
    const replayed = replayAgentWrite<DocumentMutationResult>(database, idempotency);
    if (replayed) return replayed;

    const currentRow = loadDocumentRow(database, workspaceId, documentId);
    if (!currentRow || currentRow.status !== "active") {
      throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }
    if (currentRow.revision_number !== input.baseRevision) {
      throw new DocumentServiceError(
        "REVISION_CONFLICT",
        "문서가 이미 변경되었습니다. 충돌 블록을 확인하고 최신 문서에 의도를 다시 적용해주세요.",
        revisionConflictDetails(
          database,
          documentId,
          input.baseRevision,
          currentRow,
          requestedPatchBlockIds(input.operations),
        ),
      );
    }

    const current = getDocument(database, workspaceId, documentId);
    const content = applyDocumentPatch(current.content, input.operations);
    const result = updateDocument(database, workspaceId, actor, documentId, {
      baseRevision: input.baseRevision,
      content,
      summary: input.summary ?? `${actor.label}가 ${input.operations.length}개 블록 연산을 적용했습니다.`,
    });
    recordAgentWrite(database, idempotency, documentId, result);
    return result;
  }).immediate();
}

export function archiveDocument(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
  documentId: string,
  input: ArchiveDocumentInput,
): ArchiveDocumentResult {
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 1) {
    throw new DocumentServiceError("INVALID_INPUT", "기준 리비전 번호가 필요합니다.");
  }

  return database.transaction(() => {
    const current = loadDocumentRow(database, workspaceId, documentId);
    if (!current || current.status !== "active") {
      throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }
    if (current.revision_number !== input.baseRevision) {
      throw new DocumentServiceError(
        "REVISION_CONFLICT",
        "문서가 이미 변경되었습니다. 최신 리비전을 다시 읽고 삭제해주세요.",
        { currentRevision: current.revision_number, currentRevisionId: current.current_revision_id },
      );
    }

    const subtree = database
      .prepare(
        `WITH RECURSIVE subtree(id, title, current_revision_id, parent_document_id, tree_order, depth) AS (
           SELECT id, title, current_revision_id, parent_document_id, tree_order, 0
           FROM documents
           WHERE workspace_id = ? AND id = ? AND status = 'active' AND lifecycle_state = 'active'
           UNION ALL
           SELECT d.id, d.title, d.current_revision_id, d.parent_document_id, d.tree_order, subtree.depth + 1
           FROM documents d
           JOIN subtree ON d.parent_document_id = subtree.id
           WHERE d.workspace_id = ? AND d.status = 'active' AND d.lifecycle_state = 'active'
         )
         SELECT id, title, current_revision_id, parent_document_id, tree_order, depth
         FROM subtree
         ORDER BY depth ASC, id ASC`,
      )
      .all(workspaceId, documentId, workspaceId) as Array<{
      id: string;
      title: string;
      current_revision_id: string | null;
      parent_document_id: string | null;
      tree_order: number;
      depth: number;
    }>;
    const activeCount = Number(
      (database
        .prepare(
          "SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ? AND status = 'active' AND lifecycle_state = 'active'",
        )
        .get(workspaceId) as { count: number }).count,
    );
    if (subtree.length >= activeCount) {
      throw new DocumentServiceError(
        "INVALID_INPUT",
        "마지막 문서는 삭제할 수 없습니다. 새 문서를 만든 뒤 다시 시도해주세요.",
      );
    }
    if (subtree.some((document) => !document.current_revision_id)) {
      throw new DocumentServiceError("INVALID_INPUT", "기록이 없는 문서는 삭제할 수 없습니다.");
    }
    if (input.createdByAgentId) {
      if (actor.type !== "agent" || actor.principalId !== input.createdByAgentId) {
        throw new DocumentServiceError(
          "FORBIDDEN",
          "에이전트 생성 문서 제한은 현재 에이전트의 신원으로만 사용할 수 있습니다.",
        );
      }
      const placeholders = subtree.map(() => "?").join(", ");
      const creatorRows = database.prepare(
        `SELECT document_id, actor_type, actor_principal_id
         FROM document_revisions
         WHERE revision_number = 1 AND document_id IN (${placeholders})`,
      ).all(...subtree.map((document) => document.id)) as Array<{
        document_id: string;
        actor_type: string;
        actor_principal_id: string | null;
      }>;
      const creators = new Map(creatorRows.map((row) => [row.document_id, row]));
      const otherCreatorCount = subtree.filter((document) => {
        const creator = creators.get(document.id);
        return creator?.actor_type !== "agent"
          || creator.actor_principal_id !== input.createdByAgentId;
      }).length;
      if (otherCreatorCount > 0) {
        throw new DocumentServiceError(
          "FORBIDDEN",
          "에디터 에이전트는 자신이 만든 문서 트리만 휴지통으로 옮길 수 있습니다.",
          {
            documentCount: subtree.length,
            otherCreatorCount,
          },
        );
      }
    }

    const now = new Date().toISOString();
    const policy = database.prepare(
      "SELECT trash_retention_days FROM workspaces WHERE id = ?",
    ).get(workspaceId) as { trash_retention_days: number };
    const purgeAfter = new Date(Date.parse(now) + Number(policy.trash_retention_days) * 86_400_000)
      .toISOString();
    const trashBatchId = randomUUID();
    database.prepare(
      `INSERT INTO document_trash_batches
       (id, workspace_id, root_document_id, root_title_snapshot, document_count,
        trashed_at, purge_after, actor_type, actor_user_id, actor_agent_id, actor_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      trashBatchId,
      workspaceId,
      documentId,
      current.title,
      subtree.length,
      now,
      purgeAfter,
      actor.type,
      actor.type === "human" ? actor.userId : null,
      actor.type === "agent" ? actor.principalId ?? null : null,
      actor.label,
    );
    const archive = database.prepare(
      `UPDATE documents
       SET status = 'archived', lifecycle_state = 'trashed', trash_batch_id = ?,
           trashed_at = ?, purge_after = ?, trashed_by_type = ?, trashed_by_user_id = ?,
           trashed_by_agent_id = ?, trashed_by_label = ?,
           original_parent_document_id = parent_document_id,
           original_tree_order = tree_order, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'active' AND lifecycle_state = 'active'`,
    );
    const sealCollaborationGeneration = database.prepare(
      `UPDATE document_collaboration_states
       SET generation = generation + 1
       WHERE workspace_id = ? AND document_id = ?`,
    );
    let eventCursor = 0;
    for (const document of subtree) {
      archive.run(
        trashBatchId,
        now,
        purgeAfter,
        actor.type,
        actor.type === "human" ? actor.userId : null,
        actor.type === "agent" ? actor.principalId ?? null : null,
        actor.label,
        now,
        workspaceId,
        document.id,
      );
      sealCollaborationGeneration.run(workspaceId, document.id);
      eventCursor = insertEvent(database, {
        workspaceId,
        documentId: document.id,
        revisionId: document.current_revision_id!,
        eventType: "archived",
        actor,
        summary: document.depth === 0
          ? `${actor.label}가 “${document.title}” 문서를 휴지통으로 옮겼습니다.`
          : `${actor.label}가 상위 문서와 함께 “${document.title}” 문서를 휴지통으로 옮겼습니다.`,
        createdAt: now,
      });
    }
    recordWorkspaceAuditEvent(database, {
      workspaceId,
      action: "document_trash.created",
      actorType: actor.type,
      actorUserId: actor.type === "human" ? actor.userId : null,
      actorAgentId: actor.type === "agent" ? actor.principalId ?? null : null,
      actorLabel: actor.label,
      targetType: "document_tree",
      targetId: documentId,
      metadata: {
        trashBatchId,
        purgeAfter,
        documentIds: subtree.map((document) => document.id),
      },
      createdAt: now,
    });

    const preferredNextDocument = current.parent_document_id
      ? database
          .prepare(
            "SELECT id FROM documents WHERE workspace_id = ? AND id = ? AND status = 'active' AND lifecycle_state = 'active'",
          )
          .get(workspaceId, current.parent_document_id) as { id: string } | undefined
      : undefined;
    const fallbackNextDocument = database
      .prepare(
        `SELECT id FROM documents
         WHERE workspace_id = ? AND status = 'active' AND lifecycle_state = 'active'
         ORDER BY CASE WHEN parent_document_id IS NULL THEN 0 ELSE 1 END,
                  tree_order ASC, created_at ASC
         LIMIT 1`,
      )
      .get(workspaceId) as { id: string };

    return {
      archivedDocumentIds: subtree.map((document) => document.id),
      archivedCount: subtree.length,
      nextDocumentId: preferredNextDocument?.id ?? fallbackNextDocument.id,
      eventCursor,
    };
  }).immediate();
}

export function listTrashBatches(
  database: NyxDatabase,
  workspaceId: string,
): TrashBatchSummary[] {
  const rows = database.prepare(
    `SELECT b.id, b.root_document_id, b.root_title_snapshot, b.document_count,
            b.trashed_at, b.purge_after, b.actor_type, b.actor_label
     FROM document_trash_batches b
     WHERE b.workspace_id = ?
       AND EXISTS (
         SELECT 1 FROM documents d
         WHERE d.workspace_id = b.workspace_id
           AND d.trash_batch_id = b.id
           AND d.lifecycle_state = 'trashed'
       )
     ORDER BY b.trashed_at DESC, b.id DESC`,
  ).all(workspaceId) as Array<{
    id: string;
    root_document_id: string;
    root_title_snapshot: string;
    document_count: number;
    trashed_at: string;
    purge_after: string;
    actor_type: TrashBatchSummary["actorType"];
    actor_label: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    rootDocumentId: row.root_document_id,
    rootTitle: row.root_title_snapshot,
    documentCount: Number(row.document_count),
    trashedAt: row.trashed_at,
    purgeAfter: row.purge_after,
    actorType: row.actor_type,
    actorLabel: row.actor_label,
  }));
}

function trashBatchForRoot(
  database: NyxDatabase,
  workspaceId: string,
  rootDocumentId: string,
) {
  return database.prepare(
    `SELECT id, root_document_id, root_title_snapshot
     FROM document_trash_batches
     WHERE workspace_id = ? AND root_document_id = ?`,
  ).get(workspaceId, rootDocumentId) as {
    id: string;
    root_document_id: string;
    root_title_snapshot: string;
  } | undefined;
}

export function restoreTrashedDocument(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
  rootDocumentId: string,
): TrashMutationResult {
  return database.transaction(() => {
    const batch = trashBatchForRoot(database, workspaceId, rootDocumentId);
    if (!batch) throw new DocumentServiceError("NOT_FOUND", "휴지통 문서를 찾을 수 없습니다.");
    const rows = database.prepare(
      `SELECT id, title, current_revision_id, original_parent_document_id, original_tree_order
       FROM documents
       WHERE workspace_id = ? AND trash_batch_id = ? AND lifecycle_state = 'trashed'
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, original_tree_order ASC, id ASC`,
    ).all(workspaceId, batch.id, rootDocumentId) as Array<{
      id: string;
      title: string;
      current_revision_id: string | null;
      original_parent_document_id: string | null;
      original_tree_order: number | null;
    }>;
    if (rows.length === 0 || rows.some((row) => !row.current_revision_id)) {
      throw new DocumentServiceError("NOT_FOUND", "복구할 문서 기록을 찾을 수 없습니다.");
    }
    const restoringIds = new Set(rows.map((row) => row.id));
    const now = new Date().toISOString();
    const restore = database.prepare(
      `UPDATE documents
       SET status = 'active', lifecycle_state = 'active', parent_document_id = ?, tree_order = ?,
           trash_batch_id = NULL, trashed_at = NULL, purge_after = NULL,
           trashed_by_type = NULL, trashed_by_user_id = NULL, trashed_by_agent_id = NULL,
           trashed_by_label = NULL, original_parent_document_id = NULL,
           original_tree_order = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND lifecycle_state = 'trashed'`,
    );
    const activateFreshCollaborationGeneration = database.prepare(
      `UPDATE document_collaboration_states
       SET generation = generation + 1, seeded_at = ?, updated_at = ?
       WHERE workspace_id = ? AND document_id = ?`,
    );
    for (const row of rows) {
      const parentId = row.original_parent_document_id;
      const parentIsAvailable = !parentId
        || restoringIds.has(parentId)
        || Boolean(database.prepare(
          `SELECT 1 FROM documents
           WHERE id = ? AND workspace_id = ? AND lifecycle_state = 'active' AND status = 'active'`,
        ).get(parentId, workspaceId));
      restore.run(
        parentIsAvailable ? parentId : null,
        row.original_tree_order ?? 0,
        now,
        row.id,
        workspaceId,
      );
      activateFreshCollaborationGeneration.run(now, now, workspaceId, row.id);
      insertEvent(database, {
        workspaceId,
        documentId: row.id,
        revisionId: row.current_revision_id!,
        eventType: "restored",
        actor,
        summary: row.id === rootDocumentId
          ? `${actor.label}가 “${row.title}” 문서를 휴지통에서 복구했습니다.`
          : `${actor.label}가 상위 문서와 함께 “${row.title}” 문서를 복구했습니다.`,
        createdAt: now,
      });
    }
    database.prepare("DELETE FROM document_trash_batches WHERE id = ? AND workspace_id = ?")
      .run(batch.id, workspaceId);
    recordWorkspaceAuditEvent(database, {
      workspaceId,
      action: "document_trash.restored",
      actorType: actor.type,
      actorUserId: actor.type === "human" ? actor.userId : null,
      actorAgentId: actor.type === "agent" ? actor.principalId ?? null : null,
      actorLabel: actor.label,
      targetType: "document_tree",
      targetId: rootDocumentId,
      metadata: { trashBatchId: batch.id, documentIds: rows.map((row) => row.id) },
      createdAt: now,
    });
    return {
      rootDocumentId,
      documentIds: rows.map((row) => row.id),
      documentCount: rows.length,
    };
  }).immediate();
}

export function purgeTrashedDocument(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
  rootDocumentId: string,
): TrashMutationResult {
  return database.transaction(() => {
    const batch = trashBatchForRoot(database, workspaceId, rootDocumentId);
    if (!batch) throw new DocumentServiceError("NOT_FOUND", "휴지통 문서를 찾을 수 없습니다.");
    const rows = database.prepare(
      `SELECT id, title, slug
       FROM documents
       WHERE workspace_id = ? AND trash_batch_id = ? AND lifecycle_state = 'trashed'
       ORDER BY id`,
    ).all(workspaceId, batch.id) as Array<{ id: string; title: string; slug: string }>;
    if (rows.length === 0) throw new DocumentServiceError("NOT_FOUND", "영구 삭제할 문서를 찾을 수 없습니다.");
    const now = new Date().toISOString();
    const insertTombstone = database.prepare(
      `INSERT INTO document_purge_tombstones
       (id, workspace_id, document_id, trash_batch_id, title_snapshot, slug_snapshot,
        purged_at, purged_by_type, purged_by_user_id, purged_by_agent_id, purged_by_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insertTombstone.run(
        randomUUID(),
        workspaceId,
        row.id,
        batch.id,
        row.title,
        row.slug,
        now,
        actor.type,
        actor.type === "human" ? actor.userId : null,
        actor.type === "agent" ? actor.principalId ?? null : null,
        actor.label,
      );
    }
    recordWorkspaceAuditEvent(database, {
      workspaceId,
      action: "document_trash.purged",
      actorType: actor.type,
      actorUserId: actor.type === "human" ? actor.userId : null,
      actorAgentId: actor.type === "agent" ? actor.principalId ?? null : null,
      actorLabel: actor.label,
      targetType: "document_tree",
      targetId: rootDocumentId,
      metadata: { trashBatchId: batch.id, documentIds: rows.map((row) => row.id) },
      createdAt: now,
    });
    database.prepare(
      `DELETE FROM documents
       WHERE workspace_id = ? AND trash_batch_id = ? AND lifecycle_state = 'trashed'`,
    ).run(workspaceId, batch.id);
    database.prepare("DELETE FROM document_trash_batches WHERE id = ? AND workspace_id = ?")
      .run(batch.id, workspaceId);
    return {
      rootDocumentId,
      documentIds: rows.map((row) => row.id),
      documentCount: rows.length,
    };
  }).immediate();
}

export function purgeExpiredTrash(
  database: NyxDatabase,
  actor: DocumentActor,
  now = new Date().toISOString(),
) {
  const roots = database.prepare(
    `SELECT b.workspace_id, b.root_document_id
     FROM document_trash_batches b
     JOIN workspaces w ON w.id = b.workspace_id
     WHERE w.trash_auto_purge = 1 AND b.purge_after <= ?
     ORDER BY b.purge_after ASC, b.id ASC`,
  ).all(now) as Array<{ workspace_id: string; root_document_id: string }>;
  return database.transaction(() => roots.map((root) => purgeTrashedDocument(
    database,
    root.workspace_id,
    actor,
    root.root_document_id,
  )))();
}

type EventRow = {
  cursor: number;
  id: string;
  document_id: string;
  document_title: string;
  revision_id: string;
  revision_number: number;
  event_type: DocumentEvent["eventType"];
  actor_type: DocumentEvent["actorType"];
  actor_label: string;
  actor_principal_id: string | null;
  actor_avatar_media_id: string | null;
  source: string;
  summary: string;
  created_at: string;
};

function mapEvent(row: EventRow): DocumentEvent {
  return {
    cursor: Number(row.cursor),
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    revisionId: row.revision_id,
    revisionNumber: Number(row.revision_number),
    eventType: row.event_type,
    actorType: row.actor_type,
    actorLabel: row.actor_label,
    actorPrincipalId: row.actor_principal_id,
    actorAvatarMediaId: row.actor_avatar_media_id,
    source: row.source,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

const eventSelect = `
  SELECT e.cursor, e.id, e.document_id, d.title AS document_title, e.revision_id,
         r.revision_number, e.event_type, e.actor_type, e.actor_label,
         e.actor_principal_id, e.actor_avatar_media_id,
         e.source, e.summary, e.created_at
  FROM document_events e
  JOIN documents d ON d.id = e.document_id
  JOIN document_revisions r ON r.id = e.revision_id`;

export function getChanges(
  database: NyxDatabase,
  workspaceId: string,
  sinceCursor = 0,
  requestedLimit = 50,
) {
  const requestedSince = Number.isInteger(sinceCursor) && sinceCursor >= 0 ? sinceCursor : 0;
  const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit) || 50));
  const latest = database
    .prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM document_events WHERE workspace_id = ?")
    .get(workspaceId) as { cursor: number };
  const headCursor = Number(latest.cursor);
  const since = Math.min(requestedSince, headCursor);
  const rows = database
    .prepare(
      `${eventSelect}
       WHERE e.workspace_id = ? AND e.cursor > ?
       ORDER BY e.cursor ASC
       LIMIT ?`,
    )
    .all(workspaceId, since, limit + 1) as EventRow[];
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(mapEvent);
  const nextCursor = events.length > 0 ? events[events.length - 1].cursor : headCursor;
  return {
    events,
    nextCursor,
    hasMore,
    headCursor,
    cursorClamped: requestedSince > headCursor,
  };
}

export function listRecentEvents(database: NyxDatabase, workspaceId: string, requestedLimit = 20) {
  const limit = Math.max(1, Math.min(50, Math.trunc(requestedLimit) || 20));
  const rows = database
    .prepare(
      `${eventSelect}
       WHERE e.workspace_id = ?
       ORDER BY e.cursor DESC
       LIMIT ?`,
    )
    .all(workspaceId, limit) as EventRow[];
  return rows.map(mapEvent);
}

export function listDocumentRevisions(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  requestedLimit = 20,
  beforeRevision?: number,
): DocumentRevision[] {
  const document = loadDocumentRow(database, workspaceId, documentId);
  if (!document) throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
  const limit = Math.max(1, Math.min(50, Math.trunc(requestedLimit) || 20));
  const rows = database
    .prepare(
      `SELECT id, revision_number, summary, actor_type, actor_label,
              actor_principal_id, actor_avatar_media_id, source, created_at
       FROM document_revisions
       WHERE document_id = ? AND (? IS NULL OR revision_number < ?)
       ORDER BY revision_number DESC LIMIT ?`,
    )
    .all(documentId, beforeRevision ?? null, beforeRevision ?? null, limit) as Array<{
    id: string;
    revision_number: number;
    summary: string;
    actor_type: DocumentRevision["actorType"];
    actor_label: string;
    actor_principal_id: string | null;
    actor_avatar_media_id: string | null;
    source: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    number: Number(row.revision_number),
    summary: row.summary,
    actorType: row.actor_type,
    actorLabel: row.actor_label,
    actorPrincipalId: row.actor_principal_id,
    actorAvatarMediaId: row.actor_avatar_media_id,
    source: row.source,
    createdAt: row.created_at,
  }));
}

function parseRevisionSnapshot(snapshotJson: string) {
  try {
    const parsed = JSON.parse(snapshotJson) as unknown;
    return parseNyxdocDocumentV2(parsed);
  } catch {
    throw new DocumentServiceError("INVALID_INPUT", "이 리비전의 본문 스냅샷을 읽을 수 없습니다.");
  }
}

function parseRevisionDocumentMetadata(value: string, fallback: DocumentMetadata): DocumentMetadata {
  try {
    const parsed = JSON.parse(value) as Partial<DocumentMetadata>;
    const workflowStatus = parsed.workflowStatus;
    return {
      documentType: typeof parsed.documentType === "string" ? parsed.documentType : null,
      workflowStatus:
        workflowStatus === "draft" || workflowStatus === "review" || workflowStatus === "final"
          ? workflowStatus
          : fallback.workflowStatus,
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === "string")
        : fallback.tags,
    };
  } catch {
    return fallback;
  }
}

export function getDocumentRevisionSnapshot(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  revisionId: string,
): DocumentRevisionSnapshot {
  const document = loadDocumentRow(database, workspaceId, documentId);
  if (!document) throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");

  const row = database
    .prepare(
      `SELECT id, revision_number, snapshot_json, summary, actor_type, actor_label,
              actor_principal_id, actor_avatar_media_id, source, created_at,
              title_snapshot, parent_document_id_snapshot, document_metadata_json
       FROM document_revisions
       WHERE document_id = ? AND id = ?`,
    )
    .get(documentId, revisionId) as {
    id: string;
    revision_number: number;
    snapshot_json: string;
    summary: string;
    actor_type: DocumentRevision["actorType"];
    actor_label: string;
    actor_principal_id: string | null;
    actor_avatar_media_id: string | null;
    source: string;
    created_at: string;
    title_snapshot: string | null;
    parent_document_id_snapshot: string | null;
    document_metadata_json: string;
  } | undefined;
  if (!row) throw new DocumentServiceError("NOT_FOUND", "리비전을 찾을 수 없습니다.");

  return {
    id: row.id,
    number: Number(row.revision_number),
    summary: row.summary,
    actorType: row.actor_type,
    actorLabel: row.actor_label,
    actorPrincipalId: row.actor_principal_id,
    actorAvatarMediaId: row.actor_avatar_media_id,
    source: row.source,
    createdAt: row.created_at,
    title: row.title_snapshot ?? document.title,
    parentDocumentId: row.title_snapshot === null
      ? document.parent_document_id
      : row.parent_document_id_snapshot,
    metadata: parseRevisionDocumentMetadata(row.document_metadata_json, documentMetadata(document)),
    content: parseRevisionSnapshot(row.snapshot_json),
  };
}

export function getDocumentRevisionSnapshotByNumber(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  revisionNumber: number,
): DocumentRevisionSnapshot {
  const document = loadDocumentRow(database, workspaceId, documentId);
  if (!document) throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
  const row = database
    .prepare(
      `SELECT id, revision_number, snapshot_json, summary, actor_type, actor_label,
              actor_principal_id, actor_avatar_media_id, source, created_at,
              title_snapshot, parent_document_id_snapshot, document_metadata_json
       FROM document_revisions
       WHERE document_id = ? AND revision_number = ?`,
    )
    .get(documentId, revisionNumber) as {
    id: string;
    revision_number: number;
    snapshot_json: string;
    summary: string;
    actor_type: DocumentRevision["actorType"];
    actor_label: string;
    actor_principal_id: string | null;
    actor_avatar_media_id: string | null;
    source: string;
    created_at: string;
    title_snapshot: string | null;
    parent_document_id_snapshot: string | null;
    document_metadata_json: string;
  } | undefined;
  if (!row) throw new DocumentServiceError("NOT_FOUND", "리비전을 찾을 수 없습니다.");
  return {
    id: row.id,
    number: Number(row.revision_number),
    summary: row.summary,
    actorType: row.actor_type,
    actorLabel: row.actor_label,
    actorPrincipalId: row.actor_principal_id,
    actorAvatarMediaId: row.actor_avatar_media_id,
    source: row.source,
    createdAt: row.created_at,
    title: row.title_snapshot ?? document.title,
    parentDocumentId: row.title_snapshot === null
      ? document.parent_document_id
      : row.parent_document_id_snapshot,
    metadata: parseRevisionDocumentMetadata(row.document_metadata_json, documentMetadata(document)),
    content: parseRevisionSnapshot(row.snapshot_json),
  };
}

export function diffDocumentRevisions(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  fromRevision: number,
  toRevision?: number,
): DocumentRevisionDiff {
  const document = loadDocumentRow(database, workspaceId, documentId);
  if (!document) throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
  const targetRevision = toRevision ?? document.revision_number;
  if (fromRevision === targetRevision) {
    const revision = getDocumentRevisionSnapshotByNumber(
      database,
      workspaceId,
      documentId,
      fromRevision,
    );
    const documentState = {
      title: revision.title,
      parentDocumentId: revision.parentDocumentId,
      metadata: revision.metadata,
    };
    return {
      documentId,
      fromRevision,
      toRevision: targetRevision,
      document: {
        titleChanged: false,
        parentChanged: false,
        metadataChanged: false,
        before: documentState,
        after: documentState,
      },
      added: [],
      removed: [],
      modified: [],
      moved: [],
    };
  }
  const beforeRevision = getDocumentRevisionSnapshotByNumber(
    database,
    workspaceId,
    documentId,
    fromRevision,
  );
  const afterRevision = getDocumentRevisionSnapshotByNumber(
    database,
    workspaceId,
    documentId,
    targetRevision,
  );
  const before = beforeRevision.content;
  const after = afterRevision.content;
  const changes = topLevelBlockChanges(before, after);
  const beforeIndex = new Map(before.blocks.map((block, index) => [block.id, index]));
  const afterIndex = new Map(after.blocks.map((block, index) => [block.id, index]));
  const beforeById = new Map(before.blocks.map((block) => [block.id, block]));
  const afterById = new Map(after.blocks.map((block) => [block.id, block]));

  return {
    documentId,
    fromRevision,
    toRevision: targetRevision,
    document: {
      titleChanged: beforeRevision.title !== afterRevision.title,
      parentChanged: beforeRevision.parentDocumentId !== afterRevision.parentDocumentId,
      metadataChanged: JSON.stringify(beforeRevision.metadata) !== JSON.stringify(afterRevision.metadata),
      before: {
        title: beforeRevision.title,
        parentDocumentId: beforeRevision.parentDocumentId,
        metadata: beforeRevision.metadata,
      },
      after: {
        title: afterRevision.title,
        parentDocumentId: afterRevision.parentDocumentId,
        metadata: afterRevision.metadata,
      },
    },
    added: changes.addedBlockIds.map((blockId) => ({
      blockId,
      index: afterIndex.get(blockId)!,
      block: afterById.get(blockId)!,
    })),
    removed: changes.removedBlockIds.map((blockId) => ({
      blockId,
      index: beforeIndex.get(blockId)!,
      block: beforeById.get(blockId)!,
    })),
    modified: changes.modifiedBlockIds.map((blockId) => ({
      blockId,
      before: beforeById.get(blockId)!,
      after: afterById.get(blockId)!,
    })),
    moved: changes.movedBlockIds.map((blockId) => ({
      blockId,
      fromIndex: beforeIndex.get(blockId)!,
      toIndex: afterIndex.get(blockId)!,
    })),
  };
}

export function restoreDocumentRevision(
  database: NyxDatabase,
  workspaceId: string,
  actor: DocumentActor,
  documentId: string,
  revisionId: string,
  baseRevision: number,
  requestId?: string,
) {
  const current = loadDocumentRow(database, workspaceId, documentId);
  if (!current) throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");

  const target = database
    .prepare(
      `SELECT id, revision_number, snapshot_json
       FROM document_revisions
       WHERE document_id = ? AND id = ?`,
    )
    .get(documentId, revisionId) as {
    id: string;
    revision_number: number;
    snapshot_json: string;
  } | undefined;
  if (!target) throw new DocumentServiceError("NOT_FOUND", "복원할 리비전을 찾을 수 없습니다.");
  if (target.id === current.current_revision_id) {
    throw new DocumentServiceError("INVALID_INPUT", "현재 리비전은 다시 복원할 필요가 없습니다.");
  }

  const targetRevision = getDocumentRevisionSnapshot(
    database,
    workspaceId,
    documentId,
    revisionId,
  );

  return updateDocument(
    database,
    workspaceId,
    { ...actor, source: "rollback" },
    documentId,
    {
      idempotencyOperation: "restore_revision",
      requestId,
      baseRevision,
      title: targetRevision.title,
      parentDocumentId: targetRevision.parentDocumentId,
      documentType: targetRevision.metadata.documentType,
      workflowStatus: targetRevision.metadata.workflowStatus,
      tags: targetRevision.metadata.tags,
      content: targetRevision.content,
      summary: `${actor.label}가 리비전 ${target.revision_number}의 본문을 복원했습니다.`,
    },
  );
}

export function searchDocuments(
  database: NyxDatabase,
  workspaceId: string,
  query: string,
  requestedLimit = 20,
): DocumentSummary[] {
  const term = query.trim().normalize("NFC").toLocaleLowerCase();
  if (!term) return listDocuments(database, workspaceId).slice(0, requestedLimit);
  const escaped = term.replace(/[\\%_]/g, "\\$&");
  const like = `%${escaped}%`;
  const limit = Math.max(1, Math.min(50, Math.trunc(requestedLimit) || 20));
  const rows = database
    .prepare(
      `SELECT d.id, d.workspace_id, d.title, d.slug, d.status,
              d.parent_document_id, d.tree_order, d.current_revision_id,
              d.content_schema_version, d.document_type, d.workflow_status, d.tags_json,
              COALESCE(r.revision_number, 0) AS revision_number, d.created_at, d.updated_at
       FROM documents d
       LEFT JOIN document_revisions r ON r.id = d.current_revision_id
       WHERE d.workspace_id = ? AND d.status = 'active'
         AND (nyxdoc_search_text(d.title) LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM document_blocks b
           WHERE b.document_id = d.id AND b.deleted_at IS NULL
             AND nyxdoc_search_text(b.content) LIKE ? ESCAPE '\\'
         ))
       ORDER BY d.updated_at DESC
       LIMIT ?`,
    )
    .all(workspaceId, like, like, limit) as DocumentRow[];
  return rows.map(mapSummary);
}

export type SearchDocumentsQuery = {
  limit?: number;
  matchLimit?: number;
  withinDocumentId?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  titleOnly?: boolean;
  documentType?: string;
  workflowStatus?: DocumentWorkflowStatus;
  tag?: string;
};

function searchSnippet(value: string, term: string) {
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  const normalizedTerm = term.normalize("NFC").toLocaleLowerCase();
  const index = normalized.toLocaleLowerCase().indexOf(normalizedTerm);
  if (index < 0 || normalized.length <= 180) return normalized;
  const start = Math.max(0, index - 70);
  const end = Math.min(normalized.length, index + term.length + 90);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

export function searchDocumentContents(
  database: NyxDatabase,
  workspaceId: string,
  query: string,
  options: SearchDocumentsQuery = {},
): DocumentSearchResult[] {
  const term = query.trim().normalize("NFC").toLocaleLowerCase();
  if (!term) return [];
  const escaped = term.replace(/[\\%_]/g, "\\$&");
  const like = `%${escaped}%`;
  const candidateLimit = 500;
  const rows = database
    .prepare(
      `SELECT d.id, d.workspace_id, d.title, d.slug, d.status,
              d.parent_document_id, d.tree_order, d.current_revision_id,
              d.content_schema_version, d.document_type, d.workflow_status, d.tags_json,
              COALESCE(r.revision_number, 0) AS revision_number, d.created_at, d.updated_at
       FROM documents d
       LEFT JOIN document_revisions r ON r.id = d.current_revision_id
       WHERE d.workspace_id = ? AND d.status = 'active'
         AND (nyxdoc_search_text(d.title) LIKE ? ESCAPE '\\' OR (? = 0 AND EXISTS (
           SELECT 1 FROM document_blocks b
           WHERE b.document_id = d.id AND b.deleted_at IS NULL
             AND nyxdoc_search_text(b.content) LIKE ? ESCAPE '\\'
         )))
       ORDER BY d.updated_at DESC, d.id ASC
       LIMIT ?`,
    )
    .all(workspaceId, like, options.titleOnly ? 1 : 0, like, candidateLimit) as DocumentRow[];
  const all = listDocuments(database, workspaceId);
  const byId = new Map(all.map((document) => [document.id, document]));
  if (options.withinDocumentId && !byId.has(options.withinDocumentId)) {
    throw new DocumentServiceError("NOT_FOUND", "검색 범위의 문서를 찾을 수 없습니다.");
  }
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 20)));
  const matchLimit = Math.max(1, Math.min(10, Math.trunc(options.matchLimit ?? 5)));
  const results: DocumentSearchResult[] = [];
  const normalizeSearch = (value: string) => value.normalize("NFC").toLocaleLowerCase();
  const documentType = options.documentType ? normalizeSearch(options.documentType.trim()) : undefined;
  const tag = options.tag ? normalizeSearch(options.tag.trim()) : undefined;

  for (const row of rows) {
    const summary = mapSummary(row);
    const path = documentPath(summary, byId);
    if (options.withinDocumentId && !path.some((item) => item.id === options.withinDocumentId)) continue;
    if (options.updatedAfter && summary.updatedAt <= options.updatedAfter) continue;
    if (options.updatedBefore && summary.updatedAt >= options.updatedBefore) continue;
    if (documentType && (!summary.documentType || normalizeSearch(summary.documentType) !== documentType)) continue;
    if (options.workflowStatus && summary.workflowStatus !== options.workflowStatus) continue;
    if (tag && !summary.tags.some((value) => normalizeSearch(value) === tag)) continue;

    const matches: DocumentSearchResult["matches"] = [];
    if (normalizeSearch(summary.title).includes(term)) {
      matches.push({ kind: "title", blockId: null, nodeType: null, snippet: summary.title });
    }
    if (!options.titleOnly && matches.length < matchLimit) {
      const blockRows = database
        .prepare(
          `SELECT id, content, content_json
           FROM document_blocks
           WHERE document_id = ? AND deleted_at IS NULL
             AND nyxdoc_search_text(content) LIKE ? ESCAPE '\\'
           ORDER BY sort_order ASC
           LIMIT ?`,
        )
        .all(summary.id, like, matchLimit - matches.length) as Array<{
          id: string;
          content: string;
          content_json: string | null;
        }>;
      matches.push(...blockRows.map((block) => ({
        kind: "body" as const,
        blockId: block.id,
        nodeType: canonicalStoredNodeType(block.content_json),
        snippet: searchSnippet(block.content, term),
      })));
    }
    if (matches.length === 0) continue;
    results.push({
      documentId: summary.id,
      title: summary.title,
      parentDocumentId: summary.parentDocumentId,
      path,
      revisionNumber: summary.revisionNumber,
      documentType: summary.documentType,
      workflowStatus: summary.workflowStatus,
      tags: summary.tags,
      updatedAt: summary.updatedAt,
      matches,
    });
    if (results.length >= limit) break;
  }
  return results;
}
