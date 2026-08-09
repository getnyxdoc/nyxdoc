import {
  getHumanDocumentPrincipal,
  humanDocumentPrincipalAllows,
} from "@/lib/authz/permissions";
import type { NyxDatabase } from "@/lib/db/client";
import {
  DocumentServiceError,
  type DocumentActor,
} from "@/lib/documents/types";
import {
  ApiTokenError,
  authenticateAgentCredential,
  requireTokenDocumentAccess,
  requireTokenPermission,
  type ApiTokenRequestContext,
  type ApiTokenScope,
} from "@/lib/tokens/service";

export type CollaborationMutationIntent =
  | "draft.update"
  | "draft.restore"
  | "canonical.commit";

export type CollaborationAuthorizationContext = {
  clientIp?: string | null;
};

type CollaborationAuthorizationActor = {
  type: DocumentActor["type"];
  userId?: string | null;
  tokenId?: string | null;
  principalId?: string | null;
  readonly scopeCeiling?: readonly ApiTokenScope[];
  readonly requestContext?: ApiTokenRequestContext;
};

/**
 * Re-resolves the actor at the collaboration write boundary.
 *
 * REST and MCP authorization is intentionally not treated as a lease: a
 * membership, grant, credential binding, capability, or document boundary may
 * be revoked after the public endpoint checks it but before the collaboration
 * process enters its SQLite write transaction. Every draft/canonical mutation
 * therefore calls this function again immediately before changing state.
 */
export function requireCurrentCollaborationAuthorization(
  database: NyxDatabase,
  workspaceId: string,
  documentId: string,
  actor: CollaborationAuthorizationActor,
  intent: CollaborationMutationIntent,
  context: CollaborationAuthorizationContext = {},
) {
  if (actor.type === "system") return;

  if (actor.type === "human") {
    const userId = actor.userId?.trim();
    if (!userId) {
      throw new DocumentServiceError("FORBIDDEN", "현재 사용자 신원을 확인할 수 없습니다.");
    }
    const principal = getHumanDocumentPrincipal(database, workspaceId, documentId, userId);
    const canUpdate = principal && humanDocumentPrincipalAllows(principal, "documents.update");
    const canCommit = intent !== "canonical.commit"
      || (principal && humanDocumentPrincipalAllows(principal, "documents.commit"));
    const canRestore = intent !== "draft.restore"
      || (principal && humanDocumentPrincipalAllows(principal, "revisions.restore"));
    if (!canUpdate || !canCommit || !canRestore) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        "현재 문서 권한으로 이 공유 초안 작업을 계속할 수 없습니다.",
        { intent, reason: "CURRENT_HUMAN_PERMISSION_DENIED" },
      );
    }
    return;
  }

  const tokenId = actor.tokenId?.trim();
  if (!tokenId) {
    throw new DocumentServiceError(
      "FORBIDDEN",
      "현재 에이전트 연결 자격 증명을 확인할 수 없습니다.",
      { intent, reason: "CURRENT_AGENT_CREDENTIAL_MISSING" },
    );
  }

  try {
    const identity = authenticateAgentCredential(database, tokenId, {
      workspaceId,
      // A live WebSocket connection provides an explicit gateway-proven IP
      // and therefore wins over the context captured at token issuance. An
      // internal REST/MCP command falls back to its authenticated actor.
      clientIp: context.clientIp !== undefined
        ? context.clientIp
        : actor.requestContext?.clientIp,
      scopeCeiling: actor.scopeCeiling,
    });
    if (actor.principalId && identity.globalAgentId !== actor.principalId) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        "현재 에이전트 연결과 작업자 신원이 일치하지 않습니다.",
        { intent, reason: "CURRENT_AGENT_IDENTITY_MISMATCH" },
      );
    }
    requireTokenPermission(identity, "documents:write", "documents.update");
    if (intent === "canonical.commit") {
      requireTokenPermission(identity, "documents:commit", "documents.commit");
    }
    if (intent === "draft.restore") {
      requireTokenPermission(identity, "revisions:restore", "revisions.restore");
    }
    requireTokenDocumentAccess(database, identity, documentId);
  } catch (error) {
    if (error instanceof DocumentServiceError) throw error;
    if (error instanceof ApiTokenError) {
      throw new DocumentServiceError(
        error.code === "NOT_FOUND" ? "NOT_FOUND" : "FORBIDDEN",
        error.message,
        { intent, reason: "CURRENT_AGENT_PERMISSION_DENIED" },
      );
    }
    throw error;
  }
}
