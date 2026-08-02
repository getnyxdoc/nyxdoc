import { ensureCollaborationState } from "@/lib/collaboration/drafts";
import { commitWorkingDocument } from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { commitWorkingDocumentSchema } from "@/lib/documents/schemas";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenDocumentAccess,
  requireTokenScope,
  tokenDocumentActor,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenScope(identity, "documents:commit");
    const { documentId } = await context.params;
    requireTokenDocumentAccess(sqlite, identity, documentId);
    const body = commitWorkingDocumentSchema.parse(await request.json());
    const state = ensureCollaborationState(sqlite, identity.workspaceId, documentId);
    return Response.json(await commitWorkingDocument({
      roomName: state.roomName,
      actor: tokenDocumentActor(identity, "api"),
      expectedDraftVersion: body.expectedDraftVersion,
      requestId: body.requestId,
      summary: body.summary,
    }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
