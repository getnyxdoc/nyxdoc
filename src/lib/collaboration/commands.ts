import * as Y from "yjs";
import type { NyxDatabase } from "@/lib/db/client";
import {
  collaborationYDocFromState,
  documentActorFromDraftActor,
  ensureCollaborationState,
  loadCollaborationStateByRoom,
  markCollaborationCommitted,
  markCollaborationSyncedWithoutRevision,
  persistCollaborationUpdate,
  persistCollaborationYDoc,
  prepareCollaborationIdempotency,
  recordCollaborationRequest,
  replaceWorkingDocument,
  replayCollaborationRequest,
  resetCollaborationState,
  workingDocumentFromStoredState,
  workingDocumentFromYDoc,
  type CollaborationIdempotency,
  type WorkingDocument,
} from "@/lib/collaboration/drafts";
import type {
  ArchiveWorkingTreeRequest,
  ArchiveWorkingTreeResponse,
  CommitWorkingDocumentRequest,
  CommitWorkingDocumentResponse,
  PatchWorkingDocumentRequest,
  ReadWorkingDocumentRequest,
  ReplaceAndCommitWorkingDocumentRequest,
  ReplaceWorkingDocumentRequest,
  ResetWorkingDocumentRequest,
  ResetWorkingDocumentResponse,
  WorkingDocumentResponse,
} from "@/lib/collaboration/protocol";
import {
  applyDocumentPatch,
  archiveDocument,
  getDocument,
  getDocumentRevisionSnapshot,
  requireDocumentMoveAuthorization,
  updateDocument,
} from "@/lib/documents/service";
import {
  blockIdNormalization,
  normalizeTopLevelBlockIds,
  type TopLevelBlockIdRemap,
} from "@/lib/documents/block-ids";
import { DocumentServiceError } from "@/lib/documents/types";

export type CollaborationDocumentProvider = {
  withDocument<T>(roomName: string, callback: (document: Y.Doc) => Promise<T> | T): Promise<T>;
  closeConnections(roomName: string): Promise<void> | void;
  broadcast?(document: Y.Doc, payload: string): void;
};

export type CollaborationCommands = ReturnType<typeof createCollaborationCommands>;

function assertExpectedDraftVersion(
  working: WorkingDocument,
  expected: number | undefined,
  code: "DRAFT_CONFLICT" | "DRAFT_VERSION_CONFLICT" = "DRAFT_CONFLICT",
) {
  if (expected === undefined) return;
  if (working.draftVersion !== expected) {
    throw new DocumentServiceError(
      code,
      "공유 초안이 이미 변경되었습니다. 최신 작업본을 다시 읽고 의도를 적용해주세요.",
      {
        expectedDraftVersion: expected,
        currentDraftVersion: working.draftVersion,
        baseRevision: working.baseRevisionNumber,
      },
    );
  }
}

function decodeStateVector(value: string) {
  if (
    value.length === 0
    || value.length > 32_768
    || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)
  ) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안 동기화 기준값이 올바르지 않습니다.",
    );
  }
  try {
    return Y.decodeStateVector(Buffer.from(value, "base64url"));
  } catch {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안 동기화 기준값을 읽을 수 없습니다.",
    );
  }
}

function assertCommitSynchronizationFence(
  document: Y.Doc,
  working: WorkingDocument,
  fence: CommitWorkingDocumentRequest["synchronizationFence"],
) {
  if (!fence) return;
  if (working.generation !== fence.generation) {
    throw new DocumentServiceError(
      "DRAFT_VERSION_CONFLICT",
      "공유 초안이 다른 세대로 교체되었습니다. 최신 문서를 다시 열어주세요.",
      {
        expectedGeneration: fence.generation,
        currentGeneration: working.generation,
      },
    );
  }
  const clientStateVector = decodeStateVector(fence.stateVector);
  const serverStateVector = Y.decodeStateVector(Y.encodeStateVector(document));
  const missingClients: Array<{
    clientId: number;
    expectedClock: number;
    currentClock: number;
  }> = [];
  for (const [clientId, expectedClock] of clientStateVector) {
    const currentClock = serverStateVector.get(clientId) ?? 0;
    if (currentClock < expectedClock) {
      missingClients.push({ clientId, expectedClock, currentClock });
    }
  }
  if (missingClients.length > 0) {
    throw new DocumentServiceError(
      "DRAFT_NOT_SYNCED",
      "마지막 편집 내용이 아직 공유 초안 서버에 도착하지 않았습니다. 동기화 후 다시 저장해주세요.",
      {
        generation: working.generation,
        missingClientCount: missingClients.length,
        missingClients: missingClients.slice(0, 20),
      },
    );
  }
}

function broadcastDraftStatus(
  provider: CollaborationDocumentProvider,
  document: Y.Doc,
  workingDocument: WorkingDocument,
) {
  provider.broadcast?.(document, JSON.stringify({
    type: "draft-status",
    documentId: workingDocument.documentId,
    draftVersion: workingDocument.draftVersion,
    hasUncommittedChanges: workingDocument.hasUncommittedChanges,
  }));
}

export function createStoredCollaborationDocumentProvider(
  database: NyxDatabase,
): CollaborationDocumentProvider {
  return {
    async withDocument(roomName, callback) {
      const state = loadCollaborationStateByRoom(database, roomName);
      return await callback(collaborationYDocFromState(state.state));
    },
    closeConnections() {},
  };
}

export function createCollaborationCommands(input: {
  database: NyxDatabase;
  provider: CollaborationDocumentProvider;
}) {
  const { database, provider } = input;

  function assertCanonicalBase(working: WorkingDocument) {
    const canonical = getDocument(database, working.workspaceId, working.documentId);
    if (canonical.revisionNumber !== working.baseRevisionNumber) {
      throw new DocumentServiceError(
        "REVISION_CONFLICT",
        "정본이 공유 초안의 기준 리비전 이후 변경되었습니다. 초안을 새 기준에 다시 적용해주세요.",
        {
          baseRevision: working.baseRevisionNumber,
          currentRevision: canonical.revisionNumber,
          draftVersion: working.draftVersion,
        },
      );
    }
    return canonical;
  }

  function requireDraftMoveAuthorization(
    working: WorkingDocument,
    parentDocumentId: string | null | undefined,
    actor: CommitWorkingDocumentRequest["actor"],
  ) {
    if (parentDocumentId === undefined || parentDocumentId === working.parentDocumentId) return;
    requireDocumentMoveAuthorization(
      database,
      working.workspaceId,
      working.documentId,
      parentDocumentId,
      actor,
    );
  }

  function commitLoadedDocument(input: {
    document: Y.Doc;
    working: WorkingDocument;
    actor: CommitWorkingDocumentRequest["actor"];
    summary?: string;
    idempotency: CollaborationIdempotency | null;
    normalizationRemaps?: readonly TopLevelBlockIdRemap[];
  }): CommitWorkingDocumentResponse {
    const { document, actor, summary, idempotency } = input;
    let working = input.working;
    const normalized = normalizeTopLevelBlockIds(
      database,
      working.documentId,
      working.content,
    );
    if (normalized.repairs.length > 0) {
      replaceWorkingDocument(document, { content: normalized.content }, {
        context: { actor, recordedByEndpoint: true },
      });
      persistCollaborationUpdate(database, working.roomName, document, actor);
      working = workingDocumentFromYDoc(database, working.roomName, document);
    }
    const normalization = blockIdNormalization([
      ...(input.normalizationRemaps ?? []),
      ...normalized.repairs,
    ]);
    const response = database.transaction(() => {
      const canonical = assertCanonicalBase(working);
      const result = updateDocument(
        database,
        working.workspaceId,
        documentActorFromDraftActor(actor),
        working.documentId,
        {
          idempotencyOperation: "commit_document",
          baseRevision: canonical.revisionNumber,
          title: working.title,
          parentDocumentId: working.parentDocumentId,
          documentType: working.metadata.documentType,
          workflowStatus: working.metadata.workflowStatus,
          tags: working.metadata.tags,
          content: working.content,
          summary,
        },
      );
      if (result.unchanged) {
        markCollaborationSyncedWithoutRevision(
          database,
          working.roomName,
          result.document.revisionId,
          result.document.revisionNumber,
        );
      } else {
        if (!result.document.revisionId) {
          throw new DocumentServiceError(
            "COLLABORATION_UNAVAILABLE",
            "저장된 정본 리비전 식별자가 없습니다.",
          );
        }
        markCollaborationCommitted(
          database,
          working.roomName,
          result.document.revisionId,
          result.document.revisionNumber,
          actor,
        );
      }
      const value: CommitWorkingDocumentResponse = {
        ...result,
        workingDocument: workingDocumentFromYDoc(database, working.roomName, document),
        ...(normalization ? { normalization } : {}),
      };
      recordCollaborationRequest(database, idempotency, value);
      return value;
    }).immediate();
    provider.broadcast?.(document, JSON.stringify({
      type: "canonical-committed",
      documentId: response.document.id,
      revisionNumber: response.document.revisionNumber,
      draftVersion: response.workingDocument.draftVersion,
      actor: { type: actor.type, label: actor.label },
    }));
    return response;
  }

  async function readWorking(
    request: ReadWorkingDocumentRequest,
  ): Promise<WorkingDocumentResponse> {
    const state = ensureCollaborationState(database, request.workspaceId, request.documentId);
    return provider.withDocument(state.roomName, (document) => ({
      workingDocument: workingDocumentFromYDoc(database, state.roomName, document),
    }));
  }

  async function replaceWorking(
    request: ReplaceWorkingDocumentRequest,
  ): Promise<WorkingDocumentResponse> {
    const state = loadCollaborationStateByRoom(database, request.roomName);
    const idempotency = prepareCollaborationIdempotency({
      workspaceId: state.workspaceId,
      documentId: state.documentId,
      actor: request.actor,
      operation: "replace_draft",
      requestId: request.requestId,
      payload: request,
    });
    const replayed = replayCollaborationRequest<WorkingDocumentResponse>(database, idempotency);
    if (replayed) return replayed;

    const response = await provider.withDocument(request.roomName, (document) => {
      const mutation = database.transaction(() => {
        const before = workingDocumentFromYDoc(database, request.roomName, document);
        assertExpectedDraftVersion(before, request.expectedDraftVersion);
        requireDraftMoveAuthorization(
          before,
          request.replacement.parentDocumentId,
          request.actor,
        );
        const normalized = request.replacement.content
          ? normalizeTopLevelBlockIds(database, state.documentId, request.replacement.content)
          : null;
        replaceWorkingDocument(document, {
          ...request.replacement,
          ...(normalized ? { content: normalized.content } : {}),
        }, {
          context: { actor: request.actor, recordedByEndpoint: true },
        });
        persistCollaborationUpdate(database, request.roomName, document, request.actor);
        const workingDocument = workingDocumentFromYDoc(database, request.roomName, document);
        const normalization = normalized
          ? blockIdNormalization(normalized.repairs)
          : undefined;
        return {
          workingDocument,
          ...(normalization ? { normalization } : {}),
        };
      }).immediate();
      broadcastDraftStatus(provider, document, mutation.workingDocument);
      return mutation;
    });
    recordCollaborationRequest(database, idempotency, response);
    return response;
  }

  async function replaceAndCommitWorking(
    request: ReplaceAndCommitWorkingDocumentRequest,
  ): Promise<CommitWorkingDocumentResponse> {
    const state = loadCollaborationStateByRoom(database, request.roomName);
    const idempotency = prepareCollaborationIdempotency({
      workspaceId: state.workspaceId,
      documentId: state.documentId,
      actor: request.actor,
      operation: "replace_and_commit_draft",
      requestId: request.requestId,
      payload: {
        ...request,
        expectedDraftVersion: request.idempotencyDraftVersion ?? request.expectedDraftVersion,
      },
    });
    const replayed = replayCollaborationRequest<CommitWorkingDocumentResponse>(database, idempotency);
    if (replayed) return replayed;

    return provider.withDocument(request.roomName, (document) => {
      const mutation = database.transaction(() => {
        const before = workingDocumentFromYDoc(database, request.roomName, document);
        assertExpectedDraftVersion(before, request.expectedDraftVersion);
        assertCanonicalBase(before);
        requireDraftMoveAuthorization(
          before,
          request.replacement.parentDocumentId,
          request.actor,
        );
        const normalized = request.replacement.content
          ? normalizeTopLevelBlockIds(database, state.documentId, request.replacement.content)
          : null;
        replaceWorkingDocument(document, {
          ...request.replacement,
          ...(normalized ? { content: normalized.content } : {}),
        }, {
          context: { actor: request.actor, recordedByEndpoint: true },
        });
        persistCollaborationUpdate(database, request.roomName, document, request.actor);
        return {
          working: workingDocumentFromYDoc(database, request.roomName, document),
          normalizationRemaps: normalized?.repairs,
        };
      }).immediate();
      return commitLoadedDocument({
        document,
        working: mutation.working,
        actor: request.actor,
        summary: request.summary,
        idempotency,
        normalizationRemaps: mutation.normalizationRemaps,
      });
    });
  }

  async function patchWorking(
    request: PatchWorkingDocumentRequest,
  ): Promise<WorkingDocumentResponse> {
    const state = loadCollaborationStateByRoom(database, request.roomName);
    const idempotency = prepareCollaborationIdempotency({
      workspaceId: state.workspaceId,
      documentId: state.documentId,
      actor: request.actor,
      operation: "patch_draft",
      requestId: request.requestId,
      payload: request,
    });
    const replayed = replayCollaborationRequest<WorkingDocumentResponse>(database, idempotency);
    if (replayed) return replayed;

    const response = await provider.withDocument(request.roomName, async (document) => {
      const before = workingDocumentFromYDoc(database, request.roomName, document);
      assertExpectedDraftVersion(before, request.expectedDraftVersion);
      const patchedContent = applyDocumentPatch(before.content, request.operations);
      const normalized = normalizeTopLevelBlockIds(
        database,
        state.documentId,
        patchedContent,
      );
      replaceWorkingDocument(document, { content: normalized.content }, {
        context: { actor: request.actor, recordedByEndpoint: true },
      });
      persistCollaborationUpdate(database, request.roomName, document, request.actor);
      const workingDocument = workingDocumentFromYDoc(database, request.roomName, document);
      const normalization = blockIdNormalization(normalized.repairs);
      broadcastDraftStatus(provider, document, workingDocument);
      return {
        workingDocument,
        ...(normalization ? { normalization } : {}),
      };
    });
    recordCollaborationRequest(database, idempotency, response);
    return response;
  }

  async function commitWorking(
    request: CommitWorkingDocumentRequest,
  ): Promise<CommitWorkingDocumentResponse> {
    const state = loadCollaborationStateByRoom(database, request.roomName);
    const idempotency = prepareCollaborationIdempotency({
      workspaceId: state.workspaceId,
      documentId: state.documentId,
      actor: request.actor,
      operation: "commit_draft",
      requestId: request.requestId,
      payload: request,
    });
    const replayed = replayCollaborationRequest<CommitWorkingDocumentResponse>(database, idempotency);
    if (replayed) return replayed;

    return provider.withDocument(request.roomName, (document) => {
      const before = workingDocumentFromYDoc(database, request.roomName, document);
      assertCommitSynchronizationFence(
        document,
        before,
        request.synchronizationFence,
      );
      // Flush the exact in-memory state before taking the immutable snapshot.
      persistCollaborationYDoc(database, request.roomName, document);
      const working = workingDocumentFromYDoc(database, request.roomName, document);
      assertCommitSynchronizationFence(
        document,
        working,
        request.synchronizationFence,
      );
      assertExpectedDraftVersion(
        working,
        request.expectedDraftVersion,
        "DRAFT_VERSION_CONFLICT",
      );
      return commitLoadedDocument({
        document,
        working,
        actor: request.actor,
        summary: request.summary,
        idempotency,
      });
    });
  }

  async function resetWorking(
    request: ResetWorkingDocumentRequest,
  ): Promise<ResetWorkingDocumentResponse> {
    const currentState = ensureCollaborationState(database, request.workspaceId, request.documentId);
    const idempotency = prepareCollaborationIdempotency({
      workspaceId: request.workspaceId,
      documentId: request.documentId,
      actor: request.actor,
      operation: request.revisionId ? "restore_revision_to_draft" : "discard_draft",
      requestId: request.requestId,
      payload: request,
    });
    const replayed = replayCollaborationRequest<ResetWorkingDocumentResponse>(database, idempotency);
    if (replayed) return replayed;
    const source = request.revisionId
      ? getDocumentRevisionSnapshot(database, request.workspaceId, request.documentId, request.revisionId)
      : getDocument(database, request.workspaceId, request.documentId);
    const roomName = resetCollaborationState(
      database,
      request.workspaceId,
      request.documentId,
      source,
      request.revisionId
        ? { markDirty: true, actor: { ...request.actor, source: "rollback" } }
        : { markDirty: false },
    );
    await provider.closeConnections(currentState.roomName);
    const response = {
      roomName,
      workingDocument: workingDocumentFromStoredState(database, request.workspaceId, request.documentId),
    };
    recordCollaborationRequest(database, idempotency, response);
    return response;
  }

  async function archiveWorkingTree(
    request: ArchiveWorkingTreeRequest,
  ): Promise<ArchiveWorkingTreeResponse> {
    const subtree = database.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id
         FROM documents
         WHERE workspace_id = ? AND id = ?
           AND status = 'active' AND lifecycle_state = 'active'
         UNION ALL
         SELECT document.id
         FROM documents document
         JOIN subtree ON document.parent_document_id = subtree.id
         WHERE document.workspace_id = ?
           AND document.status = 'active'
           AND document.lifecycle_state = 'active'
       )
       SELECT id FROM subtree ORDER BY id`,
    ).all(
      request.workspaceId,
      request.documentId,
      request.workspaceId,
    ) as Array<{ id: string }>;
    if (subtree.length === 0) {
      throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }
    const rooms = subtree.map(({ id }) =>
      ensureCollaborationState(database, request.workspaceId, id).roomName);
    const opened: Array<{ roomName: string; document: Y.Doc }> = [];

    async function openAll(index: number): Promise<ArchiveWorkingTreeResponse> {
      if (index >= rooms.length) {
        // No asynchronous boundary is allowed between this flush and the
        // generation bump inside archiveDocument. Any update already applied
        // to an opened Y.Doc is therefore included in the sealed draft.
        for (const room of opened) {
          persistCollaborationYDoc(database, room.roomName, room.document);
        }
        return archiveDocument(
          database,
          request.workspaceId,
          documentActorFromDraftActor(request.actor),
          request.documentId,
          {
            baseRevision: request.baseRevision,
            createdByAgentId: request.createdByAgentId,
          },
        );
      }
      const roomName = rooms[index]!;
      return provider.withDocument(roomName, async (document) => {
        opened.push({ roomName, document });
        return openAll(index + 1);
      });
    }

    const response = await openAll(0);
    await Promise.all(rooms.map(async (roomName) => {
      await provider.closeConnections(roomName);
    }));
    return response;
  }

  return {
    readWorking,
    replaceWorking,
    replaceAndCommitWorking,
    patchWorking,
    commitWorking,
    resetWorking,
    archiveWorkingTree,
  };
}
