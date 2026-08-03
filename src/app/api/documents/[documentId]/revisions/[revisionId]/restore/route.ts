import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { resetWorkingDocument } from "@/lib/collaboration/gateway";
import { sqlite } from "@/lib/db/client";
import { humanDocumentActor } from "@/lib/documents/actors";
import { restoreDocumentRevisionSchema } from "@/lib/documents/schemas";
import { getDocumentRevisionSnapshot } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string; revisionId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    const { documentId, revisionId } = await context.params;
    requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      documentId,
      session.user.id,
      "revisions.restore",
    );
    const body = restoreDocumentRevisionSchema.parse(await request.json());
    getDocumentRevisionSnapshot(sqlite, workspace.id, documentId, revisionId);
    const actor = { ...humanDocumentActor(session.user), source: "rollback" as const };
    return Response.json(await resetWorkingDocument({
      workspaceId: workspace.id,
      documentId,
      revisionId,
      expectedGeneration: body.expectedGeneration,
      expectedDraftVersion: body.expectedDraftVersion,
      expectedBaseRevision: body.baseRevision,
      actor,
    }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
