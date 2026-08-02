import { sqlite } from "@/lib/db/client";
import { getDocumentBacklinks } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenDocumentAccess,
  requireTokenScope,
  tokenCanAccessDocument,
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
    const backlinks = getDocumentBacklinks(sqlite, identity.workspaceId, documentId)
      .filter((backlink) => tokenCanAccessDocument(sqlite, identity, backlink.document.id));
    return Response.json({ documentId, backlinks });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
