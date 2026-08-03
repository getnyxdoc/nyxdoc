import { requireWorkspaceSession } from "@/data/workspace-context";
import {
  requireHumanDocumentPermission,
  requireHumanWorkspacePermission,
} from "@/lib/authz/permissions";
import { ensureCollaborationState } from "@/lib/collaboration/drafts";
import {
  archiveWorkingTree,
  replaceAndCommitWorkingDocumentThroughGateway,
} from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { archiveDocumentSchema, updateDocumentSchema } from "@/lib/documents/schemas";
import { getDocument } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const { documentId } = await context.params;
    const principal = requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      documentId,
      session.user.id,
      "documents.update",
    );
    requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      documentId,
      session.user.id,
      "documents.commit",
    );
    const body = updateDocumentSchema.parse(await request.json());
    if (principal.source === "document_grant" && body.parentDocumentId !== undefined) {
      throw new DocumentServiceError(
        "FORBIDDEN",
        "직접 공유받은 문서는 워크스페이스 안에서 이동할 수 없습니다.",
      );
    }
    const canonical = getDocument(sqlite, workspace.id, documentId);
    if (canonical.revisionNumber !== body.baseRevision) {
      throw new DocumentServiceError(
        "REVISION_CONFLICT",
        "문서가 먼저 변경되었습니다. 최신 리비전을 확인해주세요.",
        { baseRevision: body.baseRevision, currentRevision: canonical.revisionNumber },
      );
    }
    const state = ensureCollaborationState(sqlite, workspace.id, documentId);
    const actor = { ...humanDocumentActor(session.user), source: "api" as const };
    const result = await replaceAndCommitWorkingDocumentThroughGateway({
      roomName: state.roomName,
      actor,
      requestId: body.requestId,
      expectedDraftVersion: state.draftVersion,
      replacement: {
        title: body.title,
        parentDocumentId: body.parentDocumentId,
        documentType: body.documentType,
        workflowStatus: body.workflowStatus,
        tags: body.tags,
        content: body.content,
      },
      summary: body.summary,
    });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.trash");
    const { documentId } = await context.params;
    const body = archiveDocumentSchema.parse(await request.json());
    const result = await archiveWorkingTree({
      workspaceId: workspace.id,
      documentId,
      actor: { ...humanDocumentActor(session.user), source: "web" },
      ...body,
    });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
