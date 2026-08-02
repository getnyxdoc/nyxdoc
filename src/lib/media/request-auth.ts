import "server-only";

import { requireWorkspaceSession } from "@/data/workspace-context";
import {
  requireAgentWorkspacePermission,
  requireHumanDocumentPermission,
  requireHumanWorkspacePermission,
} from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { assertSameOrigin } from "@/lib/http/origin";
import { requestClientIp } from "@/lib/http/client-ip";
import {
  ApiTokenError,
  authenticateApiToken,
  requireTokenDocumentAccess,
  requireTokenScope,
  type ApiTokenScope,
} from "@/lib/tokens/service";
import { documentHasMediaBinding } from "@/lib/media/bindings";

export async function requireMediaRequestIdentity(
  request: Request,
  scope: ApiTokenScope,
  options: {
    documentId?: string;
    mediaId?: string;
    mutating?: boolean;
    workspaceId?: string;
  } = {},
) {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const requestedWorkspace = request.headers.get("x-nyxdoc-workspace-id")
      || new URL(request.url).searchParams.get("workspace");
    const document = options.documentId
      ? sqlite.prepare("SELECT workspace_id, status FROM documents WHERE id = ?")
        .get(options.documentId) as { workspace_id: string; status: string } | undefined
      : undefined;
    if (options.documentId && (!document || document.status !== "active")) {
      throw new ApiTokenError("NOT_FOUND", "문서를 찾을 수 없습니다.");
    }
    const identity = authenticateApiToken(sqlite, authorization, {
      workspaceId: options.workspaceId ?? document?.workspace_id ?? requestedWorkspace,
      clientIp: requestClientIp(request),
    });
    requireTokenScope(identity, scope);
    if (scope === "documents:write") {
      requireAgentWorkspacePermission({
        type: "agent",
        workspaceId: identity.workspaceId,
        membershipId: identity.agentId,
        agentId: identity.globalAgentId,
        role: identity.role,
        displayName: identity.name,
        avatarMediaId: identity.avatarMediaId,
        permissionAllow: identity.permissionAllow,
        permissionDeny: identity.permissionDeny,
      }, "media.upload");
    }
    if (options.documentId) {
      if (document?.workspace_id !== identity.workspaceId) {
        throw new ApiTokenError("NOT_FOUND", "문서를 찾을 수 없습니다.");
      }
      requireTokenDocumentAccess(sqlite, identity, options.documentId);
    }
    if (options.workspaceId && identity.workspaceId !== options.workspaceId) {
      throw new ApiTokenError("FORBIDDEN", "다른 워크스페이스의 이미지에는 접근할 수 없습니다.");
    }
    return {
      tokenId: identity.id,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
    };
  }

  if (options.mutating) assertSameOrigin(request);
  const { session, workspace } = await requireWorkspaceSession(request, options.workspaceId);
  if (options.documentId) {
    const principal = requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      options.documentId,
      session.user.id,
      scope === "documents:read" ? "documents.read" : "media.upload",
    );
    if (
      principal.source === "document_grant"
      && scope === "documents:read"
      && options.mediaId
      && !documentHasMediaBinding(
        sqlite,
        workspace.id,
        options.documentId,
        options.mediaId,
      )
    ) {
      throw new ApiTokenError("FORBIDDEN", "이 문서에 포함되지 않은 이미지에는 접근할 수 없습니다.");
    }
  } else {
    requireHumanWorkspacePermission(
      sqlite,
      workspace.id,
      session.user.id,
      scope === "documents:read" ? "documents.read" : "media.upload",
    );
  }
  return {
    tokenId: undefined,
    userId: session.user.id,
    workspaceId: workspace.id,
  };
}
