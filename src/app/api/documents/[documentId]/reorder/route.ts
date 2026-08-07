import { randomUUID } from "node:crypto";
import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import {
  moveWorkingDocumentTreeThroughGateway,
  readWorkingDocument,
} from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { reorderDocumentSchema } from "@/lib/documents/schemas";
import { getDocument, listDocuments, reorderDocumentTree } from "@/lib/documents/service";
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

    const result = source.parentDocumentId !== destinationParentDocumentId
      ? await (async () => {
          requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.commit");
          const { workingDocument } = await readWorkingDocument({
            workspaceId: workspace.id,
            documentId,
          });
          const moved = await moveWorkingDocumentTreeThroughGateway({
            roomName: workingDocument.roomName,
            actor,
            expectedGeneration: workingDocument.generation,
            expectedDraftVersion: workingDocument.draftVersion,
            expectedBaseRevision: workingDocument.baseRevisionNumber,
            requestId: `tree-move-${randomUUID()}`,
            targetDocumentId: target.id,
            position: body.position,
            summary: `문서 트리에서 ${target.title} 위치로 이동했습니다.`,
          });
          return moved.tree;
        })()
      : reorderDocumentTree(
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
