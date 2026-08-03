import { resetWorkingDocument } from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { restoreWorkingRevisionSchema } from "@/lib/documents/schemas";
import { getDocumentRevisionSnapshotByNumber } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenDocumentAccess,
  requireTokenPermission,
  tokenDocumentActor,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string; revisionNumber: string }> },
) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenPermission(identity, "revisions:restore", "revisions.restore");
    const { documentId, revisionNumber: value } = await context.params;
    requireTokenDocumentAccess(sqlite, identity, documentId);
    const revisionNumber = Number(value);
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
      throw new DocumentServiceError("INVALID_INPUT", "올바른 리비전 번호가 필요합니다.");
    }
    const body = restoreWorkingRevisionSchema.parse(await request.json());
    const revision = getDocumentRevisionSnapshotByNumber(
      sqlite,
      identity.workspaceId,
      documentId,
      revisionNumber,
    );
    const result = await resetWorkingDocument({
      workspaceId: identity.workspaceId,
      documentId,
      revisionId: revision.id,
      expectedGeneration: body.expectedGeneration,
      expectedDraftVersion: body.expectedDraftVersion,
      expectedBaseRevision: body.expectedBaseRevision,
      actor: tokenDocumentActor(identity, "api"),
      requestId: body.requestId,
    });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
