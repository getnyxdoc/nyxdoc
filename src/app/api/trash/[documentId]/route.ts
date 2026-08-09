import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { withDestructiveOperationBackup } from "@/lib/db/safety-backup";
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
    const actor = humanDocumentActor(session.user);
    const protectedOperation = await withDestructiveOperationBackup(() => sqlite.transaction(() => {
      requireHumanWorkspacePermission(
        sqlite,
        workspace.id,
        session.user.id,
        "documents.purge",
      );
      return purgeTrashedDocument(
        sqlite,
        workspace.id,
        actor,
        documentId,
      );
    }).immediate());
    if (protectedOperation.warnings.length > 0) {
      console.warn("[nyxdoc] document purge completed with backup barrier warnings", {
        workspaceId: workspace.id,
        documentId,
        warnings: protectedOperation.warnings,
      });
    }
    return Response.json({
      ...protectedOperation.result,
      backupGenerationId: protectedOperation.backup.manifest.generationId,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
