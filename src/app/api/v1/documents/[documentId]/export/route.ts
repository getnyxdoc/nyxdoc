import { sqlite } from "@/lib/db/client";
import { exportDocumentMarkdown, exportNyxdocBundle } from "@/lib/documents/portability";
import { DocumentServiceError } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenDocumentAccess,
  requireTokenScope,
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
    const format = new URL(request.url).searchParams.get("format") || "nyxdoc_json";
    if (format !== "markdown" && format !== "nyxdoc_json") {
      throw new DocumentServiceError("INVALID_INPUT", "format은 markdown 또는 nyxdoc_json이어야 합니다.");
    }
    const exported = format === "markdown"
      ? exportDocumentMarkdown(sqlite, identity.workspaceId, documentId)
      : exportNyxdocBundle(sqlite, identity.workspaceId, documentId);
    return Response.json(exported);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
