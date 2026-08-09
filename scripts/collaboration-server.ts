import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { Forbidden, Unauthorized } from "@hocuspocus/common";
import {
  Hocuspocus,
  IncomingMessage as HocuspocusIncomingMessage,
  MessageType,
} from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import {
  agentPrincipalAllows,
  getHumanDocumentPrincipal,
  humanDocumentPrincipalAllows,
} from "@/lib/authz/permissions";
import { assertWorkspaceAgentGrantCanAccessDocument } from "@/lib/agents/workspace-grant-boundary";
import {
  loadCollaborationStateByRoom,
  parseCollaborationRoomName,
  persistCollaborationUpdate,
  persistCollaborationYDoc,
  repairCollaborationYDocNodeIds,
  workingDocumentFromYDoc,
  type DraftActor,
} from "@/lib/collaboration/drafts";
import { createCollaborationCommands } from "@/lib/collaboration/commands";
import {
  collaborationClientIp,
  normalizedClientIp,
} from "@/lib/collaboration/client-ip";
import type {
  ArchiveWorkingTreeRequest,
  CommitWorkingDocumentRequest,
  MoveWorkingDocumentTreeRequest,
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
import { sqlite, type NyxDatabase } from "@/lib/db/client";
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
import { assertDocumentMediaAssetsBelongToWorkspace } from "@/lib/media/bindings";
import {
  API_TOKEN_SCOPES,
  ApiTokenError,
  authenticateAgentCredential,
  type ApiTokenScope,
} from "@/lib/tokens/service";

type ConnectionContext = {
  actor?: DraftActor;
  claims?: CollaborationTokenClaims;
  clientIp?: string | null;
  acceptedMutation?: AcceptedWebSocketMutation;
  disconnected?: boolean;
  expirationTimer?: ReturnType<typeof setTimeout>;
  recordedByEndpoint?: boolean;
};

type AcceptedWebSocketMutation = {
  sequence: number;
  finish: () => void;
};

type BackupBarrierReceipt = {
  barrierId: string;
  acquiredAt: string;
  flushedAt: string;
  expiresAt: string;
  flushWatermark: number;
  loadedDocumentCount: number;
};

type ActiveBackupBarrier = {
  barrierId: string;
  acquiredAt: string;
  expiresAtMs: number;
  flushWatermark: number;
  flushedAt?: string;
  loadedDocumentCount?: number;
  expirationTimer: ReturnType<typeof setTimeout>;
};

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
    targetDocumentId: diagnosticIdentifier(input.targetDocumentId),
    position: diagnosticIdentifier(input.position),
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

function parseScopeCeiling(value: unknown) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.length > API_TOKEN_SCOPES.length
    || value.some((scope) => (
      typeof scope !== "string"
      || !API_TOKEN_SCOPES.includes(scope as ApiTokenScope)
    ))
  ) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안 작업자의 권한 상한이 올바르지 않습니다.",
    );
  }
  return Object.freeze(Array.from(new Set(value as ApiTokenScope[])));
}

function parseRequestContext(value: unknown): DraftActor["requestContext"] {
  if (value === undefined) return undefined;
  const context = requireRecord(value);
  if (Object.keys(context).some((key) => key !== "clientIp")) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안 작업자의 요청 컨텍스트가 올바르지 않습니다.",
    );
  }
  if (context.clientIp === null) return Object.freeze({ clientIp: null });
  if (typeof context.clientIp !== "string") {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안 작업자의 클라이언트 IP가 올바르지 않습니다.",
    );
  }
  const clientIp = normalizedClientIp(context.clientIp);
  if (!clientIp) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "공유 초안 작업자의 클라이언트 IP가 올바르지 않습니다.",
    );
  }
  return Object.freeze({ clientIp });
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
  const scopeCeiling = parseScopeCeiling(actor.scopeCeiling);
  const requestContext = parseRequestContext(actor.requestContext);
  if (scopeCeiling !== undefined && type !== "agent") {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "에이전트가 아닌 작업자에는 연결 권한 상한을 지정할 수 없습니다.",
    );
  }
  if (requestContext !== undefined && type !== "agent") {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "에이전트가 아닌 작업자에는 연결 요청 컨텍스트를 지정할 수 없습니다.",
    );
  }
  return {
    type,
    userId: typeof actor.userId === "string" ? actor.userId : null,
    tokenId: typeof actor.tokenId === "string" ? actor.tokenId : null,
    principalId: typeof actor.principalId === "string" ? actor.principalId : null,
    label: requireString(actor.label, "actor.label"),
    avatarMediaId: typeof actor.avatarMediaId === "string" ? actor.avatarMediaId : null,
    source: source as DraftActor["source"],
    ...(scopeCeiling ? { scopeCeiling } : {}),
    ...(requestContext ? { requestContext } : {}),
  };
}

function validateCurrentWebSocketClaims(
  claims: CollaborationTokenClaims,
  documentName: string,
  clientIp: string | null,
) {
  try {
    assertCollaborationTokenFresh(claims);
  } catch (error) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      error instanceof Error ? error.message : "협업 토큰이 만료되었습니다.",
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
    if (!claims.actor.tokenId || !claims.actor.principalId) {
      throw new DocumentServiceError("FORBIDDEN", "에이전트 연결 식별자가 없습니다.");
    }
    let identity;
    try {
      identity = authenticateAgentCredential(sqlite, claims.actor.tokenId, {
        workspaceId: claims.workspaceId,
        clientIp,
        scopeCeiling: claims.actor.scopeCeiling,
      });
    } catch (error) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        error instanceof ApiTokenError
          ? error.message
          : "에이전트 연결이 만료되었거나 폐기되었습니다.",
      );
    }
    if (identity.globalAgentId !== claims.actor.principalId) {
      throw new DocumentServiceError("FORBIDDEN", "에이전트 연결 신원이 일치하지 않습니다.");
    }
    if (!identity.scopes.includes("documents:read")) {
      throw new DocumentServiceError("FORBIDDEN", "에이전트에 문서 읽기 권한이 없습니다.");
    }
    assertWorkspaceAgentGrantCanAccessDocument(
      sqlite,
      claims.workspaceId,
      identity.agentId,
      claims.documentId,
    );
    const principal = { capabilities: identity.capabilities };
    const writeAllowed = identity.scopes.includes("documents:write")
      && agentPrincipalAllows(principal, "documents.update");
    const commitAllowed = identity.scopes.includes("documents:commit")
      && agentPrincipalAllows(principal, "documents.commit");
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

function validateWebSocketClaims(token: string, documentName: string, clientIp: string | null) {
  let claims;
  try {
    claims = verifyCollaborationToken(token);
  } catch (error) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      error instanceof Error ? error.message : "협업 토큰을 확인하지 못했습니다.",
    );
  }
  return validateCurrentWebSocketClaims(claims, documentName, clientIp);
}

const YJS_SYNC_STEP_TWO = 1;
const YJS_UPDATE = 2;

function incomingCollaborationMutation(
  messageData: Uint8Array,
  expectedDocumentName: string,
) {
  const message = new HocuspocusIncomingMessage(messageData);
  const documentName = message.readVarString();
  if (documentName !== expectedDocumentName) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "협업 메시지와 문서 방이 일치하지 않습니다.",
    );
  }
  const messageType = message.readVarUint();
  if (messageType !== MessageType.Sync && messageType !== MessageType.SyncReply) {
    return null;
  }
  const syncType = message.readVarUint();
  if (syncType !== YJS_SYNC_STEP_TWO && syncType !== YJS_UPDATE) {
    return null;
  }
  return message.readVarUint8Array();
}

function assertIncomingCollaborationMutationValid(
  database: NyxDatabase,
  documentName: string,
  document: Y.Doc,
  update: Uint8Array,
) {
  const candidate = new Y.Doc({ gc: document.gc });
  try {
    Y.applyUpdate(
      candidate,
      Y.encodeStateAsUpdate(document),
      "nyxdoc-preflight-baseline",
    );
    Y.applyUpdate(candidate, update, "nyxdoc-preflight-update");
    repairCollaborationYDocNodeIds(candidate);
    const working = workingDocumentFromYDoc(database, documentName, candidate);
    assertDocumentMediaAssetsBelongToWorkspace(
      database,
      working.workspaceId,
      working.content,
    );
  } finally {
    candidate.destroy();
  }
}

function collaborationMutationChangesDocument(
  document: Y.Doc,
  update: Uint8Array,
) {
  // Hocuspocus uses the same check for read-only SyncStep2 messages: clients
  // must be able to acknowledge state they already have without being treated
  // as writers.
  return !Y.snapshotContainsUpdate(Y.snapshot(document), update);
}

let mutationWatermark = 0;
const acceptedMutations = new Set<number>();
const quiescenceWaiters = new Set<() => void>();
const documentMutationTails = new WeakMap<Y.Doc, Promise<void>>();
let activeBackupBarrier: ActiveBackupBarrier | null = null;

function configuredMilliseconds(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const configured = Number(process.env[name] || fallback);
  return Number.isFinite(configured)
    ? Math.min(maximum, Math.max(minimum, Math.floor(configured)))
    : fallback;
}

function backupBarrierLeaseMs() {
  return configuredMilliseconds(
    "NYXDOC_BACKUP_BARRIER_LEASE_MS",
    120_000,
    100,
    30 * 60_000,
  );
}

function backupBarrierQuiesceTimeoutMs() {
  return configuredMilliseconds(
    "NYXDOC_BACKUP_BARRIER_QUIESCE_TIMEOUT_MS",
    15_000,
    50,
    60_000,
  );
}

function releaseBackupBarrier(barrierId: string, reason: "released" | "expired") {
  if (!activeBackupBarrier || activeBackupBarrier.barrierId !== barrierId) return false;
  clearTimeout(activeBackupBarrier.expirationTimer);
  activeBackupBarrier = null;
  if (reason === "expired") {
    console.warn("[collaboration] backup barrier lease expired; document mutations resumed");
  }
  return true;
}

function armBackupBarrierExpiration(barrier: ActiveBackupBarrier) {
  clearTimeout(barrier.expirationTimer);
  const delay = Math.max(1, barrier.expiresAtMs - Date.now());
  barrier.expirationTimer = setTimeout(() => {
    releaseBackupBarrier(barrier.barrierId, "expired");
  }, delay);
  barrier.expirationTimer.unref();
}

function assertDocumentMutationAvailable() {
  if (activeBackupBarrier) {
    throw new DocumentServiceError(
      "COLLABORATION_UNAVAILABLE",
      "검증 백업을 위해 문서 변경을 잠시 멈췄습니다. 잠시 후 다시 시도해주세요.",
      { reason: "BACKUP_BARRIER_ACTIVE", retryable: true },
    );
  }
}

function beginAcceptedMutation() {
  assertDocumentMutationAvailable();
  const sequence = ++mutationWatermark;
  acceptedMutations.add(sequence);
  return sequence;
}

function finishAcceptedMutation(sequence: number) {
  if (!acceptedMutations.delete(sequence) || acceptedMutations.size > 0) return;
  for (const resolve of quiescenceWaiters) resolve();
  quiescenceWaiters.clear();
}

async function reserveDocumentMutationTurn(document: Y.Doc) {
  const predecessor = documentMutationTails.get(document) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = predecessor.then(() => current);
  documentMutationTails.set(document, tail);
  await predecessor;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    void tail.then(() => {
      if (documentMutationTails.get(document) === tail) {
        documentMutationTails.delete(document);
      }
    });
  };
}

function transactionChangesDocument(transaction: Y.Transaction) {
  return transaction.changed.size > 0 || transaction.deleteSet.clients.size > 0;
}

function beginAcceptedWebSocketMutation(
  document: Y.Doc,
  connection: object,
  connectionContext: ConnectionContext,
  releaseMutationTurn: () => void,
) {
  const sequence = beginAcceptedMutation();
  let finished = false;

  const afterTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin !== connection) return;
    document.off("afterTransaction", afterTransaction);
    // Yjs emits afterTransaction even when a duplicate update applies no new
    // structs or deletes. Such a message never emits Hocuspocus onChange, so
    // it must close its accounting token here at the actual apply boundary.
    if (!transactionChangesDocument(transaction)) token.finish();
  };

  const token: AcceptedWebSocketMutation = {
    sequence,
    finish: () => {
      if (finished) return;
      finished = true;
      document.off("afterTransaction", afterTransaction);
      if (connectionContext.acceptedMutation === token) {
        connectionContext.acceptedMutation = undefined;
      }
      finishAcceptedMutation(sequence);
      releaseMutationTurn();
    },
  };
  connectionContext.acceptedMutation = token;
  document.on("afterTransaction", afterTransaction);
  return token;
}

async function withAcceptedMutation<T>(callback: () => Promise<T>) {
  const sequence = beginAcceptedMutation();
  try {
    return await callback();
  } finally {
    finishAcceptedMutation(sequence);
  }
}

async function waitForAcceptedMutations(timeoutMs: number) {
  if (acceptedMutations.size === 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let waiter: (() => void) | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        waiter = resolve;
        quiescenceWaiters.add(resolve);
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(
          `Timed out waiting for ${acceptedMutations.size} accepted collaboration mutation(s).`,
        )), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (waiter) quiescenceWaiters.delete(waiter);
  }
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

function parseMoveWorkingDocumentTreeRequest(
  value: unknown,
): MoveWorkingDocumentTreeRequest {
  const input = requireRecord(value);
  const position = input.position === "before"
    || input.position === "inside"
    || input.position === "after"
    ? input.position
    : (() => {
        throw new DocumentServiceError("INVALID_INPUT", "문서 이동 위치가 올바르지 않습니다.");
      })();
  return {
    roomName: requireString(input.roomName, "roomName"),
    actor: parseDraftActor(input.actor),
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
    requestId: requireString(input.requestId, "requestId"),
    targetDocumentId: requireString(input.targetDocumentId, "targetDocumentId"),
    position,
    summary: typeof input.summary === "string" ? input.summary : undefined,
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

function failNextApplyForTests() {
  const marker = process.env.NYXDOC_TEST_APPLY_FAILURE_MARKER?.trim();
  if (process.env.NODE_ENV !== "test" || !marker || !existsSync(marker)) return;
  rmSync(marker, { force: true });
  throw new Error("injected collaboration apply failure");
}

async function waitForUpdatePersistenceInterlockForTests() {
  const basePath = process.env.NYXDOC_TEST_UPDATE_PERSISTENCE_INTERLOCK?.trim();
  if (process.env.NODE_ENV !== "test" || !basePath) return;
  const armPath = `${basePath}.arm`;
  if (!existsSync(armPath)) return;

  const reachedPath = `${basePath}.reached`;
  const releasePath = `${basePath}.release`;
  rmSync(armPath, { force: true });
  writeFileSync(reachedPath, "preflight-complete", "utf8");
  const deadline = Date.now() + 30_000;
  try {
    while (!existsSync(releasePath)) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for collaboration persistence interlock release");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    rmSync(reachedPath, { force: true });
    rmSync(releasePath, { force: true });
  }
}

const hocuspocus = new Hocuspocus({
  name: "nyxdoc-collaboration",
  debounce: 400,
  maxDebounce: 1_500,
  timeout: 30_000,
  unloadImmediately: true,
  async onAuthenticate({ token, documentName, connectionConfig, request }) {
    const clientIp = collaborationClientIp(request, getCollaborationSecret());
    const { claims, readOnly } = validateWebSocketClaims(token, documentName, clientIp);
    connectionConfig.readOnly = readOnly;
    return {
      actor: claims.actor,
      claims,
      clientIp,
      disconnected: false,
    } satisfies ConnectionContext;
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
  async beforeHandleMessage({
    connection,
    context,
    document,
    documentName,
    update,
  }) {
    let mutation: Uint8Array | null;
    try {
      mutation = incomingCollaborationMutation(update, documentName);
    } catch {
      const rejection = {
        ...Forbidden,
        reason: "Invalid collaboration update",
      };
      connection.close(rejection);
      throw rejection;
    }
    // Awareness, stateless traffic, token sync, and Yjs sync step one do not
    // mutate the authoritative Y.Doc and retain Hocuspocus' normal behavior.
    if (!mutation) return;
    const connectionContext = context as ConnectionContext;
    const releaseMutationTurn = await reserveDocumentMutationTurn(document);
    let mutationTurnTransferred = false;
    try {
      try {
        if (!collaborationMutationChangesDocument(document, mutation)) return;
      } catch {
        const rejection = {
          ...Forbidden,
          reason: "Invalid collaboration update",
        };
        connection.close(rejection);
        throw rejection;
      }

      try {
        if (connectionContext.disconnected || !connectionContext.claims) {
          throw new DocumentServiceError(
            "FORBIDDEN",
            "협업 연결의 인증 정보를 찾을 수 없습니다.",
          );
        }
        const { readOnly } = validateCurrentWebSocketClaims(
          connectionContext.claims,
          documentName,
          connectionContext.clientIp ?? null,
        );
        if (readOnly) {
          throw new DocumentServiceError(
            "FORBIDDEN",
            "이 문서의 공유 초안을 편집할 권한이 없습니다.",
          );
        }
      } catch {
        const rejection = {
          ...Unauthorized,
          reason: "Collaboration authorization is no longer valid",
        };
        connection.close(rejection);
        throw rejection;
      }

      try {
        assertIncomingCollaborationMutationValid(
          sqlite,
          documentName,
          document,
          mutation,
        );
      } catch {
        const rejection = {
          ...Forbidden,
          reason: "Invalid collaboration update",
        };
        connection.close(rejection);
        throw rejection;
      }

      let acceptedMutation: AcceptedWebSocketMutation;
      try {
        acceptedMutation = beginAcceptedWebSocketMutation(
          document,
          connection,
          connectionContext,
          releaseMutationTurn,
        );
        mutationTurnTransferred = true;
      } catch {
        const rejection = {
          ...Forbidden,
          reason: "Verified backup in progress",
        };
        connection.close(rejection);
        throw rejection;
      }

      try {
        // Hocuspocus applies and acknowledges the update only after this hook
        // resolves. Persist an isolated candidate first so a successful sync
        // status can never race ahead of durable draft storage. A crash after
        // this point is an at-least-once retry: reconnecting loads the stored
        // update, while a duplicate Yjs update remains a no-op.
        await waitForUpdatePersistenceInterlockForTests();
        failNextApplyForTests();
        const candidate = new Y.Doc({ gc: document.gc });
        try {
          Y.applyUpdate(
            candidate,
            Y.encodeStateAsUpdate(document),
            "nyxdoc-durable-apply-baseline",
          );
          Y.applyUpdate(candidate, mutation, "nyxdoc-durable-apply-update");
          persistCollaborationUpdate(
            sqlite,
            documentName,
            candidate,
            connectionContext.actor!,
            {
              authorizationContext: {
                clientIp: connectionContext.clientIp ?? null,
              },
            },
          );
          Y.applyUpdate(
            document,
            Y.encodeStateAsUpdate(candidate),
            connection,
          );
        } finally {
          candidate.destroy();
        }
      } catch (error) {
        acceptedMutation.finish();
        const authorizationDenied = error instanceof DocumentServiceError
          && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND");
        const rejection = {
          ...(authorizationDenied ? Unauthorized : Forbidden),
          reason: authorizationDenied
            ? "Collaboration authorization is no longer valid"
            : "Collaboration update persistence failed",
        };
        connection.close(rejection);
        throw error;
      }
    } finally {
      if (!mutationTurnTransferred) releaseMutationTurn();
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
    const acceptedMutation = connectionContext.acceptedMutation;
    try {
      if (!connectionContext.actor || connectionContext.recordedByEndpoint) return;
      if (connectionContext.claims) {
        assertCollaborationTokenFresh(connectionContext.claims);
      }
      logNodeIdRepairs(
        documentName,
        "change",
        repairCollaborationYDocNodeIds(document),
      );
      const working = workingDocumentFromYDoc(sqlite, documentName, document);
      assertDocumentMediaAssetsBelongToWorkspace(
        sqlite,
        working.workspaceId,
        working.content,
      );
      const state = persistCollaborationUpdate(
        sqlite,
        documentName,
        document,
        connectionContext.actor,
        {
          authorizationContext: {
            clientIp: connectionContext.clientIp ?? null,
          },
        },
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
    } finally {
      acceptedMutation?.finish();
    }
  },
  async onStoreDocument({ documentName, document }) {
    logNodeIdRepairs(
      documentName,
      "store",
      repairCollaborationYDocNodeIds(document),
    );
    const working = workingDocumentFromYDoc(sqlite, documentName, document);
    assertDocumentMediaAssetsBelongToWorkspace(
      sqlite,
      working.workspaceId,
      working.content,
    );
    persistCollaborationYDoc(sqlite, documentName, document);
  },
  async onDisconnect({ context }) {
    const connectionContext = context as ConnectionContext;
    connectionContext.disconnected = true;
    if (connectionContext.expirationTimer) {
      clearTimeout(connectionContext.expirationTimer);
      connectionContext.expirationTimer = undefined;
    }
    connectionContext.acceptedMutation?.finish();
  },
});

function persistLoadedDocumentForBackup(documentName: string, document: Y.Doc) {
  logNodeIdRepairs(
    documentName,
    "store",
    repairCollaborationYDocNodeIds(document),
  );
  const working = workingDocumentFromYDoc(sqlite, documentName, document);
  assertDocumentMediaAssetsBelongToWorkspace(
    sqlite,
    working.workspaceId,
    working.content,
  );
  persistCollaborationYDoc(sqlite, documentName, document);
}

function backupBarrierReceipt(barrier: ActiveBackupBarrier): BackupBarrierReceipt {
  if (!barrier.flushedAt || barrier.loadedDocumentCount === undefined) {
    throw new DocumentServiceError(
      "COLLABORATION_UNAVAILABLE",
      "백업 장벽이 아직 준비되지 않았습니다.",
    );
  }
  return {
    barrierId: barrier.barrierId,
    acquiredAt: barrier.acquiredAt,
    flushedAt: barrier.flushedAt,
    expiresAt: new Date(barrier.expiresAtMs).toISOString(),
    flushWatermark: barrier.flushWatermark,
    loadedDocumentCount: barrier.loadedDocumentCount,
  };
}

async function acquireBackupBarrier() {
  if (activeBackupBarrier) {
    throw new DocumentServiceError(
      "COLLABORATION_UNAVAILABLE",
      "다른 검증 백업이 이미 진행 중입니다.",
      { reason: "BACKUP_BARRIER_ALREADY_ACTIVE", retryable: true },
    );
  }
  const acquiredAt = new Date().toISOString();
  const barrier: ActiveBackupBarrier = {
    barrierId: randomUUID(),
    acquiredAt,
    expiresAtMs: Date.now() + backupBarrierLeaseMs(),
    flushWatermark: mutationWatermark,
    expirationTimer: setTimeout(() => undefined, 1),
  };
  activeBackupBarrier = barrier;
  armBackupBarrierExpiration(barrier);
  try {
    await waitForAcceptedMutations(backupBarrierQuiesceTimeoutMs());
    if (activeBackupBarrier !== barrier) {
      throw new Error("Backup barrier lease expired while waiting for accepted mutations.");
    }
    const documents = Array.from(hocuspocus.documents.values());
    for (const document of documents) {
      persistLoadedDocumentForBackup(document.name, document);
    }
    barrier.loadedDocumentCount = documents.length;
    barrier.flushedAt = new Date().toISOString();
    barrier.expiresAtMs = Date.now() + backupBarrierLeaseMs();
    armBackupBarrierExpiration(barrier);
    return backupBarrierReceipt(barrier);
  } catch (error) {
    releaseBackupBarrier(barrier.barrierId, "released");
    throw new DocumentServiceError(
      "COLLABORATION_UNAVAILABLE",
      "협업 초안을 백업 경계까지 저장하지 못했습니다. 백업을 생성하지 않았습니다.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function requireActiveBackupBarrier(value: unknown) {
  const input = requireRecord(value);
  const barrierId = requireString(input.barrierId, "barrierId");
  const barrier = activeBackupBarrier;
  if (!barrier || barrier.barrierId !== barrierId || !barrier.flushedAt) {
    throw new DocumentServiceError(
      "COLLABORATION_UNAVAILABLE",
      "백업 장벽이 만료되었거나 일치하지 않습니다.",
      { reason: "BACKUP_BARRIER_NOT_ACTIVE" },
    );
  }
  return barrier;
}

function renewBackupBarrier(value: unknown) {
  const barrier = requireActiveBackupBarrier(value);
  barrier.expiresAtMs = Date.now() + backupBarrierLeaseMs();
  armBackupBarrierExpiration(barrier);
  return backupBarrierReceipt(barrier);
}

function releaseRequestedBackupBarrier(value: unknown) {
  const input = requireRecord(value);
  const barrierId = requireString(input.barrierId, "barrierId");
  return {
    barrierId,
    released: releaseBackupBarrier(barrierId, "released"),
  };
}

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
    switch (path) {
      case "/internal/backup/barrier/acquire":
        result = await acquireBackupBarrier();
        break;
      case "/internal/backup/barrier/renew":
        result = renewBackupBarrier(body);
        break;
      case "/internal/backup/barrier/status":
        result = backupBarrierReceipt(requireActiveBackupBarrier(body));
        break;
      case "/internal/backup/barrier/release":
        result = releaseRequestedBackupBarrier(body);
        break;
      case "/internal/drafts/read":
        result = await collaborationCommands.readWorking(parseReadRequest(body));
        break;
      case "/internal/drafts/replace":
        result = await withAcceptedMutation(() =>
          collaborationCommands.replaceWorking(parseReplaceRequest(body)));
        break;
      case "/internal/drafts/replace-and-commit":
        result = await withAcceptedMutation(() =>
          collaborationCommands.replaceAndCommitWorking(parseReplaceAndCommitRequest(body)));
        break;
      case "/internal/drafts/move-tree":
        result = await withAcceptedMutation(() =>
          collaborationCommands.moveWorkingDocumentTree(
            parseMoveWorkingDocumentTreeRequest(body),
          ));
        break;
      case "/internal/drafts/patch":
        result = await withAcceptedMutation(() =>
          collaborationCommands.patchWorking(parsePatchRequest(body)));
        break;
      case "/internal/drafts/commit":
        result = await withAcceptedMutation(() =>
          collaborationCommands.commitWorking(parseCommitRequest(body)));
        break;
      case "/internal/drafts/reset":
        result = await withAcceptedMutation(() =>
          collaborationCommands.resetWorking(parseResetRequest(body)));
        break;
      case "/internal/drafts/archive":
        result = await withAcceptedMutation(() =>
          collaborationCommands.archiveWorkingTree(parseArchiveRequest(body)));
        break;
      default:
        result = null;
    }
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
  if (activeBackupBarrier) {
    releaseBackupBarrier(activeBackupBarrier.barrierId, "released");
  }
  hocuspocus.closeConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  sqlite.close();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
