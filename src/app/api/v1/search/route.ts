import { z } from "zod";
import { sqlite } from "@/lib/db/client";
import { listDocuments, searchDocumentContents } from "@/lib/documents/service";
import { DOCUMENT_WORKFLOW_STATUSES } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import { requireTokenScope, resolveTokenReadRoot } from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  matchLimit: z.coerce.number().int().min(1).max(10).optional(),
  withinDocumentId: z.string().uuid().optional(),
  updatedAfter: z.string().datetime().optional(),
  updatedBefore: z.string().datetime().optional(),
  titleOnly: z.enum(["true", "false"]).optional(),
  documentType: z.string().max(80).optional(),
  workflowStatus: z.enum(DOCUMENT_WORKFLOW_STATUSES).optional(),
  tag: z.string().max(50).optional(),
});

export async function GET(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenScope(identity, "documents:read");
    const url = new URL(request.url);
    const query = searchQuerySchema.parse(Object.fromEntries(url.searchParams));
    const limit = query.limit ?? 20;
    const matchLimit = query.matchLimit ?? 5;
    const withinDocumentId = resolveTokenReadRoot(
      sqlite,
      identity,
      query.withinDocumentId,
    );
    const results = searchDocumentContents(sqlite, identity.workspaceId, query.q, {
      limit,
      matchLimit,
      withinDocumentId,
      updatedAfter: query.updatedAfter,
      updatedBefore: query.updatedBefore,
      titleOnly: query.titleOnly === "true",
      documentType: query.documentType,
      workflowStatus: query.workflowStatus,
      tag: query.tag,
    });
    const summaries = new Map(listDocuments(sqlite, identity.workspaceId).map((document) => [document.id, document]));
    return Response.json({
      results,
      documents: results.flatMap((result) => {
        const document = summaries.get(result.documentId);
        return document ? [document] : [];
      }),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
