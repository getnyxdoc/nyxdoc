import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { ensureCollaborationState } from "@/lib/collaboration/drafts";
import { moveWorkingDocumentTreeThroughGateway } from "@/lib/collaboration/gateway";
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
    let result;
    let moveDetails: {
      document: Awaited<ReturnType<typeof moveWorkingDocumentTreeThroughGateway>>["document"];
      workingDocument: Awaited<ReturnType<typeof moveWorkingDocumentTreeThroughGateway>>["workingDocument"];
    } | null = null;
    if (source.parentDocumentId === destinationParentDocumentId) {
      result = reorderDocumentTree(
        sqlite,
        workspace.id,
        actor,
        documentId,
        body,
      );
    } else {
      const state = ensureCollaborationState(sqlite, workspace.id, documentId);
      const workingMove = await moveWorkingDocumentTreeThroughGateway({
        roomName: state.roomName,
        actor,
        requestId: body.requestId,
        expectedGeneration: state.generation,
        expectedDraftVersion: state.draftVersion,
        expectedBaseRevision: state.baseRevisionNumber,
        targetDocumentId: body.targetDocumentId,
        position: body.position,
        summary: "문서를 다른 상위 문서로 이동했습니다.",
      });
      result = workingMove.tree;
      moveDetails = {
        document: workingMove.document,
        workingDocument: workingMove.workingDocument,
      };
    }
    return Response.json({
      ...result,
      ...(moveDetails ?? {}),
      documents: listDocuments(sqlite, workspace.id),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
