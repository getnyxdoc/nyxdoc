import { sqlite } from "@/lib/db/client";
import { diffDocumentRevisions } from "@/lib/documents/service";
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
    const fromRevision = Number(url.searchParams.get("from"));
    const toValue = url.searchParams.get("to");
    const toRevision = toValue === null ? undefined : Number(toValue);
    if (
      !Number.isInteger(fromRevision)
      || fromRevision < 1
      || (toRevision !== undefined && (!Number.isInteger(toRevision) || toRevision < 1))
    ) {
      throw new DocumentServiceError("INVALID_INPUT", "from과 to 리비전 번호를 확인해주세요.");
    }
    return Response.json({
      diff: diffDocumentRevisions(
        sqlite,
        identity.workspaceId,
        documentId,
        fromRevision,
        toRevision,
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
