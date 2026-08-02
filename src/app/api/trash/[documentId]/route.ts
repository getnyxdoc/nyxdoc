import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { createDestructiveOperationBackup } from "@/lib/db/safety-backup";
import { humanDocumentActor } from "@/lib/documents/actors";
import { purgeTrashedDocument } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.purge");
    const { documentId } = await context.params;
    const backup = await createDestructiveOperationBackup();
    const result = purgeTrashedDocument(
      sqlite,
      workspace.id,
      humanDocumentActor(session.user),
      documentId,
    );
    return Response.json({ ...result, backupGenerationId: backup.manifest.generationId });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
