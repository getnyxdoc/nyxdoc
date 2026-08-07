import { randomUUID } from "node:crypto";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import {
  readWorkingDocument,
  replaceAndCommitWorkingDocumentThroughGateway,
} from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { reorderDocumentSchema } from "@/lib/documents/schemas";
import { getDocument, listDocuments, reorderDocumentTree } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.update");
    const { documentId } = await context.params;
    const body = reorderDocumentSchema.parse(await request.json());
    const actor = { ...humanDocumentActor(session.user), source: "web" as const };
    const source = getDocument(sqlite, workspace.id, documentId);
    const target = getDocument(sqlite, workspace.id, body.targetDocumentId);
    const destinationParentDocumentId = body.position === "inside"
      ? target.id
      : target.parentDocumentId;

    if (source.parentDocumentId !== destinationParentDocumentId) {
      requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.commit");
      const { workingDocument } = await readWorkingDocument({
        workspaceId: workspace.id,
        documentId,
      });
      if (workingDocument.hasUncommittedChanges) {
        throw new DocumentServiceError(
          "DRAFT_NOT_SYNCED",
          "저장하지 않은 초안이 있어 문서를 이동하지 않았습니다. 먼저 저장하거나 초안을 버려주세요.",
        );
      }
      await replaceAndCommitWorkingDocumentThroughGateway({
        roomName: workingDocument.roomName,
        actor,
        expectedDraftVersion: workingDocument.draftVersion,
        requestId: `tree-move-${randomUUID()}`,
        replacement: { parentDocumentId: destinationParentDocumentId },
        summary: `문서 트리에서 ${target.title} 위치로 이동했습니다.`,
      });
    }

    const result = reorderDocumentTree(
      sqlite,
      workspace.id,
      actor,
      documentId,
      body,
    );
    return Response.json({
      ...result,
      documents: listDocuments(sqlite, workspace.id),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
