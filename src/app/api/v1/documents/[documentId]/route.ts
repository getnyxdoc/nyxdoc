import { ensureCollaborationState } from "@/lib/collaboration/drafts";
import {
  patchWorkingDocumentThroughGateway,
  replaceWorkingDocumentThroughGateway,
} from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { patchWorkingDocumentSchema, updateWorkingDocumentSchema } from "@/lib/documents/schemas";
import { getDocument } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenDocumentAccess,
  requireTokenParentAccess,
  requireTokenScope,
  tokenDocumentActor,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenScope(identity, "documents:read");
    const { documentId } = await context.params;
    requireTokenDocumentAccess(sqlite, identity, documentId);
    return Response.json({ document: getDocument(sqlite, identity.workspaceId, documentId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenScope(identity, "documents:write");
    const { documentId } = await context.params;
    requireTokenDocumentAccess(sqlite, identity, documentId);
    const body = updateWorkingDocumentSchema.parse(await request.json());
    requireTokenParentAccess(sqlite, identity, body.parentDocumentId);
    const state = ensureCollaborationState(sqlite, identity.workspaceId, documentId);
    const result = await replaceWorkingDocumentThroughGateway({
      roomName: state.roomName,
      actor: tokenDocumentActor(identity, "api"),
      expectedDraftVersion: body.expectedDraftVersion,
      requestId: body.requestId,
      replacement: {
        title: body.title,
        parentDocumentId: body.parentDocumentId,
        documentType: body.documentType,
        workflowStatus: body.workflowStatus,
        tags: body.tags,
        content: body.content,
      },
    });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenScope(identity, "documents:write");
    const { documentId } = await context.params;
    requireTokenDocumentAccess(sqlite, identity, documentId);
    const body = patchWorkingDocumentSchema.parse(await request.json());
    const state = ensureCollaborationState(sqlite, identity.workspaceId, documentId);
    const result = await patchWorkingDocumentThroughGateway({
      roomName: state.roomName,
      actor: tokenDocumentActor(identity, "api"),
      expectedDraftVersion: body.expectedDraftVersion,
      requestId: body.requestId,
      operations: body.operations,
    });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
