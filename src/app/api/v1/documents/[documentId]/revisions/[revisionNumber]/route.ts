import { sqlite } from "@/lib/db/client";
import { getDocumentRevisionSnapshotByNumber } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import { requireTokenDocumentAccess, requireTokenPermission } from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string; revisionNumber: string }> },
) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenPermission(identity, "documents:read", "revisions.read");
    const { documentId, revisionNumber: value } = await context.params;
    requireTokenDocumentAccess(sqlite, identity, documentId);
    const revisionNumber = Number(value);
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
      throw new DocumentServiceError("INVALID_INPUT", "올바른 리비전 번호가 필요합니다.");
    }
    return Response.json({
      revision: getDocumentRevisionSnapshotByNumber(
        sqlite,
        identity.workspaceId,
        documentId,
        revisionNumber,
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
