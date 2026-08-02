import { z } from "zod";
import { requireWorkspaceSession } from "@/data/workspace-context";
import {
  AuthorizationError,
  requireHumanWorkspacePermission,
} from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { listDocuments } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";
import { listHumanGrantedDocuments } from "@/lib/sharing/access";
import {
  getWorkspaceNavigationPreference,
  NavigationPreferenceConflictError,
  saveWorkspaceNavigationPreference,
} from "@/lib/workspaces/navigation-preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateNavigationSchema = z.object({
  activeDocumentId: z.string().min(1).max(200),
  expandedDocumentIds: z.array(z.string().min(1).max(200)).max(2_000),
  expectedVersion: z.number().int().min(0),
});

function readableDocuments(input: {
  workspaceId: string;
  userId: string;
  accessSource: "membership" | "team" | "document_grant";
}) {
  if (input.accessSource !== "document_grant") {
    requireHumanWorkspacePermission(sqlite, input.workspaceId, input.userId, "documents.read");
    return listDocuments(sqlite, input.workspaceId);
  }
  return listHumanGrantedDocuments(sqlite, input.workspaceId, input.userId);
}

function requireReadableActiveDocument(
  documents: ReturnType<typeof listDocuments>,
  activeDocumentId: string,
) {
  if (!documents.some((document) => document.id === activeDocumentId)) {
    throw new AuthorizationError("NOT_FOUND", "Document not found.");
  }
}

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    const url = new URL(request.url);
    const activeDocumentId = z.string().min(1).max(200).parse(
      url.searchParams.get("activeDocumentId"),
    );
    const documents = readableDocuments({
      workspaceId: workspace.id,
      userId: session.user.id,
      accessSource: workspace.accessSource,
    });
    requireReadableActiveDocument(documents, activeDocumentId);
    const preference = getWorkspaceNavigationPreference(sqlite, {
      userId: session.user.id,
      workspaceId: workspace.id,
      documents,
      activeDocumentId,
    });
    return Response.json({ preference }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const body = updateNavigationSchema.parse(await request.json());
    const documents = readableDocuments({
      workspaceId: workspace.id,
      userId: session.user.id,
      accessSource: workspace.accessSource,
    });
    requireReadableActiveDocument(documents, body.activeDocumentId);
    const preference = saveWorkspaceNavigationPreference(sqlite, {
      userId: session.user.id,
      workspaceId: workspace.id,
      documents,
      expandedDocumentIds: body.expandedDocumentIds,
      activeDocumentId: body.activeDocumentId,
      expectedVersion: body.expectedVersion,
    });
    return Response.json({ preference }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof NavigationPreferenceConflictError) {
      return Response.json({
        error: "Workspace navigation changed in another session.",
        code: "NAVIGATION_CONFLICT",
        preference: error.current,
      }, {
        status: 409,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    return apiErrorResponse(error);
  }
}
