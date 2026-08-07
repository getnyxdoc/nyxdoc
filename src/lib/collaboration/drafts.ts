import { createHash, randomUUID } from "node:crypto";
import { slateNodesToInsertDelta, yTextToSlateElement } from "@slate-yjs/core";
import * as Y from "yjs";
import type { NyxDatabase } from "@/lib/db/client";
import { getDocument } from "@/lib/documents/service";
import type {
  DocumentActor,
  DocumentDetail,
  DocumentDraftCas,
  DocumentMetadata,
  DocumentRevisionSnapshot,
} from "@/lib/documents/types";
import { DocumentServiceError } from "@/lib/documents/types";
import {
  NYXDOC_CONTENT_SCHEMA_VERSION,
  stripNyxdocEditorRuntimeFields,
  nyxdocDocumentV2Schema,
  type NyxdocDocumentV2,
} from "@/lib/editor/schema";
import {
  repairDocumentNodeIds,
  type DocumentNodeIdRepair,
} from "@/lib/editor/node-ids";

const ROOM_PATTERN = /^nyxdoc:([0-9a-f-]{36}):([0-9a-f-]{36}):g([1-9][0-9]*)$/i;
const CONTENT_SHARED_TYPE = "content";
const METADATA_SHARED_TYPE = "metadata";

export type DraftActor = {
  type: "human" | "agent" | "system";
  userId?: string | null;
  tokenId?: string | null;
  principalId?: string | null;
  label: string;
  avatarMediaId?: string | null;
  source: "web" | "mcp" | "api" | "rollback" | "migration" | "seed";
};

export type CollaborationState = {
  documentId: string;
  workspaceId: string;
  generation: number;
  roomName: string;
  state: Uint8Array;
  committedState: Uint8Array;
  baseRevisionId: string | null;
  baseRevisionNumber: number;
  draftVersion: number;
  committedDraftVersion: number;
  hasUncommittedChanges: boolean;
  updatedAt: string;
  committedAt: string | null;
};

export type WorkingDocument = {
  documentId: string;
  workspaceId: string;
  generation: number;
  roomName: string;
  baseRevisionId: string | null;
  baseRevisionNumber: number;
  draftVersion: number;
  committedDraftVersion: number;
  hasUncommittedChanges: boolean;
  title: string;
  parentDocumentId: string | null;
  metadata: DocumentMetadata;
  content: NyxdocDocumentV2;
};

type CollaborationStateRow = {
  document_id: string;
  workspace_id: string;
  generation: number;
  yjs_state: Buffer;
  committed_yjs_state: Buffer;
  base_revision_id: string | null;
  base_revision_number: number;
  draft_version: number;
  committed_draft_version: number;
  updated_at: string;
  committed_at: string | null;
};

export function collaborationRoomName(
  workspaceId: string,
  documentId: string,
  generation: number,
) {
  return `nyxdoc:${workspaceId}:${documentId}:g${generation}`;
}

export function parseCollaborationRoomName(roomName: string) {
  const match = ROOM_PATTERN.exec(roomName);
  if (!match) throw new DocumentServiceError("INVALID_INPUT", "올바르지 않은 Nyxdoc 협업 문서 이름입니다.");
  return {
    workspaceId: match[1].toLowerCase(),
    documentId: match[2].toLowerCase(),
    generation: Number(match[3]),
  };
}

function metadataFromDocument(document: Pick<
  DocumentDetail,
  "title" | "parentDocumentId" | "documentType" | "workflowStatus" | "tags"
>) {
  return {
    title: document.title,
    parentDocumentId: document.parentDocumentId,
    documentType: document.documentType,
    workflowStatus: document.workflowStatus,
    tags: document.tags,
  };
}

export function createCollaborationYDoc(input: {
  title: string;
  parentDocumentId: string | null;
  documentType: string | null;
  workflowStatus: DocumentMetadata["workflowStatus"];
  tags: string[];
  content: NyxdocDocumentV2;
}) {
  const ydoc = new Y.Doc();
  const content = ydoc.get(CONTENT_SHARED_TYPE, Y.XmlText);
  const metadata = ydoc.getMap<unknown>(METADATA_SHARED_TYPE);
  const editableBlocks = structuredClone(input.content.blocks);
  const lastBlock = editableBlocks.at(-1);
  if (!lastBlock || lastBlock.type !== "p") {
    editableBlocks.push({
      id: randomUUID(),
      type: "p",
      children: [{ text: "" }],
    });
  }
  ydoc.transact(() => {
    content.applyDelta(slateNodesToInsertDelta(editableBlocks as never));
    metadata.set("title", input.title);
    metadata.set("parentDocumentId", input.parentDocumentId);
    metadata.set("documentType", input.documentType);
    metadata.set("workflowStatus", input.workflowStatus);
    metadata.set("tags", [...input.tags]);
  }, "nyxdoc-seed");
  return ydoc;
}

export function collaborationYDocFromState(state: Uint8Array) {
  const ydoc = new Y.Doc();
  if (state.byteLength > 0) Y.applyUpdate(ydoc, state, "nyxdoc-load");
  return ydoc;
}

function repairedNodeId(input: {
  attempt: number;
  path: readonly number[];
  previousId: string | null;
  reason: DocumentNodeIdRepair["reason"];
}) {
  const digest = createHash("sha256")
    .update(`${input.reason}\u0000${input.previousId ?? "<missing>"}\u0000${input.path.join(".")}\u0000${input.attempt}`)
    .digest("hex");
  return `nyxdoc-repair-${digest}`;
}

export function repairCollaborationYDocNodeIds(ydoc: Y.Doc): DocumentNodeIdRepair[] {
  const sharedContent = ydoc.get(CONTENT_SHARED_TYPE, Y.XmlText);
  const slateRoot = yTextToSlateElement(sharedContent) as unknown as { children?: unknown };
  if (!Array.isArray(slateRoot.children)) return [];

  const repaired = repairDocumentNodeIds(slateRoot.children, repairedNodeId);
  if (repaired.repairs.length === 0) return [];

  ydoc.transact(() => {
    sharedContent.delete(0, sharedContent.length);
    sharedContent.applyDelta(slateNodesToInsertDelta(repaired.value as never));
  }, "nyxdoc-repair-document-node-ids");
  return repaired.repairs;
}

function readCollaborationSnapshotFromYDoc(ydoc: Y.Doc) {
  const repairs = repairCollaborationYDocNodeIds(ydoc);
  const sharedContent = ydoc.get(CONTENT_SHARED_TYPE, Y.XmlText);
  const slateRoot = yTextToSlateElement(sharedContent) as unknown as { children?: unknown };
  const metadata = ydoc.getMap<unknown>(METADATA_SHARED_TYPE);
  return {
    snapshot: {
      title: metadata.get("title"),
      parentDocumentId: metadata.get("parentDocumentId"),
      documentType: metadata.get("documentType"),
      workflowStatus: metadata.get("workflowStatus"),
      tags: metadata.get("tags"),
      blocks: stripNyxdocEditorRuntimeFields(slateRoot.children),
    },
    repairs,
  };
}

function readCollaborationDocumentFromYDoc(ydoc: Y.Doc) {
  const read = readCollaborationSnapshotFromYDoc(ydoc);
  const parsedContent = nyxdocDocumentV2Schema.safeParse({
    schemaVersion: NYXDOC_CONTENT_SCHEMA_VERSION,
    blocks: read.snapshot.blocks,
  });
  if (!parsedContent.success) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안의 문서 본문이 올바르지 않습니다.",
      {
        issues: parsedContent.error.issues.slice(0, 20).map((issue) => ({
          code: issue.code,
          path: issue.path.map(String),
          message: issue.message,
        })),
      },
    );
  }
  const content: NyxdocDocumentV2 = parsedContent.data;
  const {
    title,
    parentDocumentId,
    documentType,
    workflowStatus,
    tags,
  } = read.snapshot;
  if (typeof title !== "string" || !title.trim()) {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안의 문서 제목이 비어 있습니다.");
  }
  if (parentDocumentId !== null && typeof parentDocumentId !== "string") {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안의 문서 위치가 올바르지 않습니다.");
  }
  if (documentType !== null && typeof documentType !== "string") {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안의 문서 유형이 올바르지 않습니다.");
  }
  if (workflowStatus !== "draft" && workflowStatus !== "review" && workflowStatus !== "final") {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안의 워크플로 상태가 올바르지 않습니다.");
  }
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안의 태그가 올바르지 않습니다.");
  }
  return {
    document: {
      title: title.trim(),
      parentDocumentId: parentDocumentId as string | null,
      metadata: {
        documentType: documentType as string | null,
        workflowStatus,
        tags: tags as string[],
      } satisfies DocumentMetadata,
      content,
    },
    repairs: read.repairs,
  };
}

export function collaborationDocumentFromYDoc(ydoc: Y.Doc) {
  // A read must never mutate the live shared document. Legacy drafts may still
  // need deterministic node-ID repair, so perform that normalization on an
  // isolated projection instead of the caller's Y.Doc.
  const projection = collaborationYDocFromState(Y.encodeStateAsUpdate(ydoc));
  return readCollaborationDocumentFromYDoc(projection).document;
}

function mapCollaborationState(row: CollaborationStateRow): CollaborationState {
  const draftVersion = Number(row.draft_version);
  const committedDraftVersion = Number(row.committed_draft_version);
  const generation = Number(row.generation);
  const storedState = new Uint8Array(row.yjs_state);
  const storedCommittedState = new Uint8Array(row.committed_yjs_state);
  const workingYDoc = collaborationYDocFromState(storedState);
  const committedYDoc = collaborationYDocFromState(storedCommittedState);
  const working = readCollaborationSnapshotFromYDoc(workingYDoc);
  const committed = readCollaborationSnapshotFromYDoc(committedYDoc);
  const state = working.repairs.length > 0
    ? Y.encodeStateAsUpdate(workingYDoc)
    : storedState;
  const committedState = committed.repairs.length > 0
    ? Y.encodeStateAsUpdate(committedYDoc)
    : storedCommittedState;
  return {
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    generation,
    roomName: collaborationRoomName(row.workspace_id, row.document_id, generation),
    state,
    committedState,
    baseRevisionId: row.base_revision_id,
    baseRevisionNumber: Number(row.base_revision_number),
    draftVersion,
    committedDraftVersion,
    // Yjs updates retain tombstones and operation history, so two byte streams
    // can differ even after the user undoes back to the exact committed
    // document. Dirty state is a document-level concept and must compare the
    // visible draft snapshot instead of CRDT history bytes. The snapshot may
    // contain a short-lived editor node until the user finishes a command.
    hasUncommittedChanges:
      JSON.stringify(working.snapshot) !== JSON.stringify(committed.snapshot),
    updatedAt: row.updated_at,
    committedAt: row.committed_at,
  };
}

function collaborationStateRow(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  return database.prepare(
    `SELECT document_id, workspace_id, generation, yjs_state, committed_yjs_state, base_revision_id,
            base_revision_number, draft_version, committed_draft_version,
            updated_at, committed_at
     FROM document_collaboration_states
     WHERE workspace_id = ? AND document_id = ?`,
  ).get(workspaceId, documentId) as CollaborationStateRow | undefined;
}

function requireActiveCollaborationDocument(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  const activeWorkspace = database.prepare(
    "SELECT 1 FROM workspaces WHERE id = ? AND lifecycle_state = 'active'",
  ).get(workspaceId);
  if (!activeWorkspace) {
    throw new DocumentServiceError("FORBIDDEN", "휴지통에 있는 워크스페이스의 공유 초안은 변경할 수 없습니다.");
  }
  const activeDocument = database.prepare(
    `SELECT 1 FROM documents
     WHERE workspace_id = ? AND id = ?
       AND status = 'active' AND lifecycle_state = 'active'`,
  ).get(workspaceId, documentId);
  if (!activeDocument) {
    throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
  }
}

export function ensureCollaborationState(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
): CollaborationState {
  requireActiveCollaborationDocument(database, workspaceId, documentId);
  const existing = collaborationStateRow(database, workspaceId, documentId);
  if (existing) return mapCollaborationState(existing);

  const document = getDocument(database, workspaceId, documentId);
  const ydoc = createCollaborationYDoc({
    ...metadataFromDocument(document),
    content: document.content,
  });
  const now = new Date().toISOString();
  const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  database.prepare(
    `INSERT INTO document_collaboration_states
     (document_id, workspace_id, generation, yjs_state, committed_yjs_state, base_revision_id,
      base_revision_number, draft_version, committed_draft_version,
      seeded_at, updated_at, committed_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0, 0, ?, ?, ?)
     ON CONFLICT(document_id) DO NOTHING`,
  ).run(
    documentId,
    workspaceId,
    state,
    state,
    document.revisionId,
    document.revisionNumber,
    now,
    now,
    now,
  );
  const inserted = collaborationStateRow(database, workspaceId, documentId);
  if (!inserted) throw new DocumentServiceError("COLLABORATION_UNAVAILABLE", "문서의 공유 초안을 초기화하지 못했습니다.");
  return mapCollaborationState(inserted);
}

export function loadCollaborationStateByRoom(
  database: NyxDatabase,
  roomName: string,
): CollaborationState {
  const room = parseCollaborationRoomName(roomName);
  const state = ensureCollaborationState(database, room.workspaceId, room.documentId);
  if (state.generation !== room.generation) {
    throw new DocumentServiceError("DRAFT_CONFLICT", "이 공유 초안 세대는 더 이상 유효하지 않습니다.");
  }
  return state;
}

export function persistCollaborationYDoc(
  database: NyxDatabase,
  roomName: string,
  ydoc: Y.Doc,
) {
  const room = parseCollaborationRoomName(roomName);
  requireActiveCollaborationDocument(database, room.workspaceId, room.documentId);
  repairCollaborationYDocNodeIds(ydoc);
  const encoded = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  const current = database.prepare(
    `SELECT yjs_state FROM document_collaboration_states
     WHERE workspace_id = ? AND document_id = ? AND generation = ?`,
  ).get(room.workspaceId, room.documentId, room.generation) as { yjs_state: Buffer } | undefined;
  if (!current) {
    throw new DocumentServiceError("DRAFT_CONFLICT", "공유 초안이 교체되어 현재 변경을 저장하지 못했습니다.");
  }

  // Opening a legacy draft can normalize missing or duplicate IDs in memory.
  // That internal normalization is not a user edit and must not advance the
  // optimistic concurrency token returned to agents. Compare the visible
  // normalized snapshots before deciding whether anything needs persistence.
  const currentYDoc = collaborationYDocFromState(new Uint8Array(current.yjs_state));
  const currentSnapshot = readCollaborationSnapshotFromYDoc(currentYDoc).snapshot;
  const nextSnapshot = readCollaborationSnapshotFromYDoc(ydoc).snapshot;
  if (JSON.stringify(currentSnapshot) === JSON.stringify(nextSnapshot)) return;

  const result = database.prepare(
    `UPDATE document_collaboration_states
     SET draft_version = draft_version + CASE WHEN yjs_state = ? THEN 0 ELSE 1 END,
          yjs_state = ?, updated_at = ?
     WHERE workspace_id = ? AND document_id = ? AND generation = ? AND yjs_state = ?`,
  ).run(
    encoded,
    encoded,
    new Date().toISOString(),
    room.workspaceId,
    room.documentId,
    room.generation,
    current.yjs_state,
  );
  if (result.changes !== 1) throw new DocumentServiceError("DRAFT_CONFLICT", "공유 초안이 교체되어 현재 변경을 저장하지 못했습니다.");
}

function contributorKey(actor: DraftActor) {
  return `${actor.type}:${actor.principalId?.trim() || actor.userId?.trim() || actor.label.trim()}`;
}

export function recordCollaborationUpdate(
  database: NyxDatabase,
  roomName: string,
  actor: DraftActor,
) {
  const room = parseCollaborationRoomName(roomName);
  requireActiveCollaborationDocument(database, room.workspaceId, room.documentId);
  const now = new Date().toISOString();
  database.transaction(() => {
    const update = database.prepare(
      `UPDATE document_collaboration_states
       SET draft_version = draft_version + 1, updated_at = ?,
           last_actor_type = ?, last_actor_principal_id = ?, last_actor_label = ?,
           last_actor_avatar_media_id = ?
       WHERE workspace_id = ? AND document_id = ? AND generation = ?`,
    ).run(
      now,
      actor.type,
      actor.principalId ?? actor.userId ?? null,
      actor.label,
      actor.avatarMediaId ?? null,
      room.workspaceId,
      room.documentId,
      room.generation,
    );
    if (update.changes !== 1) throw new DocumentServiceError("DRAFT_CONFLICT", "공유 초안이 교체되어 변경 기록을 남기지 못했습니다.");
    database.prepare(
      `INSERT INTO document_draft_contributors
       (document_id, generation, contributor_key, actor_type, actor_principal_id,
        actor_label, actor_avatar_media_id, first_edit_at, last_edit_at, update_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(document_id, generation, contributor_key) DO UPDATE SET
         actor_label = excluded.actor_label,
         actor_avatar_media_id = excluded.actor_avatar_media_id,
         last_edit_at = excluded.last_edit_at,
         update_count = document_draft_contributors.update_count + 1`,
    ).run(
      room.documentId,
      room.generation,
      contributorKey(actor),
      actor.type,
      actor.principalId ?? actor.userId ?? null,
      actor.label,
      actor.avatarMediaId ?? null,
      now,
      now,
    );
  })();
}

export function persistCollaborationUpdate(
  database: NyxDatabase,
  roomName: string,
  ydoc: Y.Doc,
  actor: DraftActor,
) {
  const room = parseCollaborationRoomName(roomName);
  requireActiveCollaborationDocument(database, room.workspaceId, room.documentId);
  const now = new Date().toISOString();
  repairCollaborationYDocNodeIds(ydoc);
  const encoded = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  database.transaction(() => {
    const current = database.prepare(
      `SELECT yjs_state FROM document_collaboration_states
       WHERE workspace_id = ? AND document_id = ? AND generation = ?`,
    ).get(room.workspaceId, room.documentId, room.generation) as { yjs_state: Buffer } | undefined;
    if (!current) {
      throw new DocumentServiceError("DRAFT_CONFLICT", "공유 초안이 교체되어 변경을 저장하지 못했습니다.");
    }
    if (current.yjs_state.equals(encoded)) return;
    const update = database.prepare(
      `UPDATE document_collaboration_states
       SET yjs_state = ?, draft_version = draft_version + 1, updated_at = ?,
           last_actor_type = ?, last_actor_principal_id = ?, last_actor_label = ?,
           last_actor_avatar_media_id = ?
       WHERE workspace_id = ? AND document_id = ? AND generation = ?`,
    ).run(
      encoded,
      now,
      actor.type,
      actor.principalId ?? actor.userId ?? null,
      actor.label,
      actor.avatarMediaId ?? null,
      room.workspaceId,
      room.documentId,
      room.generation,
    );
    if (update.changes !== 1) throw new DocumentServiceError("DRAFT_CONFLICT", "공유 초안이 교체되어 변경을 저장하지 못했습니다.");
    database.prepare(
      `INSERT INTO document_draft_contributors
       (document_id, generation, contributor_key, actor_type, actor_principal_id,
        actor_label, actor_avatar_media_id, first_edit_at, last_edit_at, update_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(document_id, generation, contributor_key) DO UPDATE SET
         actor_label = excluded.actor_label,
         actor_avatar_media_id = excluded.actor_avatar_media_id,
         last_edit_at = excluded.last_edit_at,
         update_count = document_draft_contributors.update_count + 1`,
    ).run(
      room.documentId,
      room.generation,
      contributorKey(actor),
      actor.type,
      actor.principalId ?? actor.userId ?? null,
      actor.label,
      actor.avatarMediaId ?? null,
      now,
      now,
    );
  })();
  return loadCollaborationStateByRoom(database, roomName);
}

/**
 * Advances a shared draft onto a canonical metadata-only revision without
 * committing the draft body. The visible working snapshot is supplied by the
 * caller with the same metadata change already applied, while the committed
 * snapshot is rebuilt from the new canonical revision. Draft contributors and
 * committedDraftVersion deliberately remain unchanged because their body edits
 * are still pending an explicit save.
 */
export function rebaseCollaborationStateAfterCanonicalMetadataCommit(
  database: NyxDatabase,
  roomName: string,
  workingYDoc: Y.Doc,
  canonical: DocumentDetail,
  actor: DraftActor,
  cas: DocumentDraftCas,
) {
  const room = parseCollaborationRoomName(roomName);
  requireActiveCollaborationDocument(database, room.workspaceId, room.documentId);
  if (
    canonical.id !== room.documentId
    || canonical.workspaceId !== room.workspaceId
  ) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안과 정본 문서가 일치하지 않습니다.",
    );
  }

  repairCollaborationYDocNodeIds(workingYDoc);
  const working = collaborationDocumentFromYDoc(workingYDoc);
  if (working.parentDocumentId !== canonical.parentDocumentId) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안과 정본의 이동 위치가 일치하지 않습니다.",
    );
  }
  const workingState = Buffer.from(Y.encodeStateAsUpdate(workingYDoc));
  const committedState = Buffer.from(Y.encodeStateAsUpdate(createCollaborationYDoc({
    ...metadataFromDocument(canonical),
    content: canonical.content,
  })));
  const current = collaborationStateRow(database, room.workspaceId, room.documentId);
  if (
    !current
    || Number(current.generation) !== cas.expectedGeneration
    || Number(current.draft_version) !== cas.expectedDraftVersion
    || Number(current.base_revision_number) !== cas.expectedBaseRevision
  ) {
    throw new DocumentServiceError(
      "DRAFT_VERSION_CONFLICT",
      "공유 초안이 이미 변경되거나 다른 세대로 교체되었습니다. 최신 작업본을 다시 읽어주세요.",
      {
        expectedGeneration: cas.expectedGeneration,
        currentGeneration: current ? Number(current.generation) : null,
        expectedDraftVersion: cas.expectedDraftVersion,
        currentDraftVersion: current ? Number(current.draft_version) : null,
        expectedBaseRevision: cas.expectedBaseRevision,
        currentBaseRevision: current ? Number(current.base_revision_number) : null,
      },
    );
  }

  const now = new Date().toISOString();
  const nextDraftVersion = Number(current.draft_version)
    + (current.yjs_state.equals(workingState) ? 0 : 1);
  const updated = database.prepare(
    `UPDATE document_collaboration_states
     SET yjs_state = ?, committed_yjs_state = ?,
         base_revision_id = ?, base_revision_number = ?,
         draft_version = ?, updated_at = ?, committed_at = ?,
         last_actor_type = ?, last_actor_principal_id = ?, last_actor_label = ?,
         last_actor_avatar_media_id = ?
     WHERE workspace_id = ? AND document_id = ? AND generation = ?
       AND draft_version = ? AND base_revision_number = ?`,
  ).run(
    workingState,
    committedState,
    canonical.revisionId,
    canonical.revisionNumber,
    nextDraftVersion,
    now,
    now,
    actor.type,
    actor.principalId ?? actor.userId ?? null,
    actor.label,
    actor.avatarMediaId ?? null,
    room.workspaceId,
    room.documentId,
    cas.expectedGeneration,
    cas.expectedDraftVersion,
    cas.expectedBaseRevision,
  );
  if (updated.changes !== 1) {
    throw new DocumentServiceError(
      "DRAFT_VERSION_CONFLICT",
      "공유 초안이 이미 변경되거나 다른 세대로 교체되었습니다. 최신 작업본을 다시 읽어주세요.",
    );
  }
  return loadCollaborationStateByRoom(database, roomName);
}

export function workingDocumentFromYDoc(
  database: NyxDatabase,
  roomName: string,
  ydoc: Y.Doc,
): WorkingDocument {
  const state = loadCollaborationStateByRoom(database, roomName);
  return {
    documentId: state.documentId,
    workspaceId: state.workspaceId,
    generation: state.generation,
    roomName: state.roomName,
    baseRevisionId: state.baseRevisionId,
    baseRevisionNumber: state.baseRevisionNumber,
    draftVersion: state.draftVersion,
    committedDraftVersion: state.committedDraftVersion,
    hasUncommittedChanges: state.hasUncommittedChanges,
    ...collaborationDocumentFromYDoc(ydoc),
  };
}

export function workingDocumentFromStoredState(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  const state = ensureCollaborationState(database, workspaceId, documentId);
  return workingDocumentFromYDoc(database, state.roomName, collaborationYDocFromState(state.state));
}

export function replaceWorkingDocument(
  ydoc: Y.Doc,
  input: {
    title?: string;
    parentDocumentId?: string | null;
    documentType?: string | null;
    workflowStatus?: DocumentMetadata["workflowStatus"];
    tags?: string[];
    content?: NyxdocDocumentV2;
  },
  origin: unknown,
) {
  ydoc.transact(() => {
    if (input.content) {
      const shared = ydoc.get(CONTENT_SHARED_TYPE, Y.XmlText);
      shared.delete(0, shared.length);
      shared.applyDelta(slateNodesToInsertDelta(input.content.blocks as never));
    }
    const metadata = ydoc.getMap<unknown>(METADATA_SHARED_TYPE);
    if (input.title !== undefined) metadata.set("title", input.title);
    if (input.parentDocumentId !== undefined) metadata.set("parentDocumentId", input.parentDocumentId);
    if (input.documentType !== undefined) metadata.set("documentType", input.documentType);
    if (input.workflowStatus !== undefined) metadata.set("workflowStatus", input.workflowStatus);
    if (input.tags !== undefined) metadata.set("tags", [...input.tags]);
  }, origin);
}

export function resetCollaborationState(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  source: DocumentDetail | DocumentRevisionSnapshot,
  options: {
    markDirty?: boolean;
    actor?: DraftActor;
    cas: DocumentDraftCas;
  },
) {
  const current = ensureCollaborationState(database, workspaceId, documentId);
  if (
    current.generation !== options.cas.expectedGeneration
    || current.draftVersion !== options.cas.expectedDraftVersion
    || current.baseRevisionNumber !== options.cas.expectedBaseRevision
  ) {
    throw new DocumentServiceError(
      "DRAFT_VERSION_CONFLICT",
      "공유 초안이 이미 변경되거나 다른 세대로 교체되었습니다. 최신 작업본을 다시 읽어주세요.",
      {
        expectedGeneration: options.cas.expectedGeneration,
        currentGeneration: current.generation,
        expectedDraftVersion: options.cas.expectedDraftVersion,
        currentDraftVersion: current.draftVersion,
        expectedBaseRevision: options.cas.expectedBaseRevision,
        currentBaseRevision: current.baseRevisionNumber,
      },
    );
  }
  const metadata = "metadata" in source
    ? source.metadata
    : {
        documentType: source.documentType,
        workflowStatus: source.workflowStatus,
        tags: source.tags,
      };
  const ydoc = createCollaborationYDoc({
    title: source.title,
    parentDocumentId: source.parentDocumentId,
    documentType: metadata.documentType,
    workflowStatus: metadata.workflowStatus,
    tags: metadata.tags,
    content: source.content,
  });
  const now = new Date().toISOString();
  const generation = current.generation + 1;
  // A historical revision supplies the draft contents, but the draft must
  // still be based on the latest canonical revision. Otherwise the explicit
  // commit would always conflict with the current document by construction.
  const canonical = getDocument(database, workspaceId, documentId);
  const baseRevisionId = canonical.revisionId;
  const baseRevisionNumber = canonical.revisionNumber;
  const draftState = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  const canonicalState = Buffer.from(Y.encodeStateAsUpdate(createCollaborationYDoc({
    ...metadataFromDocument(canonical),
    content: canonical.content,
  })));
  const committedState = options.markDirty ? canonicalState : draftState;
  const draftVersion = options.markDirty ? 1 : 0;
  database.transaction(() => {
    const reset = database.prepare(
      `UPDATE document_collaboration_states
       SET generation = ?, yjs_state = ?, committed_yjs_state = ?,
           base_revision_id = ?, base_revision_number = ?,
           draft_version = ?, committed_draft_version = 0, seeded_at = ?, updated_at = ?,
           committed_at = ?, last_actor_type = ?, last_actor_principal_id = ?,
           last_actor_label = ?, last_actor_avatar_media_id = ?
       WHERE document_id = ? AND workspace_id = ?
         AND generation = ? AND draft_version = ? AND base_revision_number = ?`,
    ).run(
      generation,
      draftState,
      committedState,
      baseRevisionId,
      baseRevisionNumber,
      draftVersion,
      now,
      now,
      options.markDirty ? current.committedAt : now,
      options.actor?.type ?? null,
      options.actor?.principalId ?? options.actor?.userId ?? null,
      options.actor?.label ?? null,
      options.actor?.avatarMediaId ?? null,
      documentId,
      workspaceId,
      options.cas.expectedGeneration,
      options.cas.expectedDraftVersion,
      options.cas.expectedBaseRevision,
    );
    if (reset.changes !== 1) {
      throw new DocumentServiceError(
        "DRAFT_VERSION_CONFLICT",
        "공유 초안이 이미 변경되거나 다른 세대로 교체되었습니다. 최신 작업본을 다시 읽어주세요.",
        {
          expectedGeneration: options.cas.expectedGeneration,
          expectedDraftVersion: options.cas.expectedDraftVersion,
          expectedBaseRevision: options.cas.expectedBaseRevision,
        },
      );
    }
    database.prepare("DELETE FROM document_draft_contributors WHERE document_id = ?")
      .run(documentId);
    if (options.markDirty && options.actor) {
      database.prepare(
        `INSERT INTO document_draft_contributors
         (document_id, generation, contributor_key, actor_type, actor_principal_id,
          actor_label, actor_avatar_media_id, first_edit_at, last_edit_at, update_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        documentId,
        generation,
        contributorKey(options.actor),
        options.actor.type,
        options.actor.principalId ?? options.actor.userId ?? null,
        options.actor.label,
        options.actor.avatarMediaId ?? null,
        now,
        now,
      );
    }
  })();
  return collaborationRoomName(workspaceId, documentId, generation);
}

export function collaborationPayloadHash(value: unknown) {
  function canonical(child: unknown): unknown {
    if (Array.isArray(child)) return child.map(canonical);
    if (!child || typeof child !== "object") return child;
    return Object.fromEntries(
      Object.entries(child as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type CollaborationIdempotency = {
  workspaceId: string;
  documentId: string;
  actorPrincipalId: string;
  operation: string;
  requestId: string;
  payloadHash: string;
};

export function prepareCollaborationIdempotency(input: {
  workspaceId: string;
  documentId: string;
  actor: DraftActor;
  operation: string;
  requestId?: string;
  payload: unknown;
}): CollaborationIdempotency | null {
  if (input.requestId === undefined) return null;
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new DocumentServiceError("INVALID_INPUT", "requestId는 8~128자의 영문자, 숫자, 점, 밑줄, 콜론 또는 하이픈이어야 합니다.");
  }
  const actorPrincipalId = input.actor.principalId ?? input.actor.userId;
  if (!actorPrincipalId) throw new DocumentServiceError("INVALID_INPUT", "멱등 요청에 사용할 작업자 식별자가 없습니다.");
  return {
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    actorPrincipalId,
    operation: input.operation,
    requestId: input.requestId,
    payloadHash: collaborationPayloadHash(input.payload),
  };
}

export function replayCollaborationRequest<T>(
  database: NyxDatabase,
  identity: CollaborationIdempotency | null,
): T | null {
  if (!identity) return null;
  const row = database.prepare(
    `SELECT workspace_id, document_id, payload_hash, response_json
     FROM collaboration_idempotency_requests
     WHERE actor_principal_id = ? AND operation = ? AND request_id = ?`,
  ).get(identity.actorPrincipalId, identity.operation, identity.requestId) as {
    workspace_id: string;
    document_id: string | null;
    payload_hash: string;
    response_json: string;
  } | undefined;
  if (!row) return null;
  if (
    row.workspace_id !== identity.workspaceId
    || row.document_id !== identity.documentId
    || row.payload_hash !== identity.payloadHash
  ) {
    throw new DocumentServiceError("IDEMPOTENCY_CONFLICT", "같은 requestId가 다른 공유 초안 요청에 이미 사용되었습니다.");
  }
  return JSON.parse(row.response_json) as T;
}

export function recordCollaborationRequest(
  database: NyxDatabase,
  identity: CollaborationIdempotency | null,
  response: unknown,
) {
  if (!identity) return;
  database.prepare(
    `INSERT INTO collaboration_idempotency_requests
     (id, workspace_id, document_id, actor_principal_id, operation, request_id,
      payload_hash, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    identity.workspaceId,
    identity.documentId,
    identity.actorPrincipalId,
    identity.operation,
    identity.requestId,
    identity.payloadHash,
    JSON.stringify(response),
    new Date().toISOString(),
  );
}

export function documentActorFromDraftActor(actor: DraftActor): DocumentActor {
  const userId = actor.userId?.trim();
  if (!userId) throw new DocumentServiceError("INVALID_INPUT", "정본을 저장할 사용자 식별자가 없습니다.");
  return {
    type: actor.type,
    userId,
    tokenId: actor.tokenId ?? undefined,
    principalId: actor.principalId ?? userId,
    avatarMediaId: actor.avatarMediaId ?? null,
    label: actor.label,
    source: actor.source,
  };
}

export function copyDraftContributorsToRevision(
  database: NyxDatabase,
  documentId: string,
  generation: number,
  revisionId: string,
  committer: DraftActor,
) {
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO document_draft_contributors
     (document_id, generation, contributor_key, actor_type, actor_principal_id,
      actor_label, actor_avatar_media_id, first_edit_at, last_edit_at, update_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(document_id, generation, contributor_key) DO UPDATE SET
       actor_label = excluded.actor_label,
       actor_avatar_media_id = excluded.actor_avatar_media_id,
       last_edit_at = excluded.last_edit_at`,
  ).run(
    documentId,
    generation,
    contributorKey(committer),
    committer.type,
    committer.principalId ?? committer.userId ?? null,
    committer.label,
    committer.avatarMediaId ?? null,
    now,
    now,
  );
  database.prepare(
    `INSERT INTO document_revision_contributors
     (revision_id, contributor_key, actor_type, actor_principal_id, actor_label,
      actor_avatar_media_id, first_edit_at, last_edit_at, update_count)
     SELECT ?, contributor_key, actor_type, actor_principal_id, actor_label,
            actor_avatar_media_id, first_edit_at, last_edit_at, update_count
     FROM document_draft_contributors
     WHERE document_id = ? AND generation = ?`,
  ).run(revisionId, documentId, generation);
}

export function markCollaborationCommitted(
  database: NyxDatabase,
  roomName: string,
  revisionId: string,
  revisionNumber: number,
  actor: DraftActor,
) {
  const room = parseCollaborationRoomName(roomName);
  requireActiveCollaborationDocument(database, room.workspaceId, room.documentId);
  const now = new Date().toISOString();
  database.transaction(() => {
    const state = collaborationStateRow(database, room.workspaceId, room.documentId);
    if (!state || Number(state.generation) !== room.generation) {
      throw new DocumentServiceError("DRAFT_CONFLICT", "공유 초안이 교체되어 정본 저장 결과를 기록하지 못했습니다.");
    }
    copyDraftContributorsToRevision(database, room.documentId, room.generation, revisionId, actor);
    database.prepare(
      `UPDATE document_collaboration_states
       SET base_revision_id = ?, base_revision_number = ?,
           committed_draft_version = draft_version,
           committed_yjs_state = yjs_state, committed_at = ?
       WHERE document_id = ? AND workspace_id = ? AND generation = ?`,
    ).run(revisionId, revisionNumber, now, room.documentId, room.workspaceId, room.generation);
    database.prepare(
      `DELETE FROM document_draft_contributors
       WHERE document_id = ? AND generation = ?`,
    ).run(room.documentId, room.generation);
  })();
}

export function markCollaborationSyncedWithoutRevision(
  database: NyxDatabase,
  roomName: string,
  revisionId: string | null,
  revisionNumber: number,
) {
  const room = parseCollaborationRoomName(roomName);
  requireActiveCollaborationDocument(database, room.workspaceId, room.documentId);
  const now = new Date().toISOString();
  const result = database.prepare(
    `UPDATE document_collaboration_states
     SET base_revision_id = ?, base_revision_number = ?,
         committed_draft_version = draft_version,
         committed_yjs_state = yjs_state, committed_at = ?
     WHERE document_id = ? AND workspace_id = ? AND generation = ?`,
  ).run(
    revisionId,
    revisionNumber,
    now,
    room.documentId,
    room.workspaceId,
    room.generation,
  );
  if (result.changes !== 1) throw new DocumentServiceError("DRAFT_CONFLICT", "공유 초안이 교체되어 저장 결과를 기록하지 못했습니다.");
  database.prepare(
    `DELETE FROM document_draft_contributors
     WHERE document_id = ? AND generation = ?`,
  ).run(room.documentId, room.generation);
}
