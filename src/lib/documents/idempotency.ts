import { createHash } from "node:crypto";
import type { NyxDatabase } from "@/lib/db/client";
import { DocumentServiceError, type DocumentActor } from "@/lib/documents/types";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

type AgentWriteIdentity = {
  operation: string;
  payloadHash: string;
  requestId: string;
  tokenId: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function payloadHash(operation: string, payload: unknown) {
  return createHash("sha256")
    .update(`${operation}\n${JSON.stringify(canonicalValue(payload))}`, "utf8")
    .digest("hex");
}

export function prepareAgentWrite(
  actor: DocumentActor,
  operation: string,
  requestId: string | undefined,
  payload: unknown,
): AgentWriteIdentity | null {
  if (requestId === undefined) return null;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new DocumentServiceError(
      "INVALID_INPUT",
      "requestId는 8~128자의 영문자, 숫자, 점, 밑줄, 콜론 또는 하이픈이어야 합니다.",
    );
  }
  if (!actor.tokenId) {
    throw new DocumentServiceError("INVALID_INPUT", "requestId는 외부 에이전트 연결에서만 사용할 수 있습니다.");
  }
  return {
    operation,
    payloadHash: payloadHash(operation, payload),
    requestId,
    tokenId: actor.tokenId,
  };
}

export function replayAgentWrite<T>(
  database: NyxDatabase,
  identity: AgentWriteIdentity | null,
): T | null {
  if (!identity) return null;
  const row = database
    .prepare(
      `SELECT operation, payload_hash, response_json
       FROM agent_credential_write_requests
       WHERE credential_id = ? AND request_id = ?`,
    )
    .get(identity.tokenId, identity.requestId) as
    | { operation: string; payload_hash: string; response_json: string }
    | undefined;
  if (!row) return null;
  if (row.operation !== identity.operation || row.payload_hash !== identity.payloadHash) {
    throw new DocumentServiceError(
      "IDEMPOTENCY_CONFLICT",
      "같은 requestId가 다른 쓰기 요청에 이미 사용되었습니다.",
      { requestId: identity.requestId, originalOperation: row.operation },
    );
  }
  try {
    return JSON.parse(row.response_json) as T;
  } catch {
    throw new DocumentServiceError("INVALID_INPUT", "저장된 멱등 요청 결과를 읽을 수 없습니다.");
  }
}

export function recordAgentWrite(
  database: NyxDatabase,
  identity: AgentWriteIdentity | null,
  documentId: string | null,
  response: unknown,
) {
  if (!identity) return;
  database
    .prepare(
      `INSERT INTO agent_credential_write_requests
       (credential_id, request_id, operation, payload_hash, document_id, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      identity.tokenId,
      identity.requestId,
      identity.operation,
      identity.payloadHash,
      documentId,
      JSON.stringify(response),
      new Date().toISOString(),
    );
  if (database.prepare("SELECT 1 FROM workspace_api_tokens WHERE id = ?").get(identity.tokenId)) {
    database.prepare(
      `INSERT OR IGNORE INTO agent_write_requests
       (token_id, request_id, operation, payload_hash, document_id, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identity.tokenId,
      identity.requestId,
      identity.operation,
      identity.payloadHash,
      documentId,
      JSON.stringify(response),
      new Date().toISOString(),
    );
  }
}
