import { z } from "zod";
import { sqlite } from "@/lib/db/client";
import { batchGetDocuments } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import { requireTokenDocumentAccess, requireTokenPermission } from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const batchReadSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(50),
});

export async function POST(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenPermission(identity, "documents:read", "documents.read");
    const { documentIds } = batchReadSchema.parse(await request.json());
    documentIds.forEach((documentId) => requireTokenDocumentAccess(sqlite, identity, documentId));
    return Response.json(batchGetDocuments(sqlite, identity.workspaceId, documentIds));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
