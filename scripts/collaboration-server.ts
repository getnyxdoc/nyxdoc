import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Unauthorized } from "@hocuspocus/common";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import {
  WORKSPACE_PERMISSIONS,
  agentPrincipalAllows,
  getHumanDocumentPrincipal,
  humanDocumentPrincipalAllows,
} from "@/lib/authz/permissions";
import {
  loadCollaborationStateByRoom,
  parseCollaborationRoomName,
  persistCollaborationUpdate,
  persistCollaborationYDoc,
  repairCollaborationYDocNodeIds,
  type DraftActor,
} from "@/lib/collaboration/drafts";
import { createCollaborationCommands } from "@/lib/collaboration/commands";
import type {
  ArchiveWorkingTreeRequest,
  CommitWorkingDocumentRequest,
  PatchWorkingDocumentRequest,
  ReadWorkingDocumentRequest,
  ReplaceAndCommitWorkingDocumentRequest,
  ReplaceWorkingDocumentRequest,
  ResetWorkingDocumentRequest,
} from "@/lib/collaboration/protocol";
import {
  assertCollaborationTokenFresh,
  collaborationTokenExpiryDelay,
  verifyCollaborationToken,
  type CollaborationTokenClaims,
} from "@/lib/collaboration/token";
import {
  assertRuntimeConfiguration,
  getCollaborationPort,
  getCollaborationSecret,
} from "@/lib/config";
import { sqlite } from "@/lib/db/client";
import {
  documentPatchOperationSchema,
} from "@/lib/documents/schemas";
import { getDocument } from "@/lib/documents/service";
import {
  DocumentServiceError,
  type DocumentPatchOperation,
  type DocumentServiceErrorCode,
} from "@/lib/documents/types";
import { nyxdocDocumentV2Schema } from "@/lib/editor/schema";

type ConnectionContext = {
  actor?: DraftActor;
  claims?: CollaborationTokenClaims;
  expirationTimer?: ReturnType<typeof setTimeout>;
  recordedByEndpoint?: boolean;
};

type AgentCredentialRow = {
  scopes_json: string;
  root_document_id: string | null;
  capabilities_json: string;
};

function permissionList(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is (typeof WORKSPACE_PERMISSIONS)[number] =>
        typeof item === "string" && WORKSPACE_PERMISSIONS.includes(item as (typeof WORKSPACE_PERMISSIONS)[number]))
      : [];
  } catch {
    return [];
  }
}

const MAX_INTERNAL_BODY_BYTES = 12 * 1024 * 1024;
const requestFailureContext = new WeakMap<object, Record<string, unknown>>();

function diagnosticIdentifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value)
    ? value
    : undefined;
}

function internalRequestContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const actor = input.actor && typeof input.actor === "object" && !Array.isArray(input.actor)
    ? input.actor as Record<string, unknown>
    : null;
  const replacement = input.replacement && typeof input.replacement === "object" && !Array.isArray(input.replacement)
    ? input.replacement as Record<string, unknown>
    : null;
  const operations = Array.isArray(input.operations)
    ? input.operations.slice(0, 100).map((operation) => (
        operation && typeof operation === "object" && !Array.isArray(operation)
          ? diagnosticIdentifier((operation as Record<string, unknown>).op)
          : undefined
      )).filter(Boolean)
    : [];
  return {
    roomName: diagnosticIdentifier(input.roomName),
    workspaceId: diagnosticIdentifier(input.workspaceId),
    documentId: diagnosticIdentifier(input.documentId),
    requestId: diagnosticIdentifier(input.requestId),
    expectedDraftVersion: Number.isInteger(input.expectedDraftVersion)
      ? input.expectedDraftVersion
      : undefined,
    expectedGeneration: Number.isInteger(input.expectedGeneration)
      ? input.expectedGeneration
      : undefined,
    expectedBaseRevision: Number.isInteger(input.expectedBaseRevision)
      ? input.expectedBaseRevision
      : undefined,
    actorType: diagnosticIdentifier(actor?.type),
    actorSource: diagnosticIdentifier(actor?.source),
    actorPrincipalId: diagnosticIdentifier(actor?.principalId ?? actor?.userId),
    replacementFields: replacement
      ? Object.keys(replacement).filter((key) => [
          "title",
          "parentDocumentId",
          "documentType",
          "workflowStatus",
          "tags",
          "content",
        ].includes(key))
      : undefined,
    operationCount: operations.length || undefined,
    operationTypes: operations.length ? operations : undefined,
  };
}

function errorIssueSummary(error: unknown) {
  if (!(error instanceof DocumentServiceError) || !Array.isArray(error.details?.issues)) {
    return undefined;
  }
  return error.details.issues.slice(0, 20).flatMap((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
    const record = issue as Record<string, unknown>;
    return [{
      code: diagnosticIdentifier(record.code) ?? "validation",
      path: Array.isArray(record.path)
        ? record.path.slice(0, 20).map((part) => String(part).slice(0, 80))
        : [],
      message: typeof record.message === "string"
        ? record.message.slice(0, 240)
        : "문서 스키마 검증 실패",
    }];
  });
}

function logCollaborationFailure(
  error: unknown,
  request: IncomingMessage,
  path: string,
) {
  const storedContext = error && typeof error === "object"
    ? requestFailureContext.get(error)
    : undefined;
  console.warn("[collaboration-diagnostic]", JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "request_failed",
    method: request.method ?? "UNKNOWN",
    path,
    status: statusForError(error),
    code: errorCode(error),
    message: error instanceof Error ? error.message.slice(0, 240) : "협업 서버 오류",
    issues: errorIssueSummary(error),
    ...storedContext,
  }));
}

function logNodeIdRepairs(
  documentName: string,
  source: "load" | "change" | "store",
  repairs: ReturnType<typeof repairCollaborationYDocNodeIds>,
) {
  if (repairs.length === 0) return;
  let room: ReturnType<typeof parseCollaborationRoomName> | null = null;
  try {
    room = parseCollaborationRoomName(documentName);
  } catch {
    // Invalid room names are reported by the normal request path.
  }
  console.warn("[editor-diagnostic]", JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "node_ids_repaired",
    source,
    workspaceId: room?.workspaceId,
    documentId: room?.documentId,
    generation: room?.generation,
    repairCount: repairs.length,
    missingCount: repairs.filter((repair) => repair.reason === "missing").length,
    duplicateCount: repairs.filter((repair) => repair.reason === "duplicate").length,
    paths: repairs.slice(0, 20).map((repair) => repair.path.join(".")),
  }));
}

function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requireInternalAuthentication(request: IncomingMessage) {
  const supplied = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!constantTimeEquals(supplied, getCollaborationSecret())) {
    throw new DocumentServiceError("FORBIDDEN", "내부 협업 서버 인증에 실패했습니다.");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_INTERNAL_BODY_BYTES) {
      throw new DocumentServiceError("INVALID_INPUT", "공유 초안 요청이 너무 큽니다.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안 요청 JSON을 읽을 수 없습니다.");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안 요청 형식이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DocumentServiceError("INVALID_INPUT", `${field} 값이 필요합니다.`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new DocumentServiceError("INVALID_INPUT", `${field} 값이 올바르지 않습니다.`);
  }
  return Number(value);
}

function parseDraftActor(value: unknown): DraftActor {
  const actor = requireRecord(value);
  const type = actor.type;
  const source = actor.source;
  if (type !== "human" && type !== "agent" && type !== "system") {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안 작업자 유형이 올바르지 않습니다.");
  }
  if (!source || !["web", "mcp", "api", "rollback", "migration", "seed"].includes(String(source))) {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안 작업 출처가 올바르지 않습니다.");
  }
  return {
    type,
    userId: typeof actor.userId === "string" ? actor.userId : null,
    tokenId: typeof actor.tokenId === "string" ? actor.tokenId : null,
    principalId: typeof actor.principalId === "string" ? actor.principalId : null,
    label: requireString(actor.label, "actor.label"),
    avatarMediaId: typeof actor.avatarMediaId === "string" ? actor.avatarMediaId : null,
    source: source as DraftActor["source"],
  };
}

function assertAgentDocumentScope(workspaceId: string, documentId: string, rootDocumentId: string | null) {
  if (!rootDocumentId) return;
  const allowed = sqlite.prepare(
    `WITH RECURSIVE ancestors(id, parent_document_id) AS (
       SELECT id, parent_document_id FROM documents
       WHERE workspace_id = ? AND id = ? AND status = 'active'
       UNION ALL
       SELECT document.id, document.parent_document_id
       FROM documents document
       JOIN ancestors ON document.id = ancestors.parent_document_id
       WHERE document.workspace_id = ? AND document.status = 'active'
     )
     SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
  ).get(workspaceId, documentId, workspaceId, rootDocumentId);
  if (!allowed) throw new DocumentServiceError("FORBIDDEN", "이 연결의 허용 문서 범위를 벗어났습니다.");
}

function validateWebSocketClaims(token: string, documentName: string) {
  let claims;
  try {
    claims = verifyCollaborationToken(token);
  } catch (error) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      error instanceof Error ? error.message : "협업 토큰을 확인하지 못했습니다.",
    );
  }
  if (claims.roomName !== documentName) {
    throw new DocumentServiceError("FORBIDDEN", "협업 토큰과 문서 방이 일치하지 않습니다.");
  }
  const state = loadCollaborationStateByRoom(sqlite, documentName);
  if (
    state.workspaceId !== claims.workspaceId
    || state.documentId !== claims.documentId
    || state.generation !== claims.generation
  ) {
    throw new DocumentServiceError("FORBIDDEN", "협업 토큰의 문서 범위가 일치하지 않습니다.");
  }
  getDocument(sqlite, claims.workspaceId, claims.documentId);

  if (claims.actor.type === "human") {
    const userId = claims.actor.userId;
    if (!userId) throw new DocumentServiceError("FORBIDDEN", "사용자 식별자가 없습니다.");
    const principal = getHumanDocumentPrincipal(
      sqlite,
      claims.workspaceId,
      claims.documentId,
      userId,
    );
    if (!principal || !humanDocumentPrincipalAllows(principal, "documents.read")) {
      throw new DocumentServiceError("FORBIDDEN", "이 문서를 읽을 권한이 없습니다.");
    }
    const writeAllowed = humanDocumentPrincipalAllows(principal, "documents.update");
    const commitAllowed = humanDocumentPrincipalAllows(principal, "documents.commit");
    if (claims.permissions.write && !writeAllowed) {
      throw new DocumentServiceError("FORBIDDEN", "이 문서의 공유 초안을 편집할 권한이 없습니다.");
    }
    if (claims.permissions.commit && !commitAllowed) {
      throw new DocumentServiceError("FORBIDDEN", "이 문서의 정본을 저장할 권한이 없습니다.");
    }
    return { claims, readOnly: !claims.permissions.write };
  }

  if (claims.actor.type === "agent") {
    const row = sqlite.prepare(
      `SELECT credential.scopes_json, membership.root_document_id,
              membership.capabilities_json
       FROM agent_credentials credential
       JOIN agents agent ON agent.id = credential.agent_id
       JOIN workspace_agents membership
         ON membership.agent_identity_id = credential.agent_id
        AND membership.workspace_id = ?
       JOIN agent_credential_grant_bindings binding
         ON binding.credential_id = credential.id
        AND binding.grant_id = membership.id
        AND binding.status = 'active' AND binding.revoked_at IS NULL
       JOIN workspaces workspace ON workspace.id = membership.workspace_id
       WHERE credential.id = ? AND credential.agent_id = ?
         AND credential.revoked_at IS NULL AND membership.status = 'active'
         AND membership.revoked_at IS NULL
         AND agent.status = 'active' AND agent.deleted_at IS NULL AND agent.purged_at IS NULL
         AND workspace.lifecycle_state = 'active'
         AND (credential.expires_at IS NULL OR credential.expires_at > ?)`,
    ).get(
      claims.workspaceId,
      claims.actor.tokenId,
      claims.actor.principalId,
      new Date().toISOString(),
    ) as AgentCredentialRow | undefined;
    if (!row) throw new DocumentServiceError("FORBIDDEN", "에이전트 연결이 만료되었거나 폐기되었습니다.");
    const scopes = JSON.parse(row.scopes_json) as unknown;
    if (!Array.isArray(scopes) || !scopes.includes("documents:read")) {
      throw new DocumentServiceError("FORBIDDEN", "에이전트에 문서 읽기 권한이 없습니다.");
    }
    assertAgentDocumentScope(claims.workspaceId, claims.documentId, row.root_document_id);
    const principal = { capabilities: permissionList(row.capabilities_json) };
    const writeAllowed = scopes.includes("documents:write") && agentPrincipalAllows(principal, "documents.update");
    const commitAllowed = scopes.includes("documents:commit") && agentPrincipalAllows(principal, "documents.commit");
    if (claims.permissions.write && !writeAllowed) {
      throw new DocumentServiceError("FORBIDDEN", "에이전트에 공유 초안 쓰기 권한이 없습니다.");
    }
    if (claims.permissions.commit && !commitAllowed) {
      throw new DocumentServiceError("FORBIDDEN", "에이전트에 정본 저장 권한이 없습니다.");
    }
    return { claims, readOnly: !claims.permissions.write };
  }

  throw new DocumentServiceError("FORBIDDEN", "시스템 작업자는 브라우저 협업 연결을 열 수 없습니다.");
}

function statusForError(error: unknown) {
  if (!(error instanceof DocumentServiceError)) return 500;
  if (error.code === "FORBIDDEN") return 403;
  if (error.code === "NOT_FOUND") return 404;
  if (
    error.code === "DRAFT_CONFLICT"
    || error.code === "DRAFT_NOT_SYNCED"
    || error.code === "DRAFT_VERSION_CONFLICT"
    || error.code === "REVISION_CONFLICT"
    || error.code === "IDEMPOTENCY_CONFLICT"
  ) return 409;
  if (error.code === "COLLABORATION_UNAVAILABLE") return 503;
  return 400;
}

function errorCode(error: unknown): DocumentServiceErrorCode | "INTERNAL_ERROR" {
  return error instanceof DocumentServiceError ? error.code : "INTERNAL_ERROR";
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function parseReadRequest(value: unknown): ReadWorkingDocumentRequest {
  const input = requireRecord(value);
  return {
    workspaceId: requireString(input.workspaceId, "workspaceId"),
    documentId: requireString(input.documentId, "documentId"),
  };
}

function parseReplaceRequest(value: unknown): ReplaceWorkingDocumentRequest {
  const input = requireRecord(value);
  const replacement = requireRecord(input.replacement);
  let content;
  if (replacement.content !== undefined) {
    const parsed = nyxdocDocumentV2Schema.safeParse(replacement.content);
    if (!parsed.success) {
      throw new DocumentServiceError(
        "INVALID_INPUT",
        "공유 초안 본문 형식이 올바르지 않습니다.",
        {
          issues: parsed.error.issues.slice(0, 20).map((issue) => ({
            code: issue.code,
            path: issue.path.map(String),
            message: issue.message,
          })),
        },
      );
    }
    content = parsed.data;
  }
  const parsedReplacement: ReplaceWorkingDocumentRequest["replacement"] = {
    title: typeof replacement.title === "string" ? replacement.title : undefined,
    parentDocumentId: replacement.parentDocumentId === null || typeof replacement.parentDocumentId === "string"
      ? replacement.parentDocumentId
      : undefined,
    documentType: replacement.documentType === null || typeof replacement.documentType === "string"
      ? replacement.documentType
      : undefined,
    workflowStatus: replacement.workflowStatus === "draft"
      || replacement.workflowStatus === "review"
      || replacement.workflowStatus === "final"
      ? replacement.workflowStatus
      : undefined,
    tags: Array.isArray(replacement.tags) && replacement.tags.every((tag) => typeof tag === "string")
      ? replacement.tags as string[]
      : undefined,
    content,
  };
  if (Object.values(parsedReplacement).every((field) => field === undefined)) {
    throw new DocumentServiceError("INVALID_INPUT", "공유 초안에서 바꿀 필드가 필요합니다.");
  }
  if (parsedReplacement.title !== undefined && !parsedReplacement.title.trim()) {
    throw new DocumentServiceError("INVALID_INPUT", "문서 제목은 비워둘 수 없습니다.");
  }
  return {
    roomName: requireString(input.roomName, "roomName"),
    actor: parseDraftActor(input.actor),
    expectedDraftVersion: optionalInteger(input.expectedDraftVersion, "expectedDraftVersion"),
    requestId: typeof input.requestId === "string" ? input.requestId : undefined,
    replacement: parsedReplacement,
  };
}

function parseReplaceAndCommitRequest(value: unknown): ReplaceAndCommitWorkingDocumentRequest {
  const input = requireRecord(value);
  return {
    ...parseReplaceRequest(value),
    summary: typeof input.summary === "string" ? input.summary : undefined,
    idempotencyDraftVersion: optionalInteger(input.idempotencyDraftVersion, "idempotencyDraftVersion"),
  };
}

function parsePatchOperations(value: unknown): DocumentPatchOperation[] {
  const parsed = documentPatchOperationSchema.array().min(1).max(100).safeParse(value);
  if (!parsed.success) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "patch 연산 형식이 올바르지 않습니다.",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function parsePatchRequest(value: unknown): PatchWorkingDocumentRequest {
  const input = requireRecord(value);
  return {
    roomName: requireString(input.roomName, "roomName"),
    actor: parseDraftActor(input.actor),
    expectedDraftVersion: optionalInteger(input.expectedDraftVersion, "expectedDraftVersion")
      ?? (() => { throw new DocumentServiceError("INVALID_INPUT", "expectedDraftVersion 값이 필요합니다."); })(),
    requestId: requireString(input.requestId, "requestId"),
    operations: parsePatchOperations(input.operations),
  };
}

function parseCommitRequest(value: unknown): CommitWorkingDocumentRequest {
  const input = requireRecord(value);
  const synchronizationFence = input.synchronizationFence === undefined
    ? undefined
    : (() => {
        const fence = requireRecord(input.synchronizationFence);
        return {
          generation: optionalInteger(fence.generation, "synchronizationFence.generation")
            ?? (() => {
              throw new DocumentServiceError(
                "INVALID_INPUT",
                "synchronizationFence.generation 값이 필요합니다.",
              );
            })(),
          stateVector: requireString(
            fence.stateVector,
            "synchronizationFence.stateVector",
          ),
        };
      })();
  return {
    roomName: requireString(input.roomName, "roomName"),
    actor: parseDraftActor(input.actor),
    expectedDraftVersion: optionalInteger(input.expectedDraftVersion, "expectedDraftVersion")
      ?? (() => {
        throw new DocumentServiceError(
          "INVALID_INPUT",
          "expectedDraftVersion 값이 필요합니다.",
        );
      })(),
    synchronizationFence,
    requestId: typeof input.requestId === "string" ? input.requestId : undefined,
    summary: typeof input.summary === "string" ? input.summary : undefined,
  };
}

function parseResetRequest(value: unknown): ResetWorkingDocumentRequest {
  const input = requireRecord(value);
  return {
    workspaceId: requireString(input.workspaceId, "workspaceId"),
    documentId: requireString(input.documentId, "documentId"),
    expectedGeneration: optionalInteger(input.expectedGeneration, "expectedGeneration")
      ?? (() => {
        throw new DocumentServiceError("INVALID_INPUT", "expectedGeneration 값이 필요합니다.");
      })(),
    expectedDraftVersion: optionalInteger(input.expectedDraftVersion, "expectedDraftVersion")
      ?? (() => {
        throw new DocumentServiceError("INVALID_INPUT", "expectedDraftVersion 값이 필요합니다.");
      })(),
    expectedBaseRevision: optionalInteger(input.expectedBaseRevision, "expectedBaseRevision")
      ?? (() => {
        throw new DocumentServiceError("INVALID_INPUT", "expectedBaseRevision 값이 필요합니다.");
      })(),
    actor: parseDraftActor(input.actor),
    revisionId: typeof input.revisionId === "string" ? input.revisionId : undefined,
    requestId: typeof input.requestId === "string" ? input.requestId : undefined,
  };
}

function parseArchiveRequest(value: unknown): ArchiveWorkingTreeRequest {
  const input = requireRecord(value);
  return {
    workspaceId: requireString(input.workspaceId, "workspaceId"),
    documentId: requireString(input.documentId, "documentId"),
    actor: parseDraftActor(input.actor),
    baseRevision: optionalInteger(input.baseRevision, "baseRevision")
      ?? (() => {
        throw new DocumentServiceError("INVALID_INPUT", "baseRevision 값이 필요합니다.");
      })(),
    createdByAgentId: typeof input.createdByAgentId === "string"
      ? input.createdByAgentId
      : undefined,
  };
}

const hocuspocus = new Hocuspocus({
  name: "nyxdoc-collaboration",
  debounce: 400,
  maxDebounce: 1_500,
  timeout: 30_000,
  unloadImmediately: true,
  async onAuthenticate({ token, documentName, connectionConfig }) {
    const { claims, readOnly } = validateWebSocketClaims(token, documentName);
    connectionConfig.readOnly = readOnly;
    return { actor: claims.actor, claims } satisfies ConnectionContext;
  },
  async connected({ connection, context }) {
    const connectionContext = context as ConnectionContext;
    if (!connectionContext.claims) return;
    const delay = collaborationTokenExpiryDelay(connectionContext.claims);
    if (delay <= 0) {
      connection.close(Unauthorized);
      return;
    }
    connectionContext.expirationTimer = setTimeout(() => {
      connection.close({
        ...Unauthorized,
        reason: "Collaboration token expired",
      });
    }, delay);
  },
  async beforeHandleMessage({ connection, context }) {
    const connectionContext = context as ConnectionContext;
    if (!connectionContext.claims) return;
    try {
      assertCollaborationTokenFresh(connectionContext.claims);
    } catch {
      connection.close({
        ...Unauthorized,
        reason: "Collaboration token expired",
      });
      throw {
        ...Unauthorized,
        reason: "Collaboration token expired",
      };
    }
  },
  async onLoadDocument({ documentName, document }) {
    const state = loadCollaborationStateByRoom(sqlite, documentName);
    Y.applyUpdate(document, state.state, "nyxdoc-database-load");
    logNodeIdRepairs(
      documentName,
      "load",
      repairCollaborationYDocNodeIds(document),
    );
  },
  async onChange({ documentName, document, context }) {
    const connectionContext = context as ConnectionContext;
    if (!connectionContext.actor || connectionContext.recordedByEndpoint) return;
    if (connectionContext.claims) {
      assertCollaborationTokenFresh(connectionContext.claims);
    }
    logNodeIdRepairs(
      documentName,
      "change",
      repairCollaborationYDocNodeIds(document),
    );
    const state = persistCollaborationUpdate(
      sqlite,
      documentName,
      document,
      connectionContext.actor,
    );
    const hocuspocusDocument = document as Y.Doc & {
      broadcastStateless?: (value: string) => void;
    };
    hocuspocusDocument.broadcastStateless?.(JSON.stringify({
      type: "draft-status",
      documentId: state.documentId,
      draftVersion: state.draftVersion,
      hasUncommittedChanges: state.hasUncommittedChanges,
    }));
  },
  async onStoreDocument({ documentName, document }) {
    logNodeIdRepairs(
      documentName,
      "store",
      repairCollaborationYDocNodeIds(document),
    );
    persistCollaborationYDoc(sqlite, documentName, document);
  },
  async onDisconnect({ context }) {
    const connectionContext = context as ConnectionContext;
    if (connectionContext.expirationTimer) {
      clearTimeout(connectionContext.expirationTimer);
      connectionContext.expirationTimer = undefined;
    }
  },
});

async function withDirectDocument<T>(
  roomName: string,
  callback: (document: Y.Doc) => Promise<T> | T,
) {
  const connection = await hocuspocus.openDirectConnection(roomName, { internal: true });
  try {
    if (!connection.document) throw new DocumentServiceError("NOT_FOUND", "공유 초안을 열지 못했습니다.");
    return await callback(connection.document);
  } finally {
    await connection.disconnect();
  }
}

const collaborationCommands = createCollaborationCommands({
  database: sqlite,
  provider: {
    withDocument: withDirectDocument,
    closeConnections(roomName) {
      hocuspocus.closeConnections(roomName);
    },
    broadcast(document, payload) {
      const hocuspocusDocument = document as Y.Doc & {
        broadcastStateless?: (value: string) => void;
      };
      hocuspocusDocument.broadcastStateless?.(payload);
    },
  },
});

async function handleInternalRequest(request: IncomingMessage, response: ServerResponse) {
  requireInternalAuthentication(request);
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "POST 요청만 지원합니다.", code: "INVALID_INPUT" });
    return;
  }
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const body = await readJson(request);
  let result;
  try {
    result = path === "/internal/drafts/read"
      ? await collaborationCommands.readWorking(parseReadRequest(body))
      : path === "/internal/drafts/replace"
        ? await collaborationCommands.replaceWorking(parseReplaceRequest(body))
        : path === "/internal/drafts/replace-and-commit"
          ? await collaborationCommands.replaceAndCommitWorking(parseReplaceAndCommitRequest(body))
        : path === "/internal/drafts/patch"
          ? await collaborationCommands.patchWorking(parsePatchRequest(body))
          : path === "/internal/drafts/commit"
            ? await collaborationCommands.commitWorking(parseCommitRequest(body))
            : path === "/internal/drafts/reset"
              ? await collaborationCommands.resetWorking(parseResetRequest(body))
              : path === "/internal/drafts/archive"
                ? await collaborationCommands.archiveWorkingTree(parseArchiveRequest(body))
              : null;
  } catch (error) {
    if (error && typeof error === "object") {
      requestFailureContext.set(error, internalRequestContext(body));
    }
    throw error;
  }
  if (!result) {
    sendJson(response, 404, { error: "협업 서버 경로를 찾을 수 없습니다.", code: "NOT_FOUND" });
    return;
  }
  sendJson(response, 200, result);
}

assertRuntimeConfiguration();

const webSocketServer = new WebSocketServer({ noServer: true });
webSocketServer.on("connection", (socket, request) => {
  socket.on("error", (error) => console.error("[collaboration] websocket error", error));
  hocuspocus.handleConnection(socket, request);
});

const httpServer = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    if (request.method === "GET" && path === "/health") {
      sqlite.prepare("SELECT 1 AS ok").get();
      sendJson(response, 200, {
        status: "ok",
        service: "nyxdoc-collaboration",
        documents: hocuspocus.getDocumentsCount(),
        connections: hocuspocus.getConnectionsCount(),
      });
      return;
    }
    if (path.startsWith("/internal/")) {
      await handleInternalRequest(request, response);
      return;
    }
    sendJson(response, 404, { error: "경로를 찾을 수 없습니다.", code: "NOT_FOUND" });
  } catch (error) {
    logCollaborationFailure(error, request, path);
    sendJson(response, statusForError(error), {
      error: error instanceof Error ? error.message : "협업 서버 오류가 발생했습니다.",
      code: errorCode(error),
      ...(error instanceof DocumentServiceError && error.details ? { details: error.details } : {}),
    });
  }
});

httpServer.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path !== "/" && path !== "/collaboration") {
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

const port = getCollaborationPort();
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`[collaboration] listening on 0.0.0.0:${port}`);
});

async function shutdown(signal: string) {
  console.log(`[collaboration] received ${signal}; shutting down`);
  hocuspocus.closeConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  sqlite.close();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
