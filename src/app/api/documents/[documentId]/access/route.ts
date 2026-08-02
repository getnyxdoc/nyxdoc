import { requireWorkspaceSession } from "@/data/workspace-context";
import {
  requireHumanWorkspacePermission,
  type HumanDocumentGrantRole,
} from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import {
  listDocumentHumanAccess,
  setDocumentHumanGrant,
} from "@/lib/sharing/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.share");
    const { documentId } = await context.params;
    return Response.json({
      access: listDocumentHumanAccess(sqlite, workspace.id, documentId),
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.share");
    const { documentId } = await context.params;
    const body = await request.json() as { userId?: unknown; role?: unknown };
    if (typeof body.userId !== "string") {
      throw new DocumentServiceError("INVALID_INPUT", "공유할 사용자를 선택해주세요.");
    }
    if (body.role !== "viewer" && body.role !== "editor") {
      throw new DocumentServiceError("INVALID_INPUT", "문서 권한은 뷰어 또는 편집자여야 합니다.");
    }
    const entry = setDocumentHumanGrant(sqlite, {
      workspaceId: workspace.id,
      documentId,
      recipientUserId: body.userId,
      role: body.role as HumanDocumentGrantRole,
      actorUserId: session.user.id,
      actorLabel: session.user.name,
    });
    return Response.json({ entry }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
