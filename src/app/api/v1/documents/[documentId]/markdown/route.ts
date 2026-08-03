import { z } from "zod";
import { ensureCollaborationState } from "@/lib/collaboration/drafts";
import { replaceWorkingDocumentThroughGateway } from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { markdownToNyxdocWithReport } from "@/lib/documents/markdown";
import { requestIdSchema } from "@/lib/documents/schemas";
import { DOCUMENT_WORKFLOW_STATUSES } from "@/lib/documents/types";
import { apiErrorResponse } from "@/lib/http/errors";
import { authenticateRequestApiToken } from "@/lib/tokens/request";
import {
  requireTokenDocumentAccess,
  requireTokenParentAccess,
  requireTokenPermission,
  tokenDocumentActor,
} from "@/lib/tokens/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateMarkdownSchema = z.object({
  requestId: requestIdSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  markdown: z.string().min(1).max(300_000),
  title: z.string().min(1).max(200).optional(),
  parentDocumentId: z.string().uuid().nullable().optional(),
  documentType: z.string().trim().min(1).max(80).nullable().optional(),
  workflowStatus: z.enum(DOCUMENT_WORKFLOW_STATUSES).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
}).strict();

export async function PUT(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const identity = authenticateRequestApiToken(sqlite, request);
    requireTokenPermission(identity, "documents:write", "documents.update");
    const { documentId } = await context.params;
    requireTokenDocumentAccess(sqlite, identity, documentId);
    const body = updateMarkdownSchema.parse(await request.json());
    requireTokenParentAccess(sqlite, identity, body.parentDocumentId);
    const conversion = markdownToNyxdocWithReport(body.markdown, {
      idSeed: `${identity.id}:${body.requestId}`,
    });
    const state = ensureCollaborationState(sqlite, identity.workspaceId, documentId);
    const result = await replaceWorkingDocumentThroughGateway({
      roomName: state.roomName,
      actor: tokenDocumentActor(identity, "api"),
      requestId: body.requestId,
      expectedDraftVersion: body.expectedDraftVersion,
      replacement: {
        title: body.title,
        parentDocumentId: body.parentDocumentId,
        documentType: body.documentType,
        workflowStatus: body.workflowStatus,
        tags: body.tags,
        content: conversion.content,
      },
    });
    return Response.json({ ...result, conversionWarnings: conversion.warnings });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
