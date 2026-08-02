import { sqlite } from "@/lib/db/client";
import { listDocumentRevisions } from "@/lib/documents/service";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import { requireTokenDocumentAccess, requireTokenScope } from "@/lib/tokens/service";

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
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || 20);
    const beforeValue = url.searchParams.get("beforeRevision");
    const beforeRevision = beforeValue === null ? undefined : Number(beforeValue);
    if (
      !Number.isInteger(limit)
      || limit < 1
      || limit > 50
      || (beforeRevision !== undefined && (!Number.isInteger(beforeRevision) || beforeRevision < 1))
    ) {
      throw new DocumentServiceError("INVALID_INPUT", "limit과 beforeRevision 값을 확인해주세요.");
    }
    return Response.json({
      revisions: listDocumentRevisions(
        sqlite,
        identity.workspaceId,
        documentId,
        limit,
        beforeRevision,
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
