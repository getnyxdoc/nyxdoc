import { getCollaborationInternalUrl, getCollaborationSecret } from "@/lib/config";
import type {
  ArchiveWorkingTreeRequest,
  ArchiveWorkingTreeResponse,
  CommitWorkingDocumentRequest,
  CommitWorkingDocumentResponse,
  CollaborationErrorResponse,
  PatchWorkingDocumentRequest,
  ReadWorkingDocumentRequest,
  ReplaceAndCommitWorkingDocumentRequest,
  ReplaceAndCommitWorkingDocumentResponse,
  ReplaceWorkingDocumentRequest,
  ResetWorkingDocumentRequest,
  ResetWorkingDocumentResponse,
  WorkingDocumentResponse,
} from "@/lib/collaboration/protocol";
import {
  DocumentServiceError,
  type DocumentServiceErrorCode,
} from "@/lib/documents/types";

const DOCUMENT_ERROR_CODES = new Set<DocumentServiceErrorCode>([
  "NOT_FOUND",
  "FORBIDDEN",
  "INVALID_INPUT",
  "IDEMPOTENCY_CONFLICT",
  "DRAFT_CONFLICT",
  "DRAFT_NOT_SYNCED",
  "DRAFT_VERSION_CONFLICT",
  "COLLABORATION_UNAVAILABLE",
  "REVISION_CONFLICT",
]);

async function collaborationRequest<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getCollaborationInternalUrl().replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${getCollaborationSecret()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new DocumentServiceError(
      "COLLABORATION_UNAVAILABLE",
      "공유 초안 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  const payload = await response.json().catch(() => ({})) as T | CollaborationErrorResponse;
  if (!response.ok) {
    const failure = payload as CollaborationErrorResponse;
    const code = failure.code && DOCUMENT_ERROR_CODES.has(failure.code as DocumentServiceErrorCode)
      ? failure.code as DocumentServiceErrorCode
      : response.status === 404
        ? "NOT_FOUND"
        : response.status === 403
          ? "FORBIDDEN"
          : response.status === 409
            ? "DRAFT_CONFLICT"
            : "COLLABORATION_UNAVAILABLE";
    throw new DocumentServiceError(
      code,
      failure.error || "공유 초안 요청을 처리하지 못했습니다.",
      failure.details,
    );
  }
  return payload as T;
}

export function readWorkingDocument(input: ReadWorkingDocumentRequest) {
  return collaborationRequest<WorkingDocumentResponse>("/internal/drafts/read", input);
}

export function replaceWorkingDocumentThroughGateway(input: ReplaceWorkingDocumentRequest) {
  return collaborationRequest<WorkingDocumentResponse>("/internal/drafts/replace", input);
}

export function replaceAndCommitWorkingDocumentThroughGateway(
  input: ReplaceAndCommitWorkingDocumentRequest,
) {
  return collaborationRequest<ReplaceAndCommitWorkingDocumentResponse>(
    "/internal/drafts/replace-and-commit",
    input,
  );
}

export function patchWorkingDocumentThroughGateway(input: PatchWorkingDocumentRequest) {
  return collaborationRequest<WorkingDocumentResponse>("/internal/drafts/patch", input);
}

export function commitWorkingDocument(input: CommitWorkingDocumentRequest) {
  return collaborationRequest<CommitWorkingDocumentResponse>("/internal/drafts/commit", input);
}

export function resetWorkingDocument(input: ResetWorkingDocumentRequest) {
  return collaborationRequest<ResetWorkingDocumentResponse>("/internal/drafts/reset", input);
}

export function archiveWorkingTree(input: ArchiveWorkingTreeRequest) {
  return collaborationRequest<ArchiveWorkingTreeResponse>("/internal/drafts/archive", input);
}
