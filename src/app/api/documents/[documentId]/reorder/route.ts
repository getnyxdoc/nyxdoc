import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { reorderDocumentSchema } from "@/lib/documents/schemas";
import { listDocuments, reorderSiblingDocument } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.update");
    const { documentId } = await context.params;
    const body = reorderDocumentSchema.parse(await request.json());
    const result = reorderSiblingDocument(
      sqlite,
      workspace.id,
      { ...humanDocumentActor(session.user), source: "web" },
      documentId,
      body,
    );
    return Response.json({
      ...result,
      documents: listDocuments(sqlite, workspace.id),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
