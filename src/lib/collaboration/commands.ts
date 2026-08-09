import * as Y from "yjs";
import {
  getHumanDocumentPrincipal,
  getHumanWorkspacePrincipal,
  humanDocumentPrincipalAllows,
  humanRoleAllows,
} from "@/lib/authz/permissions";
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
  rebaseCollaborationStateAfterCanonicalMetadataCommit,
  recordCollaborationRequest,
  replaceWorkingDocument,
  replayCollaborationRequest,
  resetCollaborationState,
  workingDocumentFromStoredState,
  workingDocumentFromYDoc,
  type CollaborationIdempotency,
  type DraftActor,
  type WorkingDocument,
} from "@/lib/collaboration/drafts";
import type {
  ArchiveWorkingTreeRequest,
  ArchiveWorkingTreeResponse,
  CommitWorkingDocumentRequest,
  CommitWorkingDocumentResponse,
  DraftMutationState,
  MoveWorkingDocumentTreeRequest,
  MoveWorkingDocumentTreeResponse,
  PatchWorkingDocumentRequest,
  ReadWorkingDocumentRequest,
  ReplaceAndCommitWorkingDocumentRequest,
  ReplaceWorkingDocumentRequest,
  ResetWorkingDocumentRequest,
  ResetWorkingDocumentResponse,
  WorkingDocumentResponse,
} from "@/lib/collaboration/protocol";
import { requireCurrentCollaborationAuthorization } from "@/lib/collaboration/authorization";
import {
  applyDocumentPatch,
  archiveDocument,
  assertDocumentTitleIsNotLeadingH1,
  getDocument,
  getDocumentRevisionSnapshot,
  reorderDocumentTree,
  requireDocumentMoveAuthorization,
  updateDocument,
} from "@/lib/documents/service";
import {
  blockIdNormalization,
  normalizeTopLevelBlockIds,
  type TopLevelBlockIdRemap,
} from "@/lib/documents/block-ids";
import { DocumentServiceError } from "@/lib/documents/types";
import {
  assertDocumentMediaAssetsBelongToWorkspace,
  assertDocumentMediaReferencesAuthorized,
} from "@/lib/media/bindings";
import {
  ApiTokenError,
  authenticateAgentCredential,
  requireTokenDocumentAccess,
  requireTokenPermission,
} from "@/lib/tokens/service";

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

function sameWorkingPayload(left: WorkingDocument, right: WorkingDocument) {
  return JSON.stringify({
    title: left.title,
    parentDocumentId: left.parentDocumentId,
    metadata: left.metadata,
    content: left.content,
  }) === JSON.stringify({
    title: right.title,
    parentDocumentId: right.parentDocumentId,
    metadata: right.metadata,
    content: right.content,
  });
}

function currentAgentIdentity(
  database: NyxDatabase,
  workspaceId: string,
  actor: DraftActor,
) {
  const tokenId = actor.tokenId?.trim();
  if (!tokenId) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      "현재 에이전트 연결 자격 증명을 확인할 수 없습니다.",
    );
  }
  try {
    const identity = authenticateAgentCredential(database, tokenId, {
      workspaceId,
      clientIp: actor.requestContext?.clientIp,
      scopeCeiling: actor.scopeCeiling,
    });
    if (actor.principalId && identity.globalAgentId !== actor.principalId) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        "현재 에이전트 연결과 작업자 신원이 일치하지 않습니다.",
      );
    }
    return identity;
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

function documentReferenceIds(content: WorkingDocument["content"]) {
  const references = new Set<string>();
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "doc_ref" && typeof node.documentId === "string") {
      references.add(node.documentId);
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  }
  visit(content.blocks);
  return [...references];
}

/**
 * Historical content is untrusted input at the point it becomes the new shared
 * draft. Re-run the same current-actor media and document-scope checks used by
 * canonical writes; access that existed when the revision was created is not a
 * lease for a later restore.
 */
function assertReplacementSnapshotAuthorized(input: {
  database: NyxDatabase;
  workspaceId: string;
  actor: DraftActor;
  content: WorkingDocument["content"];
}) {
  const { database, workspaceId, actor, content } = input;
  if (actor.type === "system") {
    assertDocumentMediaAssetsBelongToWorkspace(database, workspaceId, content);
  } else {
    const documentActor = documentActorFromDraftActor(actor);
    const agentIdentity = actor.type === "agent"
      ? currentAgentIdentity(database, workspaceId, actor)
      : null;
    assertDocumentMediaReferencesAuthorized(database, {
      workspaceId,
      actor: documentActor,
      content,
      ...(agentIdentity
        ? {
            agentCanReadDocument(documentId: string) {
              try {
                requireTokenDocumentAccess(database, agentIdentity, documentId);
                return true;
              } catch (error) {
                if (error instanceof ApiTokenError) return false;
                throw error;
              }
            },
            agentCanReadRevision(documentId: string) {
              try {
                requireTokenPermission(agentIdentity, "documents:read", "revisions.read");
                requireTokenDocumentAccess(database, agentIdentity, documentId);
                return true;
              } catch (error) {
                if (error instanceof ApiTokenError) return false;
                throw error;
              }
            },
          }
        : {}),
    });
  }

  for (const targetDocumentId of documentReferenceIds(content)) {
    const target = database.prepare(
      `SELECT 1 FROM documents
       WHERE workspace_id = ? AND id = ?
         AND status = 'active' AND lifecycle_state = 'active'`,
    ).get(workspaceId, targetDocumentId);
    if (!target) {
      throw new DocumentServiceError(
        "INVALID_INPUT",
        "내부 문서 링크의 대상이 이 워크스페이스에 없거나 보관되었습니다.",
        { targetDocumentId },
      );
    }
    if (actor.type === "system") continue;
    if (actor.type === "human") {
      const userId = actor.userId?.trim();
      const principal = userId
        ? getHumanDocumentPrincipal(database, workspaceId, targetDocumentId, userId)
        : null;
      if (principal && humanDocumentPrincipalAllows(principal, "documents.read")) continue;
    } else {
      const identity = currentAgentIdentity(database, workspaceId, actor);
      try {
        requireTokenDocumentAccess(database, identity, targetDocumentId);
        continue;
      } catch (error) {
        if (!(error instanceof ApiTokenError)) throw error;
      }
    }
    throw new DocumentServiceError(
      "FORBIDDEN",
      "내부 문서 링크가 현재 작업자의 허용 범위를 벗어났습니다.",
      { targetDocumentId },
    );
  }
}

function requireCurrentArchiveAuthorization(
  database: NyxDatabase,
  request: ArchiveWorkingTreeRequest,
) {
  if (request.actor.type === "system") return;
  requireCurrentCollaborationAuthorization(
    database,
    request.workspaceId,
    request.documentId,
    request.actor,
    "draft.update",
  );
  if (request.actor.type === "human") {
    const userId = request.actor.userId?.trim();
    const principal = userId
      ? getHumanWorkspacePrincipal(database, request.workspaceId, userId)
      : null;
    if (!principal || !humanRoleAllows(principal.role, "documents.trash")) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        "현재 워크스페이스 권한으로 문서를 휴지통으로 옮길 수 없습니다.",
      );
    }
    return;
  }

  const identity = currentAgentIdentity(database, request.workspaceId, request.actor);
  try {
    requireTokenPermission(
      identity,
      "documents:write",
      request.createdByAgentId ? "documents.trash_own" : "documents.trash",
    );
    requireTokenDocumentAccess(database, identity, request.documentId);
  } catch (error) {
    if (error instanceof ApiTokenError) {
      throw new DocumentServiceError(
        error.code === "NOT_FOUND" ? "NOT_FOUND" : "FORBIDDEN",
        error.message,
      );
    }
    throw error;
  }
}

function getActiveSubtreeDocumentIds(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
) {
  return (database.prepare(
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
  ).all(workspaceId, documentId, workspaceId) as Array<{ id: string }>)
    .map(({ id }) => id);
}

function assertDestructiveCas(
  working: WorkingDocument,
  request: Pick<
    ResetWorkingDocumentRequest,
    "expectedGeneration" | "expectedDraftVersion" | "expectedBaseRevision"
  >,
) {
  if (
    working.generation !== request.expectedGeneration
    || working.draftVersion !== request.expectedDraftVersion
    || working.baseRevisionNumber !== request.expectedBaseRevision
  ) {
    throw new DocumentServiceError(
      "DRAFT_VERSION_CONFLICT",
      "공유 초안이 이미 변경되거나 다른 세대로 교체되었습니다. 최신 작업본을 다시 읽어주세요.",
      {
        expectedGeneration: request.expectedGeneration,
        currentGeneration: working.generation,
        expectedDraftVersion: request.expectedDraftVersion,
        currentDraftVersion: working.draftVersion,
        expectedBaseRevision: request.expectedBaseRevision,
        currentBaseRevision: working.baseRevisionNumber,
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

function draftVersionState(working: WorkingDocument) {
  return {
    generation: working.generation,
    draftVersion: working.draftVersion,
    committedDraftVersion: working.committedDraftVersion,
    baseRevisionNumber: working.baseRevisionNumber,
    hasUncommittedChanges: working.hasUncommittedChanges,
  } satisfies DraftMutationState["current"];
}

function observeDraftMutation<T extends { workingDocument: WorkingDocument }>(
  receipt: T,
  current: WorkingDocument,
  replayed: boolean,
): T & { mutationState: DraftMutationState } {
  return {
    ...receipt,
    // Compatibility readers must always observe the current working state.
    // The original mutation state remains available in the compact receipt.
    workingDocument: current,
    mutationState: {
      source: "working",
      replayed,
      receipt: draftVersionState(receipt.workingDocument),
      current: draftVersionState(current),
    },
  };
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

  function loadAuthoritativeDraft(roomName: string) {
    const state = loadCollaborationStateByRoom(database, roomName);
    const document = collaborationYDocFromState(state.state);
    return {
      document,
      working: workingDocumentFromYDoc(database, roomName, document),
    };
  }

  function assertProcessDraftMatchesAuthoritative(
    processWorking: WorkingDocument,
    authoritativeWorking: WorkingDocument,
    code: "DRAFT_CONFLICT" | "DRAFT_VERSION_CONFLICT" | "DRAFT_NOT_SYNCED",
  ) {
    if (sameWorkingPayload(processWorking, authoritativeWorking)) return;
    throw new DocumentServiceError(
      code,
      "이 서버의 공유 초안이 아직 최신 저장 상태와 동기화되지 않았습니다. 동기화 후 다시 시도해주세요.",
      {
        currentDraftVersion: authoritativeWorking.draftVersion,
        generation: authoritativeWorking.generation,
      },
    );
  }

  function commitLoadedDocumentInTransaction(input: {
    document: Y.Doc;
    working: WorkingDocument;
    actor: CommitWorkingDocumentRequest["actor"];
    summary?: string;
    idempotency: CollaborationIdempotency | null;
    normalizationRemaps?: readonly TopLevelBlockIdRemap[];
  }): CommitWorkingDocumentResponse {
    const { document, actor, summary, idempotency } = input;
    let working = input.working;
    requireCurrentCollaborationAuthorization(
      database,
      working.workspaceId,
      working.documentId,
      actor,
      "canonical.commit",
    );
    assertDocumentMediaAssetsBelongToWorkspace(
      database,
      working.workspaceId,
      working.content,
    );
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
  }

  function broadcastCanonicalCommit(
    document: Y.Doc,
    response: CommitWorkingDocumentResponse,
    actor: CommitWorkingDocumentRequest["actor"],
  ) {
    provider.broadcast?.(document, JSON.stringify({
      type: "canonical-committed",
      documentId: response.document.id,
      revisionNumber: response.document.revisionNumber,
      draftVersion: response.workingDocument.draftVersion,
      actor: { type: actor.type, label: actor.label },
    }));
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
    if (replayed) {
      return provider.withDocument(request.roomName, (document) =>
        observeDraftMutation(
          replayed,
          workingDocumentFromYDoc(database, request.roomName, document),
          true,
        ));
    }

    const response = await provider.withDocument(request.roomName, (document) => {
      let persistedDocument: Y.Doc | null = null;
      const mutation = database.transaction(() => {
        const processWorking = workingDocumentFromYDoc(database, request.roomName, document);
        assertDocumentMediaAssetsBelongToWorkspace(
          database,
          processWorking.workspaceId,
          processWorking.content,
        );
        const authoritative = loadAuthoritativeDraft(request.roomName);
        const before = authoritative.working;
        requireCurrentCollaborationAuthorization(
          database,
          before.workspaceId,
          before.documentId,
          request.actor,
          "draft.update",
        );
        assertExpectedDraftVersion(before, request.expectedDraftVersion);
        assertProcessDraftMatchesAuthoritative(
          processWorking,
          before,
          "DRAFT_CONFLICT",
        );
        requireDraftMoveAuthorization(
          before,
          request.replacement.parentDocumentId,
          request.actor,
        );
        const normalized = request.replacement.content
          ? normalizeTopLevelBlockIds(database, state.documentId, request.replacement.content)
          : null;
        if (normalized) {
          assertDocumentMediaAssetsBelongToWorkspace(
            database,
            state.workspaceId,
            normalized.content,
          );
        }
        const candidate = authoritative.document;
        replaceWorkingDocument(candidate, {
          ...request.replacement,
          ...(normalized ? { content: normalized.content } : {}),
        }, {
          context: { actor: request.actor, recordedByEndpoint: true },
        });
        const candidateWorking = workingDocumentFromYDoc(
          database,
          request.roomName,
          candidate,
        );
        assertDocumentMediaAssetsBelongToWorkspace(
          database,
          candidateWorking.workspaceId,
          candidateWorking.content,
        );
        persistCollaborationUpdate(database, request.roomName, candidate, request.actor);
        const workingDocument = workingDocumentFromYDoc(database, request.roomName, candidate);
        const normalization = normalized
          ? blockIdNormalization(normalized.repairs)
          : undefined;
        const value = {
          workingDocument,
          ...(normalization ? { normalization } : {}),
        };
        recordCollaborationRequest(database, idempotency, value);
        persistedDocument = candidate;
        return value;
      }).immediate();
      if (!persistedDocument) {
        throw new DocumentServiceError(
          "COLLABORATION_UNAVAILABLE",
          "공유 초안 변경 결과를 협업 문서에 반영하지 못했습니다.",
        );
      }
      const candidateDelta = Y.encodeStateAsUpdate(
        persistedDocument,
        Y.encodeStateVector(document),
      );
      Y.applyUpdate(document, candidateDelta, {
        context: { actor: request.actor, recordedByEndpoint: true },
      });
      broadcastDraftStatus(provider, document, mutation.workingDocument);
      return mutation;
    });
    return observeDraftMutation(response, response.workingDocument, false);
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
    if (replayed) {
      return provider.withDocument(request.roomName, (document) =>
        observeDraftMutation(
          replayed,
          workingDocumentFromYDoc(database, request.roomName, document),
          true,
        ));
    }

    const response = await provider.withDocument(request.roomName, (document) => {
      let committedDocument: Y.Doc | null = null;
      const response = database.transaction(() => {
        const processWorking = workingDocumentFromYDoc(database, request.roomName, document);
        assertDocumentMediaAssetsBelongToWorkspace(
          database,
          processWorking.workspaceId,
          processWorking.content,
        );
        const authoritative = loadAuthoritativeDraft(request.roomName);
        const before = authoritative.working;
        requireCurrentCollaborationAuthorization(
          database,
          before.workspaceId,
          before.documentId,
          request.actor,
          "draft.update",
        );
        assertExpectedDraftVersion(before, request.expectedDraftVersion);
        assertProcessDraftMatchesAuthoritative(
          processWorking,
          before,
          "DRAFT_CONFLICT",
        );
        assertCanonicalBase(before);
        requireDraftMoveAuthorization(
          before,
          request.replacement.parentDocumentId,
          request.actor,
        );
        const normalized = request.replacement.content
          ? normalizeTopLevelBlockIds(database, state.documentId, request.replacement.content)
          : null;
        if (normalized) {
          assertDocumentMediaAssetsBelongToWorkspace(
            database,
            state.workspaceId,
            normalized.content,
          );
        }
        // The replacement and every commit-side normalization operate on the
        // locked stored draft, never on a process-local Y.Doc that may be stale.
        const candidate = authoritative.document;
        replaceWorkingDocument(candidate, {
          ...request.replacement,
          ...(normalized ? { content: normalized.content } : {}),
        }, {
          context: { actor: request.actor, recordedByEndpoint: true },
        });
        persistCollaborationUpdate(database, request.roomName, candidate, request.actor);
        const committed = commitLoadedDocumentInTransaction({
          document: candidate,
          working: workingDocumentFromYDoc(database, request.roomName, candidate),
          actor: request.actor,
          summary: request.summary,
          idempotency,
          normalizationRemaps: normalized?.repairs,
        });
        committedDocument = candidate;
        return committed;
      }).immediate();
      if (!committedDocument) {
        throw new DocumentServiceError(
          "COLLABORATION_UNAVAILABLE",
          "원자적 문서 저장 결과를 공유 초안에 반영하지 못했습니다.",
        );
      }
      Y.applyUpdate(document, Y.encodeStateAsUpdate(committedDocument), {
        context: { actor: request.actor, recordedByEndpoint: true },
      });
      broadcastCanonicalCommit(document, response, request.actor);
      return response;
    });
    return observeDraftMutation(response, response.workingDocument, false);
  }

  async function moveWorkingDocumentTree(
    request: MoveWorkingDocumentTreeRequest,
  ): Promise<MoveWorkingDocumentTreeResponse> {
    const state = loadCollaborationStateByRoom(database, request.roomName);
    const idempotency = prepareCollaborationIdempotency({
      workspaceId: state.workspaceId,
      documentId: state.documentId,
      actor: request.actor,
      operation: "move_document_tree",
      requestId: request.requestId,
      payload: request,
    });
    const replayed = replayCollaborationRequest<MoveWorkingDocumentTreeResponse>(
      database,
      idempotency,
    );
    if (replayed) {
      return provider.withDocument(request.roomName, (document) =>
        observeDraftMutation(
          replayed,
          workingDocumentFromYDoc(database, request.roomName, document),
          true,
        ));
    }

    const response = await provider.withDocument(request.roomName, (document) => {
      let movedDocument: Y.Doc | null = null;
      const moved = database.transaction(() => {
        const processWorking = workingDocumentFromYDoc(database, request.roomName, document);
        assertDocumentMediaAssetsBelongToWorkspace(
          database,
          processWorking.workspaceId,
          processWorking.content,
        );
        const authoritative = loadAuthoritativeDraft(request.roomName);
        const before = authoritative.working;
        assertDestructiveCas(before, request);
        assertProcessDraftMatchesAuthoritative(
          processWorking,
          before,
          "DRAFT_VERSION_CONFLICT",
        );
        const canonical = assertCanonicalBase(before);
        const target = getDocument(
          database,
          before.workspaceId,
          request.targetDocumentId,
        );
        const destinationParentDocumentId = request.position === "inside"
          ? target.id
          : target.parentDocumentId;
        if (before.parentDocumentId === destinationParentDocumentId) {
          throw new DocumentServiceError(
            "INVALID_INPUT",
            "같은 상위 문서 안의 순서 변경에는 구조 초안 재배치가 필요하지 않습니다.",
          );
        }
        requireDraftMoveAuthorization(before, destinationParentDocumentId, request.actor);

        const candidate = authoritative.document;
        replaceWorkingDocument(candidate, {
          parentDocumentId: destinationParentDocumentId,
        }, {
          context: { actor: request.actor, recordedByEndpoint: true },
        });

        const canonicalMove = updateDocument(
          database,
          before.workspaceId,
          documentActorFromDraftActor(request.actor),
          before.documentId,
          {
            baseRevision: canonical.revisionNumber,
            parentDocumentId: destinationParentDocumentId,
            summary: request.summary,
          },
        );
        rebaseCollaborationStateAfterCanonicalMetadataCommit(
          database,
          request.roomName,
          candidate,
          canonicalMove.document,
          request.actor,
          request,
        );
        const tree = reorderDocumentTree(
          database,
          before.workspaceId,
          documentActorFromDraftActor(request.actor),
          before.documentId,
          {
            targetDocumentId: request.targetDocumentId,
            position: request.position,
          },
        );
        const value: MoveWorkingDocumentTreeResponse = {
          ...canonicalMove,
          document: getDocument(database, before.workspaceId, before.documentId),
          tree,
          workingDocument: workingDocumentFromYDoc(
            database,
            request.roomName,
            candidate,
          ),
        };
        recordCollaborationRequest(database, idempotency, value);
        movedDocument = candidate;
        return value;
      }).immediate();

      if (!movedDocument) {
        throw new DocumentServiceError(
          "COLLABORATION_UNAVAILABLE",
          "문서 이동 결과를 공유 초안에 반영하지 못했습니다.",
        );
      }
      const candidateDelta = Y.encodeStateAsUpdate(
        movedDocument,
        Y.encodeStateVector(document),
      );
      Y.applyUpdate(document, candidateDelta, {
        context: { actor: request.actor, recordedByEndpoint: true },
      });
      broadcastCanonicalCommit(document, moved, request.actor);
      broadcastDraftStatus(provider, document, moved.workingDocument);
      return moved;
    });
    return observeDraftMutation(response, response.workingDocument, false);
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
    if (replayed) {
      return provider.withDocument(request.roomName, (document) =>
        observeDraftMutation(
          replayed,
          workingDocumentFromYDoc(database, request.roomName, document),
          true,
        ));
    }

    const response = await provider.withDocument(request.roomName, (document) => {
      let persistedDocument: Y.Doc | null = null;
      const mutation = database.transaction(() => {
        const processWorking = workingDocumentFromYDoc(database, request.roomName, document);
        assertDocumentMediaAssetsBelongToWorkspace(
          database,
          processWorking.workspaceId,
          processWorking.content,
        );
        const authoritative = loadAuthoritativeDraft(request.roomName);
        const before = authoritative.working;
        assertExpectedDraftVersion(before, request.expectedDraftVersion);
        assertProcessDraftMatchesAuthoritative(
          processWorking,
          before,
          "DRAFT_CONFLICT",
        );
        requireCurrentCollaborationAuthorization(
          database,
          before.workspaceId,
          before.documentId,
          request.actor,
          "draft.update",
        );
        const patchedContent = applyDocumentPatch(before.content, request.operations);
        assertDocumentTitleIsNotLeadingH1(before.title, patchedContent);
        const normalized = normalizeTopLevelBlockIds(
          database,
          state.documentId,
          patchedContent,
        );
        assertDocumentMediaAssetsBelongToWorkspace(
          database,
          state.workspaceId,
          normalized.content,
        );
        const candidate = authoritative.document;
        replaceWorkingDocument(candidate, { content: normalized.content }, {
          context: { actor: request.actor, recordedByEndpoint: true },
        });
        persistCollaborationUpdate(database, request.roomName, candidate, request.actor);
        const workingDocument = workingDocumentFromYDoc(database, request.roomName, candidate);
        const normalization = blockIdNormalization(normalized.repairs);
        const value = {
          workingDocument,
          ...(normalization ? { normalization } : {}),
        };
        recordCollaborationRequest(database, idempotency, value);
        persistedDocument = candidate;
        return value;
      }).immediate();
      if (!persistedDocument) {
        throw new DocumentServiceError(
          "COLLABORATION_UNAVAILABLE",
          "공유 초안 변경 결과를 협업 문서에 반영하지 못했습니다.",
        );
      }
      const candidateDelta = Y.encodeStateAsUpdate(
        persistedDocument,
        Y.encodeStateVector(document),
      );
      Y.applyUpdate(document, candidateDelta, {
        context: { actor: request.actor, recordedByEndpoint: true },
      });
      broadcastDraftStatus(provider, document, mutation.workingDocument);
      return mutation;
    });
    return observeDraftMutation(response, response.workingDocument, false);
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
    if (replayed) {
      return provider.withDocument(request.roomName, (document) =>
        observeDraftMutation(
          replayed,
          workingDocumentFromYDoc(database, request.roomName, document),
          true,
        ));
    }

    const response = await provider.withDocument(request.roomName, (document) => {
      let committedDocument: Y.Doc | null = null;
      const committed = database.transaction(() => {
        const processWorking = workingDocumentFromYDoc(database, request.roomName, document);
        assertDocumentMediaAssetsBelongToWorkspace(
          database,
          processWorking.workspaceId,
          processWorking.content,
        );
        assertCommitSynchronizationFence(
          document,
          processWorking,
          request.synchronizationFence,
        );

        // Bind the optimistic version and immutable snapshot to the same
        // locked database state. A process-local room may lag another server,
        // so it is used only as a synchronization check, never as commit input.
        const authoritative = loadAuthoritativeDraft(request.roomName);
        const working = authoritative.working;
        assertExpectedDraftVersion(
          working,
          request.expectedDraftVersion,
          "DRAFT_VERSION_CONFLICT",
        );
        assertProcessDraftMatchesAuthoritative(
          processWorking,
          working,
          request.synchronizationFence ? "DRAFT_NOT_SYNCED" : "DRAFT_VERSION_CONFLICT",
        );
        assertCommitSynchronizationFence(
          authoritative.document,
          working,
          request.synchronizationFence,
        );
        const value = commitLoadedDocumentInTransaction({
          document: authoritative.document,
          working,
          actor: request.actor,
          summary: request.summary,
          idempotency,
        });
        committedDocument = authoritative.document;
        return value;
      }).immediate();
      if (!committedDocument) {
        throw new DocumentServiceError(
          "COLLABORATION_UNAVAILABLE",
          "원자적 문서 저장 결과를 공유 초안에 반영하지 못했습니다.",
        );
      }
      Y.applyUpdate(document, Y.encodeStateAsUpdate(committedDocument), {
        context: { actor: request.actor, recordedByEndpoint: true },
      });
      broadcastCanonicalCommit(document, committed, request.actor);
      return committed;
    });
    return observeDraftMutation(response, response.workingDocument, false);
  }

  async function resetWorking(
    request: ResetWorkingDocumentRequest,
  ): Promise<ResetWorkingDocumentResponse> {
    if (request.actor.type === "human" && request.requestId === undefined) {
      throw new DocumentServiceError(
        "INVALID_INPUT",
        "복원 또는 초안 폐기 요청에는 안정적인 requestId가 필요합니다.",
      );
    }
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
    if (replayed) {
      return provider.withDocument(currentState.roomName, (document) =>
        observeDraftMutation(
          replayed,
          workingDocumentFromYDoc(database, currentState.roomName, document),
          true,
        ));
    }
    const response = await provider.withDocument(currentState.roomName, (document) => {
      return database.transaction(() => {
        const processWorking = workingDocumentFromYDoc(
          database,
          currentState.roomName,
          document,
        );
        const authoritative = loadAuthoritativeDraft(currentState.roomName);
        requireCurrentCollaborationAuthorization(
          database,
          authoritative.working.workspaceId,
          authoritative.working.documentId,
          request.actor,
          request.revisionId ? "draft.restore" : "draft.update",
        );
        assertDestructiveCas(authoritative.working, request);
        assertProcessDraftMatchesAuthoritative(
          processWorking,
          authoritative.working,
          "DRAFT_VERSION_CONFLICT",
        );
        const source = request.revisionId
          ? getDocumentRevisionSnapshot(database, request.workspaceId, request.documentId, request.revisionId)
          : getDocument(database, request.workspaceId, request.documentId);
        assertReplacementSnapshotAuthorized({
          database,
          workspaceId: request.workspaceId,
          actor: request.actor,
          content: source.content,
        });
        const roomName = resetCollaborationState(
          database,
          request.workspaceId,
          request.documentId,
          source,
          request.revisionId
            ? {
                markDirty: true,
                actor: { ...request.actor, source: "rollback" },
                cas: request,
              }
            : { markDirty: false, cas: request },
        );
        const value = {
          roomName,
          workingDocument: workingDocumentFromStoredState(
            database,
            request.workspaceId,
            request.documentId,
          ),
        };
        recordCollaborationRequest(database, idempotency, value);
        return value;
      }).immediate();
    });
    await provider.closeConnections(currentState.roomName);
    return observeDraftMutation(response, response.workingDocument, false);
  }

  async function archiveWorkingTree(
    request: ArchiveWorkingTreeRequest,
  ): Promise<ArchiveWorkingTreeResponse> {
    const subtreeDocumentIds = getActiveSubtreeDocumentIds(
      database,
      request.workspaceId,
      request.documentId,
    );
    if (subtreeDocumentIds.length === 0) {
      throw new DocumentServiceError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }
    const rooms = subtreeDocumentIds.map((id) =>
      ensureCollaborationState(database, request.workspaceId, id).roomName);
    const opened: Array<{ roomName: string; document: Y.Doc }> = [];

    async function openAll(index: number): Promise<void> {
      if (index >= rooms.length) return;
      const roomName = rooms[index]!;
      return provider.withDocument(roomName, async (document) => {
        opened.push({ roomName, document });
        await openAll(index + 1);
      });
    }

    let operationFailed = false;
    try {
      // Let every direct provider callback unwind while the documents are
      // still active. Hocuspocus stores on direct disconnect; archiving inside
      // the callback would make that final store target an archived document.
      await openAll(0);
      return database.transaction(() => {
        // Opening every room is asynchronous and must not grant a permission
        // lease. Resolve the current actor again while holding the same write
        // lock that protects the draft flush and subtree archive.
        requireCurrentArchiveAuthorization(database, request);

        // Room discovery and provider loading happen before the write lock.
        // Refuse to archive if a concurrent tree move changed the exact
        // subtree: every document that will be archived must have had its
        // live Y.Doc opened and included in this atomic flush.
        const currentSubtreeDocumentIds = getActiveSubtreeDocumentIds(
          database,
          request.workspaceId,
          request.documentId,
        );
        if (
          currentSubtreeDocumentIds.length !== subtreeDocumentIds.length
          || currentSubtreeDocumentIds.some(
            (documentId, index) => documentId !== subtreeDocumentIds[index],
          )
        ) {
          throw new DocumentServiceError(
            "DRAFT_CONFLICT",
            "문서 구조가 변경되었습니다. 최신 문서 트리를 다시 읽고 휴지통 이동을 재시도해주세요.",
            {
              expectedDocumentIds: subtreeDocumentIds,
              currentDocumentIds: currentSubtreeDocumentIds,
            },
          );
        }

        // There is no asynchronous boundary from this projection through the
        // generation seal. Persist isolated snapshots so any later failure
        // rolls every draft back without mutating the provider-owned Y.Docs.
        const candidates = opened.map((room) => ({
          roomName: room.roomName,
          document: collaborationYDocFromState(Y.encodeStateAsUpdate(room.document)),
        }));
        for (const room of candidates) {
          const working = workingDocumentFromYDoc(database, room.roomName, room.document);
          assertDocumentMediaAssetsBelongToWorkspace(
            database,
            working.workspaceId,
            working.content,
          );
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
      }).immediate();
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      // A provider can fail before invoking its callback, so close only rooms
      // that were actually handed to this command. Attempt every cleanup and
      // preserve the primary open/authorization/flush/archive error.
      const openedRoomNames = [...new Set(opened.map((room) => room.roomName))];
      const cleanup = await Promise.allSettled(openedRoomNames.map(async (roomName) => {
        await provider.closeConnections(roomName);
      }));
      if (!operationFailed) {
        const cleanupFailure = cleanup.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (cleanupFailure) throw cleanupFailure.reason;
      }
    }
  }

  return {
    readWorking,
    replaceWorking,
    replaceAndCommitWorking,
    moveWorkingDocumentTree,
    patchWorking,
    commitWorking,
    resetWorking,
    archiveWorkingTree,
  };
}
