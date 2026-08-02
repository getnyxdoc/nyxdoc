import { z } from "zod";
import { sqlite } from "@/lib/db/client";
import { markdownToNyxdocWithReport } from "@/lib/documents/markdown";
import { requestIdSchema } from "@/lib/documents/schemas";
import { createDocument } from "@/lib/documents/service";
import { DOCUMENT_WORKFLOW_STATUSES } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenScope,
  resolveTokenCreateParent,
  tokenDocumentActor,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const importSchema = z.object({
  requestId: requestIdSchema,
  title: z.string().min(1).max(200),
  markdown: z.string().min(1).max(300_000),
  parentDocumentId: z.string().uuid().nullable().optional(),
  documentType: z.string().trim().min(1).max(80).nullable().optional(),
  workflowStatus: z.enum(DOCUMENT_WORKFLOW_STATUSES).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  summary: z.string().min(1).max(300).optional(),
});

export async function POST(request: Request) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenScope(identity, "documents:write");
    const body = importSchema.parse(await request.json());
    const conversion = markdownToNyxdocWithReport(body.markdown, {
      idSeed: `${identity.id}:${body.requestId}`,
    });
    const result = createDocument(
      sqlite,
      identity.workspaceId,
      tokenDocumentActor(identity, "api"),
      {
        idempotencyOperation: "create_document_from_markdown",
        requestId: body.requestId,
        title: body.title,
        parentDocumentId: resolveTokenCreateParent(sqlite, identity, body.parentDocumentId),
        documentType: body.documentType,
        workflowStatus: body.workflowStatus,
        tags: body.tags,
        content: conversion.content,
        summary: body.summary,
      },
    );
    return Response.json({ ...result, conversionWarnings: conversion.warnings }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
