import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanDocumentPermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { getDocumentRevisionSnapshot } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string; revisionId: string }> },
) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    const { documentId, revisionId } = await context.params;
    requireHumanDocumentPermission(
      sqlite,
      workspace.id,
      documentId,
      session.user.id,
      "revisions.read",
    );
    return Response.json({
      revision: getDocumentRevisionSnapshot(
        sqlite,
        workspace.id,
        documentId,
        revisionId,
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
