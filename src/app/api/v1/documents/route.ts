import { z } from "zod";
import { agentCreateDocumentSchema } from "@/lib/documents/schemas";
import { createDocument, queryDocuments } from "@/lib/documents/service";
import { DOCUMENT_WORKFLOW_STATUSES } from "@/lib/documents/types";
import { sqlite } from "@/lib/db/client";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenPermission,
  resolveTokenCreateParent,
  resolveTokenReadRoot,
  tokenDocumentActor,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  parentDocumentId: z.union([z.string().uuid(), z.literal("null")]).optional(),
  withinDocumentId: z.string().uuid().optional(),
  titlePrefix: z.string().max(200).optional(),
  documentType: z.string().max(80).optional(),
  workflowStatus: z.enum(DOCUMENT_WORKFLOW_STATUSES).optional(),
  tag: z.string().max(50).optional(),
  updatedAfter: z.string().datetime().optional(),
  updatedBefore: z.string().datetime().optional(),
  sort: z.enum(["tree", "updated_desc"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenPermission(identity, "documents:read", "documents.read");
    const url = new URL(request.url);
    const query = listQuerySchema.parse(Object.fromEntries(url.searchParams));
    return Response.json(queryDocuments(sqlite, identity.workspaceId, {
      ...query,
      parentDocumentId: query.parentDocumentId === "null" ? null : query.parentDocumentId,
      withinDocumentId: resolveTokenReadRoot(sqlite, identity, query.withinDocumentId),
    }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenPermission(identity, "documents:write", "documents.create");
    const body = agentCreateDocumentSchema.parse(await request.json());
    const parentDocumentId = resolveTokenCreateParent(sqlite, identity, body.parentDocumentId);
    const result = createDocument(
      sqlite,
      identity.workspaceId,
      tokenDocumentActor(identity, "api"),
      { ...body, parentDocumentId },
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
