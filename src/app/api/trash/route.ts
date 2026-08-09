import { requireWorkspaceSession } from "@/data/workspace-context";
import { requireHumanWorkspacePermission } from "@/lib/authz/permissions";
import { sqlite } from "@/lib/db/client";
import { withDestructiveOperationBackup } from "@/lib/db/safety-backup";
import { humanDocumentActor } from "@/lib/documents/actors";
import { listTrashBatches, purgeTrashedDocument } from "@/lib/documents/service";
import { apiErrorResponse } from "@/lib/http/errors";
import { assertSameOrigin } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.read");
    return Response.json(
      { trash: listTrashBatches(sqlite, workspace.id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const { session, workspace } = await requireWorkspaceSession(request);
    requireHumanWorkspacePermission(sqlite, workspace.id, session.user.id, "documents.purge");
    const batches = listTrashBatches(sqlite, workspace.id);
    if (batches.length === 0) return Response.json({ documentCount: 0, results: [] });
    const actor = humanDocumentActor(session.user);
    const protectedOperation = await withDestructiveOperationBackup((backup) => ({
      backupGenerationId: backup.manifest.generationId,
      results: sqlite.transaction(() => {
        requireHumanWorkspacePermission(
          sqlite,
          workspace.id,
          session.user.id,
          "documents.purge",
        );
        return batches.map((batch) => purgeTrashedDocument(
          sqlite,
          workspace.id,
          actor,
          batch.rootDocumentId,
        ));
      }).immediate(),
    }));
    const { backupGenerationId, results } = protectedOperation.result;
    if (protectedOperation.warnings.length > 0) {
      console.warn("[nyxdoc] trash purge completed with backup barrier warnings", {
        workspaceId: workspace.id,
        warnings: protectedOperation.warnings,
      });
    }
    return Response.json({
      documentCount: results.reduce((total, result) => total + result.documentCount, 0),
      results,
      backupGenerationId,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
